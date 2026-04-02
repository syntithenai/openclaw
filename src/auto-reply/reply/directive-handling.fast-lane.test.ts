import { describe, expect, it, vi } from "vitest";
import { applyInlineDirectivesFastLane } from "./directive-handling.fast-lane.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

type FastLaneArgs = Parameters<typeof applyInlineDirectivesFastLane>[0];

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentId: vi.fn(() => "main"),
}));

vi.mock("./directive-handling.impl.js", () => ({
  handleDirectiveOnly: vi.fn(async () => undefined),
}));

vi.mock("./directive-handling.levels.js", () => ({
  resolveCurrentDirectiveLevels: vi.fn(async () => ({
    currentThinkLevel: undefined,
    currentVerboseLevel: undefined,
    currentReasoningLevel: undefined,
    currentElevatedLevel: undefined,
  })),
}));

describe("applyInlineDirectivesFastLane one-shot model", () => {
  it("applies inline /model selection to current turn without relying on session override", async () => {
    const directives = parseInlineDirectives("/model openai/gpt-4o what is the time");
    const sessionEntry: Record<string, unknown> = {};
    const sessionStore = { "agent:main:dm:1": sessionEntry };

    const result = await applyInlineDirectivesFastLane({
      cfg: { commands: { text: true }, agents: { defaults: {} } } as unknown as FastLaneArgs["cfg"],
      directives,
      sessionEntry: sessionEntry as unknown as FastLaneArgs["sessionEntry"],
      sessionStore: sessionStore as unknown as FastLaneArgs["sessionStore"],
      sessionKey: "agent:main:dm:1",
      storePath: undefined,
      elevatedEnabled: true,
      elevatedAllowed: true,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
      aliasIndex: { byAlias: new Map(), byKey: new Map() },
      allowedModelKeys: new Set(["openai/gpt-4o", "anthropic/claude-opus-4-5"]),
      allowedModelCatalog: [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      ] as unknown as FastLaneArgs["allowedModelCatalog"],
      resetModelOverride: false,
      provider: "anthropic",
      model: "claude-opus-4-5",
      initialModelLabel: "anthropic/claude-opus-4-5",
      formatModelSwitchEvent: (label: string) => `switched ${label}`,
      commandAuthorized: true,
      ctx: {} as unknown as FastLaneArgs["ctx"],
      agentId: "main",
      isGroup: false,
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
        allowedModelKeys: new Set(),
        allowedModelCatalog: [] as unknown as FastLaneArgs["modelState"]["allowedModelCatalog"],
        resetModelOverride: false,
      },
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
  });
});
