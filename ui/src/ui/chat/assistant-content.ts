export type AssistantContentSegment =
  | {
      type: "markdown";
      text: string;
    }
  | {
      type: "mermaid";
      text: string;
    };

const chartTagPattern =
  /<(?:mermaidchart|pyramidchart)>([\s\S]*?)<\/(?:mermaidchart|pyramidchart)>/gi;

function looksLikeMermaidSource(raw: string): boolean {
  const text = String(raw ?? "").trim();
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  if (lower.includes("<mermaidchart>") || lower.includes("<pyramidchart>")) {
    return true;
  }
  if (lower.includes("%%{init")) {
    return true;
  }
  const keywordHits = [
    /\bflowchart\b/i,
    /\bgraph\s+(td|lr|rl|bt)\b/i,
    /\bsequencediagram\b/i,
    /\bclassdiagram\b/i,
    /\bstatediagram(?:-v2)?\b/i,
    /\berdiagram\b/i,
    /\bjourney\b/i,
    /\bgantt\b/i,
    /\bpie\b/i,
    /\bxychart(?:-beta)?\b/i,
    /\bmindmap\b/i,
    /\btimeline\b/i,
    /\bquadrantchart\b/i,
    /\bbar\b/i,
  ].reduce((acc, pattern) => acc + (pattern.test(text) ? 1 : 0), 0);
  const tokenHit = /(-->|-\.->|==>|:::|\bx-?axis\b|\by-?axis\b|\btitle\b)/i.test(text);
  return keywordHits >= 2 || (keywordHits >= 1 && tokenHit);
}

export function splitAssistantContent(raw: string): AssistantContentSegment[] {
  const input = String(raw ?? "");
  if (!input.trim()) {
    return [];
  }

  if (looksLikeMermaidSource(input) && !chartTagPattern.test(input)) {
    chartTagPattern.lastIndex = 0;
    return [{ type: "mermaid", text: input.trim() }];
  }

  chartTagPattern.lastIndex = 0;

  const parts: AssistantContentSegment[] = [];
  let cursor = 0;

  while (true) {
    const match = chartTagPattern.exec(input);
    if (!match) {
      break;
    }

    if (match.index > cursor) {
      const markdown = input.slice(cursor, match.index);
      if (markdown.trim()) {
        parts.push({ type: "markdown", text: markdown });
      }
    }

    const chart = String(match[1] ?? "").trim();
    if (chart) {
      parts.push({ type: "mermaid", text: chart });
    }

    cursor = match.index + match[0].length;
  }

  if (cursor < input.length) {
    const trailing = input.slice(cursor);
    if (trailing.trim()) {
      parts.push({ type: "markdown", text: trailing });
    }
  }

  if (parts.length === 0 && looksLikeMermaidSource(input)) {
    parts.push({ type: "mermaid", text: input.trim() });
  }

  return parts;
}
