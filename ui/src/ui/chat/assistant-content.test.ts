import { describe, expect, it } from "vitest";
import { splitAssistantContent } from "./assistant-content.ts";

describe("splitAssistantContent", () => {
  it("returns markdown-only segment when no chart tags are present", () => {
    const parts = splitAssistantContent("Hello **world**");
    expect(parts).toEqual([{ type: "markdown", text: "Hello **world**" }]);
  });

  it("extracts mermaidchart blocks and preserves surrounding markdown", () => {
    const parts = splitAssistantContent(
      "Before\n<mermaidchart>flowchart TD\nA-->B</mermaidchart>\nAfter",
    );

    expect(parts).toEqual([
      { type: "markdown", text: "Before\n" },
      { type: "mermaid", text: "flowchart TD\nA-->B" },
      { type: "markdown", text: "\nAfter" },
    ]);
  });

  it("accepts pyramidchart alias tags", () => {
    const parts = splitAssistantContent('<pyramidchart>pie title Demo\n"A" : 1</pyramidchart>');
    expect(parts).toEqual([{ type: "mermaid", text: 'pie title Demo\n"A" : 1' }]);
  });

  it("falls back to raw mermaid parsing without tags", () => {
    const raw =
      "%% {init: {'theme':'default'}} %%\nbar\ntitle Population\nx-axis Countries\ny-axis Population\nIndia:1490\nChina:1430";
    const parts = splitAssistantContent(raw);
    expect(parts).toEqual([{ type: "mermaid", text: raw }]);
  });
});
