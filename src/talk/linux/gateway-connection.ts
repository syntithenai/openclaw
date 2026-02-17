/**
 * GatewayConnection - server-side wrapper for talk mode to interact with the gateway
 * This provides an API similar to a client but operates directly within the gateway server process.
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.js";
import { dispatchInboundMessageWithDispatcher } from "../../auto-reply/dispatch.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

export interface ChatSendOptions {
  sessionKey: string;
  message: string;
  thinking?: "off" | "low" | "high";
  idempotencyKey?: string;
  attachments?: unknown[];
}

export interface ChatHistoryResponse {
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
    timestamp?: number;
  }>;
}

/**
 * Server-side gateway connection for talk mode.
 * Unlike a WebSocket client, this operates directly within the gateway process.
 */
export class GatewayConnection {
  private static instance: GatewayConnection | null = null;

  static get shared(): GatewayConnection {
    if (!GatewayConnection.instance) {
      GatewayConnection.instance = new GatewayConnection();
    }
    return GatewayConnection.instance;
  }

  async mainSessionKey(): Promise<string> {
    const cfg = loadConfig();
    return resolveMainSessionKey(cfg);
  }

  async chatSend(options: ChatSendOptions): Promise<void> {
    const cfg = loadConfig();
    const runId = options.idempotencyKey ?? randomUUID();

    // Build context using internal channel to avoid outbound delivery attempts
    const ctx = {
      cfg,
      Body: options.message,
      From: "internal:talk-mode-user",
      To: "internal:talk-mode-user",
      SessionKey: options.sessionKey,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      ChatType: "direct", // Specify direct message (not group)
      MessageSid: runId, // Unique message identifier
      timestamp: Date.now(),
      attachments: options.attachments ?? [],
      DisableTtsTool: true,
    };

    // Dispatch through the standard inbound message pipeline
    await dispatchInboundMessageWithDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async () => {
          // Talk mode doesn't need to deliver responses via a channel
          // The response is read back from the session transcript
        },
      },
      replyOptions: {
        runId,
      },
    });
  }

  async chatHistory(sessionKey: string): Promise<ChatHistoryResponse> {
    const cfg = loadConfig();
    const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const sessionId = store[sessionKey]?.sessionId ?? sessionKey;

    const messages = readSessionMessages(sessionId, storePath);

    return {
      messages: messages as Array<{
        role: string;
        content: Array<{ type: string; text?: string }>;
        timestamp?: number;
      }>,
    };
  }
}
