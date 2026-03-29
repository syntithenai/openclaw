import { onAgentEvent } from "../../infra/agent-events.js";

const AGENT_RUN_CACHE_TTL_MS = 10 * 60_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while auth/model
 * failover is still in progress. Give errors a short grace window so a
 * subsequent `start` event can cancel premature terminal snapshots.
 */
const AGENT_RUN_ERROR_RETRY_GRACE_MS = 15_000;
const AGENT_RUN_POST_RETRY_STALL_MS = 20_000;
const RETRY_STALL_SUFFIX = "Retry restarted but no terminal lifecycle event was received.";

const agentRunCache = new Map<string, AgentRunSnapshot>();
const agentRunStarts = new Map<string, number>();
const pendingAgentRunErrors = new Map<string, PendingAgentRunError>();
const pendingAgentRunRetryStalls = new Map<string, PendingAgentRunRetryStall>();
let agentRunListenerStarted = false;

type AgentRunSnapshot = {
  runId: string;
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  ts: number;
};

type PendingAgentRunError = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

type PendingAgentRunRetryStall = {
  snapshot: AgentRunSnapshot;
  dueAt: number;
  timer: NodeJS.Timeout;
};

function pruneAgentRunCache(now = Date.now()) {
  for (const [runId, entry] of agentRunCache) {
    if (now - entry.ts > AGENT_RUN_CACHE_TTL_MS) {
      agentRunCache.delete(runId);
    }
  }
}

function recordAgentRunSnapshot(entry: AgentRunSnapshot) {
  pruneAgentRunCache(entry.ts);
  agentRunCache.set(entry.runId, entry);
}

function clearPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunErrors.delete(runId);
}

function clearPendingAgentRunRetryStall(runId: string) {
  const pending = pendingAgentRunRetryStalls.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingAgentRunRetryStalls.delete(runId);
}

function schedulePendingAgentRunError(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunError(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_ERROR_RETRY_GRACE_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunErrors.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunErrors.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingAgentRunErrors.set(snapshot.runId, { snapshot, dueAt, timer });
}

function schedulePendingAgentRunRetryStall(snapshot: AgentRunSnapshot) {
  clearPendingAgentRunRetryStall(snapshot.runId);
  const dueAt = Date.now() + AGENT_RUN_POST_RETRY_STALL_MS;
  const timer = setTimeout(() => {
    const pending = pendingAgentRunRetryStalls.get(snapshot.runId);
    if (!pending) {
      return;
    }
    pendingAgentRunRetryStalls.delete(snapshot.runId);
    recordAgentRunSnapshot(pending.snapshot);
  }, AGENT_RUN_POST_RETRY_STALL_MS);
  timer.unref?.();
  pendingAgentRunRetryStalls.set(snapshot.runId, { snapshot, dueAt, timer });
}

function refreshPendingAgentRunRetryStall(runId: string) {
  const pending = pendingAgentRunRetryStalls.get(runId);
  if (!pending) {
    return;
  }
  schedulePendingAgentRunRetryStall({
    ...pending.snapshot,
    ts: Date.now(),
  });
}

function getPendingAgentRunError(runId: string) {
  const pending = pendingAgentRunErrors.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function getPendingAgentRunRetryStall(runId: string) {
  const pending = pendingAgentRunRetryStalls.get(runId);
  if (!pending) {
    return undefined;
  }
  return {
    snapshot: pending.snapshot,
    dueAt: pending.dueAt,
  };
}

function createSnapshotFromLifecycleEvent(params: {
  runId: string;
  phase: "end" | "error";
  data?: Record<string, unknown>;
}): AgentRunSnapshot {
  const { runId, phase, data } = params;
  const startedAt =
    typeof data?.startedAt === "number" ? data.startedAt : agentRunStarts.get(runId);
  const endedAt = typeof data?.endedAt === "number" ? data.endedAt : undefined;
  const error = typeof data?.error === "string" ? data.error : undefined;
  return {
    runId,
    status: phase === "error" ? "error" : data?.aborted ? "timeout" : "ok",
    startedAt,
    endedAt,
    error,
    ts: Date.now(),
  };
}

function ensureAgentRunListener() {
  if (agentRunListenerStarted) {
    return;
  }
  agentRunListenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt) {
      return;
    }
    if (pendingAgentRunRetryStalls.has(evt.runId) && evt.stream !== "lifecycle") {
      refreshPendingAgentRunRetryStall(evt.runId);
    }
    if (evt.stream !== "lifecycle") {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const pendingError = getPendingAgentRunError(evt.runId);
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      agentRunStarts.set(evt.runId, startedAt ?? Date.now());
      clearPendingAgentRunError(evt.runId);
      if (pendingError) {
        const baseError = pendingError.snapshot.error?.trim() ?? "";
        const composedError = baseError ? `${baseError} ${RETRY_STALL_SUFFIX}` : RETRY_STALL_SUFFIX;
        schedulePendingAgentRunRetryStall({
          runId: evt.runId,
          status: "error",
          startedAt,
          error: composedError,
          ts: Date.now(),
        });
      }
      // A new start means this run is active again (or retried). Drop stale
      // terminal snapshots so waiters don't resolve from old state.
      agentRunCache.delete(evt.runId);
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const snapshot = createSnapshotFromLifecycleEvent({
      runId: evt.runId,
      phase,
      data: evt.data,
    });
    agentRunStarts.delete(evt.runId);
    clearPendingAgentRunRetryStall(evt.runId);
    if (phase === "error") {
      schedulePendingAgentRunError(snapshot);
      return;
    }
    clearPendingAgentRunError(evt.runId);
    recordAgentRunSnapshot(snapshot);
  });
}

