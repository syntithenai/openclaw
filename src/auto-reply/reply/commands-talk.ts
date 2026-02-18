import { logVerbose } from "../../globals.js";
import {
  getLinuxTalkStatus,
  hasLinuxTalkRuntime,
  setLinuxTalkMode,
} from "../../talk/linux/gateway-integration.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedTalkCommand = {
  action: "on" | "off" | "status" | "help";
};

function parseTalkCommand(normalized: string): ParsedTalkCommand | null {
  if (normalized === "/talk") {
    return { action: "status" };
  }
  if (!normalized.startsWith("/talk ")) {
    return null;
  }
  const rest = normalized.slice(6).trim();
  if (!rest) {
    return { action: "status" };
  }
  const action = rest.split(/\s+/)[0]?.toLowerCase();
  if (action === "on" || action === "off" || action === "status" || action === "help") {
    return { action };
  }
  return { action: "help" };
}

function talkUsage(): ReplyPayload {
  return {
    text:
      `🎙️ **Talk Mode Help**\n\n` +
      `**Commands:**\n` +
      `• /talk on — Enable Linux talk mode\n` +
      `• /talk off — Disable Linux talk mode\n` +
      `• /talk status — Show talk mode status\n` +
      `• /talk help — Show this help\n`,
  };
}

export const handleTalkCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTalkCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /talk command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!hasLinuxTalkRuntime()) {
    return {
      shouldContinue: false,
      reply: {
        text:
          "⚠️ Linux talk runtime is not initialized. Start the gateway on Linux with audio access to enable talk mode.",
      },
    };
  }

  if (parsed.action === "help") {
    return { shouldContinue: false, reply: talkUsage() };
  }

  if (parsed.action === "status") {
    const status = getLinuxTalkStatus();
    if (!status.ok || !status.status) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Talk status unavailable: ${status.error ?? "unknown"}` },
      };
    }
    const { enabled, paused, phase } = status.status;
    return {
      shouldContinue: false,
      reply: {
        text:
          `🎙️ Talk mode status\n` +
          `Enabled: ${enabled ? "✅" : "❌"}\n` +
          `Paused: ${paused ? "✅" : "❌"}\n` +
          `Phase: ${phase}`,
      },
    };
  }

  const enable = parsed.action === "on";
  const result = await setLinuxTalkMode(enable);
  if (!result.ok) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Unable to ${enable ? "enable" : "disable"} talk mode: ${result.error}` },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: enable ? "🎙️ Talk mode enabled." : "🛑 Talk mode disabled." },
  };
};
