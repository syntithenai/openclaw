const DEFAULT_PORT = 18792
const RETRY_INTERVAL = 3000 // Retry every 3 seconds
const RELAY_RECONNECT_INTERVAL = 5000 // Try to reconnect relay every 5 seconds

console.log('[OpenClaw Extension] Service worker started')

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** Retry timers */
let relayRetryTimer = null
let tabRetryTimer = null

/** @type {number|null} */
let desiredTabId = null

let desiredLockUntil = 0

/** @type {number|null} */
let attachInProgressTabId = null

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  console.log(`[OpenClaw Extension] Relay port: ${n || DEFAULT_PORT}`)
  return n || DEFAULT_PORT
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  const token = String(stored.gatewayToken || '').trim()
  if (!token) {
    console.warn('[OpenClaw Extension] Gateway token is missing!')
  } else {
    console.log('[OpenClaw Extension] Gateway token found (length: ' + token.length + ')')
  }
  return token || ''
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

function getConnectedTabId() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') return tabId
  }
  return null
}

function isAttachableUrl(url) {
  if (!url) return false
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return false
  return true
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForAttachableTab(tabId, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || !tab.id) return null
    if (isAttachableUrl(tab.url || '')) {
      if (tab.status !== 'loading') return tab
    }
    await sleep(200)
  }
  return null
}

async function attachDesiredTab(tabId, reason) {
  desiredTabId = tabId
  console.log(`[OpenClaw Extension] Attaching desired tab ${tabId} (${reason})`)
  await ensureRelayConnection()
  const tab = await waitForAttachableTab(tabId)
  if (!tab || !tab.id) {
    throw new Error(`Tab ${tabId} not attachable yet`)
  }
  return await attachTab(tabId)
}

function shouldUpdateDesiredTab(tabId, tab, source) {
  if (!tabId || !tab) return false
  const now = Date.now()
  if (tabId === desiredTabId) return true
  if (source === 'user') return true
  if (now < desiredLockUntil) return false
  if (tab.active) return true
  return desiredTabId === null
}

async function ensureRelayConnection() {
  console.log('[OpenClaw Extension] ensureRelayConnection called')
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    console.log('[OpenClaw Extension] Already connected to relay')
    return
  }
  if (relayConnectPromise) {
    console.log('[OpenClaw Extension] Relay connection already in progress')
    return await relayConnectPromise
  }

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const gatewayToken = await getGatewayToken()
    console.log(`[OpenClaw Extension] Connecting to relay at port ${port}`)
    
    const wsUrl = gatewayToken
      ? `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(gatewayToken)}`
      : `ws://127.0.0.1:${port}/extension`

    if (!gatewayToken) {
      throw new Error(
        'Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)',
      )
    }

    console.log('[OpenClaw Extension] Creating WebSocket connection')
    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        console.error('[OpenClaw Extension] WebSocket connect timeout')
        reject(new Error('WebSocket connect timeout'))
      }, 5000)
      ws.onopen = () => {
        console.log('[OpenClaw Extension] WebSocket connected')
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        console.error('[OpenClaw Extension] WebSocket error')
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        console.error(`[OpenClaw Extension] WebSocket closed (${ev.code})`)
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    console.log('[OpenClaw Extension] Setting up message handlers')
    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      console.log('[OpenClaw Extension] Installing debugger listeners')
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
    console.log('[OpenClaw Extension] Relay connection established')
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: reconnecting…',
    })
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()

  // Start retry loop to reconnect relay and re-attach tabs
  scheduleRelayRetry()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

/**
 * Schedule a retry to connect relay and re-attach tabs
 */
function scheduleRelayRetry() {
  if (relayRetryTimer) return
  relayRetryTimer = setTimeout(() => {
    relayRetryTimer = null
    void attemptRelayReconnect()
  }, RELAY_RECONNECT_INTERVAL)
}

/**
 * Attempt to reconnect relay and re-attach tabs
 */
async function attemptRelayReconnect() {
  try {
    console.log('[OpenClaw Extension] Attempting relay reconnect')
    await ensureRelayConnection()
    scheduleTabRetry()
  } catch (err) {
    // Relay still not available, schedule another retry
    console.log('[OpenClaw Extension] Relay reconnect failed, scheduling retry')
    scheduleRelayRetry()
  }
}

/**
 * Schedule a retry to connect tabs
 */