function getCachedAgentRun(runId: string) {
  pruneAgentRunCache();
  return agentRunCache.get(runId);
}

export async function waitForAgentJob(params: {
  runId: string;
  timeoutMs: number;
}): Promise<AgentRunSnapshot | null> {
  const { runId, timeoutMs } = params;
  ensureAgentRunListener();
  const cached = getCachedAgentRun(runId);
  if (cached) {
    return cached;
  }
  if (timeoutMs <= 0) {
    return null;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let pendingErrorTimer: NodeJS.Timeout | undefined;
    let pendingRetryStallTimer: NodeJS.Timeout | undefined;

    const clearPendingErrorTimer = () => {
      if (!pendingErrorTimer) {
        return;
      }
      clearTimeout(pendingErrorTimer);
      pendingErrorTimer = undefined;
    };

    const clearPendingRetryStallTimer = () => {
      if (!pendingRetryStallTimer) {
        return;
      }
      clearTimeout(pendingRetryStallTimer);
      pendingRetryStallTimer = undefined;
    };

    const finish = (entry: AgentRunSnapshot | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearPendingErrorTimer();
      clearPendingRetryStallTimer();
      unsubscribe();
      resolve(entry);
    };

    const scheduleErrorFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_ERROR_RETRY_GRACE_MS,
    ) => {
      clearPendingErrorTimer();
      const effectiveDelay = Math.max(1, Math.min(Math.floor(delayMs), 2_147_483_647));
      pendingErrorTimer = setTimeout(() => {
        const latest = getCachedAgentRun(runId);
        if (latest) {
          finish(latest);
          return;
        }
        recordAgentRunSnapshot(snapshot);
        finish(snapshot);
      }, effectiveDelay);
      pendingErrorTimer.unref?.();
    };

    const scheduleRetryStallFinish = (
      snapshot: AgentRunSnapshot,
      delayMs = AGENT_RUN_POST_RETRY_STALL_MS,
    ) => {
      clearPendingRetryStallTimer();
      const effectiveDelay = Math.max(1, Math.min(Math.floor(delayMs), 2_147_483_647));
      pendingRetryStallTimer = setTimeout(() => {
        const latest = getCachedAgentRun(runId);
        if (latest) {
          finish(latest);
          return;
        }
        recordAgentRunSnapshot(snapshot);
        finish(snapshot);
      }, effectiveDelay);
      pendingRetryStallTimer.unref?.();
    };

    const pending = getPendingAgentRunError(runId);
    if (pending) {
      scheduleErrorFinish(pending.snapshot, pending.dueAt - Date.now());
    }
    const pendingRetryStall = getPendingAgentRunRetryStall(runId);
    if (pendingRetryStall) {
      scheduleRetryStallFinish(pendingRetryStall.snapshot, pendingRetryStall.dueAt - Date.now());
    }

    const unsubscribe = onAgentEvent((evt) => {
      if (!evt) {
        return;
      }
      if (evt.runId !== runId) {
        return;
      }
      const pendingRetry = getPendingAgentRunRetryStall(runId);
      if (pendingRetry) {
        scheduleRetryStallFinish(pendingRetry.snapshot, pendingRetry.dueAt - Date.now());
      }
      if (evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      if (phase === "start") {
        clearPendingErrorTimer();
        const pendingRetryAfterStart = getPendingAgentRunRetryStall(runId);
        if (pendingRetryAfterStart) {
          scheduleRetryStallFinish(
            pendingRetryAfterStart.snapshot,
            pendingRetryAfterStart.dueAt - Date.now(),
          );
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      clearPendingRetryStallTimer();
      const latest = getCachedAgentRun(runId);
      if (latest) {
        finish(latest);
        return;
      }
      const snapshot = createSnapshotFromLifecycleEvent({
        runId: evt.runId,
        phase,
        data: evt.data,
      });
      if (phase === "error") {
        scheduleErrorFinish(snapshot);
        return;
      }
      recordAgentRunSnapshot(snapshot);
      finish(snapshot);
    });

    const timerDelayMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
    const timer = setTimeout(() => finish(null), timerDelayMs);
  });
}

ensureAgentRunListener();
