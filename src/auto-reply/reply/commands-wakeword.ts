import { logVerbose } from "../../globals.js";
import {
  getVoiceWakeStatus,
  hasLinuxTalkRuntime,
  setVoiceWakeMode,
} from "../../talk/linux/gateway-integration.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedWakewordCommand = {
  action: "on" | "off" | "status" | "help";
};

function parseWakewordCommand(normalized: string): ParsedWakewordCommand | null {
  if (normalized === "/wakeword") {
    return { action: "status" };
  }
  if (!normalized.startsWith("/wakeword ")) {
    return null;
  }
  const rest = normalized.slice(10).trim();
  if (!rest) {
    return { action: "status" };
  }
  const action = rest.split(/\s+/)[0]?.toLowerCase();
  if (action === "on" || action === "off" || action === "status" || action === "help") {
    return { action };
  }
  return { action: "help" };
}

function wakewordUsage(): ReplyPayload {
  return {
    text:
      `🔊 **Voice Wake Help**\n\n` +
      `**Commands:**\n` +
      `• /wakeword on — Enable voice wake listening\n` +
      `• /wakeword off — Disable voice wake listening\n` +
      `• /wakeword status — Show voice wake status\n` +
      `• /wakeword help — Show this help\n`,
  };
}

export const handleWakewordCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseWakewordCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /wakeword command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!hasLinuxTalkRuntime()) {
    return {
      shouldContinue: false,
      reply: {
        text:
          "⚠️ Linux talk runtime is not initialized. Start the gateway on Linux with audio access to enable voice wake.",
      },
    };
  }

  if (parsed.action === "help") {
    return { shouldContinue: false, reply: wakewordUsage() };
  }

  if (parsed.action === "status") {
    const status = getVoiceWakeStatus();
    if (!status.ok || !status.status) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Voice wake status unavailable: ${status.error ?? "unknown"}` },
      };
    }
    const { enabled, words, listenerActive } = status.status;
    return {
      shouldContinue: false,
      reply: {
        text:
          `🔊 Voice wake status\n` +
          `Enabled: ${enabled ? "✅" : "❌"}\n` +
          `Listener active: ${listenerActive ? "✅" : "❌"}\n` +
          `Wake words: ${words || "(none configured)"}`,
      },
    };
  }

  const enable = parsed.action === "on";
  const result = await setVoiceWakeMode(enable);
  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Unable to ${enable ? "enable" : "disable"} voice wake: ${result.error}` },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: enable ? "🔊 Voice wake enabled." : "🛑 Voice wake disabled." },
  };
};