function scheduleTabRetry() {
  if (tabRetryTimer) return
  tabRetryTimer = setTimeout(() => {
    tabRetryTimer = null
    void attemptTabReconnect()
  }, RETRY_INTERVAL)
}

/**
 * Attempt to connect any disconnected tabs
 */
async function attemptTabReconnect() {
  try {
    // Only proceed if relay is connected
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
      console.log('[OpenClaw Extension] Relay not connected, scheduling relay retry')
      scheduleRelayRetry()
      return
    }

    const connectedTabId = getConnectedTabId()
    if (desiredTabId && connectedTabId && connectedTabId !== desiredTabId) {
      console.log(
        `[OpenClaw Extension] Switching from tab ${connectedTabId} to desired tab ${desiredTabId}`,
      )
      await detachTab(connectedTabId, 'switch-to-desired')
    }

    if (desiredTabId) {
      const desired = await chrome.tabs.get(desiredTabId).catch(() => null)
      if (!desired || !desired.id) {
        desiredTabId = null
      } else {
        const url = desired.url || ''
        if (!isAttachableUrl(url)) {
          console.log('[OpenClaw Extension] Desired tab is not attachable yet')
          scheduleTabRetry()
          return
        }

        const existing = tabs.get(desired.id)
        if (existing?.state === 'connected') {
          console.log('[OpenClaw Extension] Desired tab already connected')
          return
        }

        if (existing?.state === 'connecting') {
          scheduleTabRetry()
          return
        }

        try {
          console.log(`[OpenClaw Extension] Connecting desired tab ${desired.id}`)
          tabs.set(desired.id, { state: 'connecting' })
          setBadge(desired.id, 'connecting')
          await attachTab(desired.id)
          console.log(`[OpenClaw Extension] Successfully connected tab ${desired.id}`)
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.warn(`[OpenClaw Extension] Failed to attach tab ${desired.id}: ${message}`)
          tabs.delete(desired.id)
          scheduleTabRetry()
          return
        }
      }
    }

    const allTabs = await chrome.tabs.query({})
    for (const tab of allTabs) {
      if (!tab.id) continue
      const url = tab.url || ''
      if (!isAttachableUrl(url)) continue
      desiredTabId = tab.id
      console.log(`[OpenClaw Extension] Selected new desired tab ${tab.id}`)
      scheduleTabRetry()
      return
    }

    scheduleTabRetry()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[OpenClaw Extension] attemptTabReconnect error: ${message}`)
    scheduleTabRetry()
  }
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  console.log(`[OpenClaw Extension] attachTab called for tab ${tabId}`)
  if (desiredTabId && tabId !== desiredTabId && !opts.ignoreDesired) {
    throw new Error(`Tab ${tabId} is not the desired tab (${desiredTabId})`)
  }
  if (attachInProgressTabId && attachInProgressTabId !== tabId) {
    throw new Error(`Another attach is in progress for tab ${attachInProgressTabId}`)
  }
  attachInProgressTabId = tabId
  // Auto-detach any other connected tabs to enforce single-tab connection
  if (!opts.skipDetachOthers) {
    // Collect tabs to detach first (don't modify map while iterating)
    const tablesToDetach = []
    for (const [otherTabId, otherTab] of tabs.entries()) {
      if (otherTabId !== tabId && otherTab.state === 'connected') {
        tablesToDetach.push(otherTabId)
      }
    }
    
    // Now detach them
    for (const otherTabId of tablesToDetach) {
      console.log(`[OpenClaw Extension] Detaching other tab ${otherTabId} for single-tab mode`)
      await detachTab(otherTabId, 'single-tab-mode')
    }
  }

  try {
    const debuggee = { tabId }
    console.log(`[OpenClaw Extension] Attaching debugger to tab ${tabId}`)
    await chrome.debugger.attach(debuggee, '1.3')
    console.log(`[OpenClaw Extension] Debugger attached, enabling Page domain`)
    await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

    console.log(`[OpenClaw Extension] Getting target info for tab ${tabId}`)
    const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
    const targetInfo = info?.targetInfo
    const targetId = String(targetInfo?.targetId || '').trim()
    if (!targetId) {
      throw new Error('Target.getTargetInfo returned no targetId')
    }

    const sessionId = `cb-tab-${nextSession++}`
    const attachOrder = nextSession

    tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
    tabBySession.set(sessionId, tabId)
    console.log(`[OpenClaw Extension] Tab ${tabId} attached successfully with sessionId ${sessionId}`)
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: attached (click to detach)',
    })

    if (!opts.skipAttachedEvent) {
      console.log(`[OpenClaw Extension] Sending attachedToTarget event`)
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    }

    setBadge(tabId, 'on')

    if (desiredTabId && tabId !== desiredTabId) {
      await detachTab(tabId, 'stale-attach')
      throw new Error(`Attached stale tab ${tabId}, desired ${desiredTabId}`)
    }

    return { sessionId, targetId }
  } finally {
    if (attachInProgressTabId === tabId) attachInProgressTabId = null
  }
}

async function detachTab(tabId, reason) {
  console.log(`[OpenClaw Extension] Detaching tab ${tabId} (reason: ${reason})`)
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId) // Remove immediately to prevent state inconsistency
  console.log(`[OpenClaw Extension] Tab ${tabId} removed from tracking`)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
    // Start retry loop in case user wants to reconnect
    scheduleTabRetry()
    return
  }

  desiredTabId = tabId
  desiredLockUntil = 0
  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    // Connection failed, start retry loop
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: retrying connection…',
    })
    scheduleRelayRetry()
    scheduleTabRetry()
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: true })
    if (!tab.id) throw new Error('Failed to create tab')
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    desiredTabId = tab.id
    desiredLockUntil = Date.now() + 12000
    const attached = await attachDesiredTab(tab.id, 'Target.createTarget')
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
}

/**
 * Auto-connect to the first available tab
 */
async function autoConnectFirstTab() {
  console.log('[OpenClaw Extension] autoConnectFirstTab called')
  try {
    // Find the first valid (non-chrome) tab
    const allTabs = await chrome.tabs.query({})
    console.log(`[OpenClaw Extension] Found ${allTabs.length} tabs`)
    if (!allTabs.length) {
      console.log('[OpenClaw Extension] No tabs found, scheduling retry')
      scheduleTabRetry()
      return
    }

    // Find first tab that is attachable
    let firstTab = null
    for (const tab of allTabs) {
      const url = tab.url || ''
      if (isAttachableUrl(url)) {
        firstTab = tab
        break
      }
    }

    if (!firstTab) {
      console.log('[OpenClaw Extension] All tabs are chrome:// tabs, scheduling retry')
      scheduleTabRetry()
      return
    }

    console.log(`[OpenClaw Extension] First valid tab: ${firstTab.id}, URL: ${firstTab.url}`)
    if (!firstTab.id) {
      scheduleTabRetry()
      return
    }

    if (desiredTabId === null) {
      desiredTabId = firstTab.id
    }

    // Skip if already connected
    const existing = tabs.get(firstTab.id)
    if (existing?.state === 'connected') {
      console.log('[OpenClaw Extension] First tab already connected')
      return
    }

    console.log('[OpenClaw Extension] Attempting to connect first tab')
    tabs.set(firstTab.id, { state: 'connecting' })
    setBadge(firstTab.id, 'connecting')
    void chrome.action.setTitle({
      tabId: firstTab.id,
      title: 'OpenClaw Browser Relay: connecting to local relay…',
    })

    try {
      console.log('[OpenClaw Extension] Ensuring relay connection')
      await ensureRelayConnection()
      console.log('[OpenClaw Extension] Relay connected, attaching tab')
      await attachTab(firstTab.id)
      console.log('[OpenClaw Extension] Successfully connected first tab')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[OpenClaw Extension] Connection failed: ${message}`)
      throw err
    }
  } catch (err) {
    console.error('[OpenClaw Extension] Auto-connect failed:', err instanceof Error ? err.message : String(err))
    // Connection failed, start retry loops
    scheduleRelayRetry()
    scheduleTabRetry()
  }
}

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

