import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMessageGroup } from "./chat/grouped-render.ts";
import { registerAppMountHooks } from "./test-helpers/app-mount.ts";
import type { MessageGroup } from "./types/chat-types.ts";

registerAppMountHooks();

describe("chat mermaid rendering", () => {
  it("renders a mermaid chart element from assistant tag blocks", async () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "Here is the flow:",
            "<mermaidchart>",
            "flowchart TD",
            "A[Start] --> B[Done]",
            "</mermaidchart>",
          ].join("\n"),
        },
      ],
      timestamp: Date.now(),
    };

    const group: MessageGroup = {
      kind: "group",
      key: "g1",
      role: "assistant",
      messages: [{ key: "m1", message }],
      timestamp: Date.now(),
      isStreaming: false,
    };

    const container = document.createElement("div");
    render(
      renderMessageGroup(group, {
        showReasoning: false,
        assistantName: "Assistant",
        assistantAvatar: null,
      }),
      container,
    );

    const chartNode = container.querySelector(".chat-text oc-mermaid-chart");
    expect(chartNode).not.toBeNull();
    expect(chartNode?.source).toContain("flowchart TD");
  });
});