/**
 * Auto-connect first tab when tab is activated (switched to)
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { tabId } = activeInfo
  if (!tabId) return

  try {
    const tab = await chrome.tabs.get(tabId)
    // Skip special chrome:// tabs
    if (!isAttachableUrl(tab.url || '')) {
      return
    }

    if (shouldUpdateDesiredTab(tabId, tab, 'active')) {
      desiredTabId = tabId
    }
    const existing = tabs.get(tabId)
    
    // Already connected, no action needed
    if (existing?.state === 'connected') return

    // Auto-connect to relay
    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: connecting to local relay…',
    })

    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    // Connection failed, start retry loops
    scheduleRelayRetry()
    scheduleTabRetry()
  }
})

/**
 * When new tab is created, try to connect it
 */
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.id) return
  console.log(`[OpenClaw Extension] New tab created: ${tab.id}, URL: ${tab.url}`)
  scheduleTabRetry()
})

/**
 * When a tab is updated (e.g., URL changes), try to connect if it became valid
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tabId || !tab.url) return
  
  // Only care about when URL changes
  if (!changeInfo.url) return
  
  console.log(`[OpenClaw Extension] Tab ${tabId} updated: ${tab.url}`)
  
  // Skip chrome:// and chrome-extension:// tabs
  if (!isAttachableUrl(tab.url)) {
    console.log(`[OpenClaw Extension] Tab ${tabId} is chrome:// tab, skipping`)
    return
  }

  if (!shouldUpdateDesiredTab(tabId, tab, 'update')) {
    return
  }

  desiredTabId = tabId

  // If this tab isn't already being tracked, try to connect it
  const existing = tabs.get(tabId)
  if (!existing) {
    console.log(`[OpenClaw Extension] Tab ${tabId} changed to valid URL`)
    // Ensure relay is connected and immediately attempt to connect this tab
    try {
      console.log(`[OpenClaw Extension] Ensuring relay connection for new tab`)
      await ensureRelayConnection()
      console.log(`[OpenClaw Extension] Relay connected, attempting to connect tab ${tabId}`)
      tabs.set(tabId, { state: 'connecting' })
      setBadge(tabId, 'connecting')
      await attachTab(tabId)
      console.log(`[OpenClaw Extension] Successfully connected tab ${tabId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[OpenClaw Extension] Failed to connect tab ${tabId}: ${message}`)
      tabs.delete(tabId)
      // Start retry loop
      scheduleRelayRetry()
      scheduleTabRetry()
    }
  }
})

/**
 * When a tab is closed, try to connect the next available tab
 */
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  console.log(`[OpenClaw Extension] Tab ${tabId} removed`)
  // If it was a connected tab, properly detach it and try to connect the next one
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    console.log(`[OpenClaw Extension] Removed tab was connected, cleaning up`)
    // Properly clean up the tab state to avoid orphaned mappings
    if (tab.sessionId) tabBySession.delete(tab.sessionId)
    for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
      if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
    }
    tabs.delete(tabId)
    
    if (desiredTabId === tabId) desiredTabId = null
    // Immediately try to connect the next available tab
    console.log(`[OpenClaw Extension] Attempting immediate reconnect after tab removal`)
    void attemptTabReconnect()
  } else {
    // Just remove the tab entry if it wasn't connected
    tabs.delete(tabId)
  }
})

chrome.runtime.onInstalled.addListener(() => {
  // Open options page for first-time setup
  void chrome.runtime.openOptionsPage()
  // Auto-connect first tab after a brief delay
  setTimeout(() => void autoConnectFirstTab(), 1000)
})

// When the service worker starts (e.g., after browser restart), auto-connect first tab
chrome.runtime.onStartup?.addListener(() => {
  setTimeout(() => void autoConnectFirstTab(), 500)
})

// Listen for settings updates from options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'settingsUpdated') {
    // Clear relay connection so next attempt will use new token
    if (relayWs) {
      relayWs.close()
      relayWs = null
    }
    relayConnectPromise = null
    sendResponse({ success: true })
    // Restart retry loops with new settings
    if (relayRetryTimer) clearTimeout(relayRetryTimer)
    if (tabRetryTimer) clearTimeout(tabRetryTimer)
    relayRetryTimer = null
    tabRetryTimer = null
    scheduleRelayRetry()
    scheduleTabRetry()
  }
})

// Initialize connection attempts when service worker starts
// This ensures auto-connect happens even if chrome.runtime.onInstalled doesn't fire
async function initializeAutoConnect() {
  console.log('[OpenClaw Extension] Initializing auto-connect')
  try {
    await autoConnectFirstTab()
    console.log('[OpenClaw Extension] Auto-connect attempt completed')
  } catch (err) {
    console.error('[OpenClaw Extension] Auto-connect error:', err)
  }
}

// Schedule initialization for when service worker is ready
setTimeout(() => {
  console.log('[OpenClaw Extension] Running scheduled initialization')
  void initializeAutoConnect()
}, 100)
