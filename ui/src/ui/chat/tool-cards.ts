import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, getTruncatedPreview } from "./tool-helpers.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const lifecycleErrorDetail = resolveLifecyclePayloadError(card);
  const detail = lifecycleErrorDetail ?? formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const expandableLabel = hasText ? resolveExpandableLabel(display.name) : null;
  const showExpandableOutput = Boolean(expandableLabel);
  const isLifecyclePayloadError = lifecycleErrorDetail !== null;
  const cardLabel = isLifecyclePayloadError ? "Error" : display.label;

  const canClick = Boolean(onOpenSidebar) && !showExpandableOutput;
  const handleClick = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort && !showExpandableOutput;
  const showInline = hasText && isShort && !showExpandableOutput;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""} ${isLifecyclePayloadError ? "chat-tool-card--error" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${cardLabel}</span>
        </div>
        ${
          canClick
            ? html`<span class="chat-tool-card__action">${hasText ? "View" : ""} ${icons.check}</span>`
            : nothing
        }
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isEmpty
          ? html`
              <div class="chat-tool-card__status-text muted">Completed</div>
            `
          : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${
        showExpandableOutput
          ? html`
              <details class="chat-tool-card__details">
                <summary class="chat-tool-card__summary">
                  <span>${expandableLabel}</span>
                  <span class="chat-tool-card__summary-meta">${card.text!.length} chars</span>
                </summary>
                <div class="chat-tool-card__output mono">${card.text}</div>
              </details>
            `
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

function resolveExpandableLabel(name: string): string | null {
  const normalized = name.toLowerCase().replace(/[.-]/g, "_");
  if (normalized === "exec") {
    return "result";
  }
  if (
    normalized === "web_fetch" ||
    normalized === "fetch_webpage" ||
    normalized === "web_search" ||
    normalized === "search_web"
  ) {
    return "content";
  }
  return null;
}

function resolveLifecyclePayloadError(card: ToolCard): string | null {
  const normalizedName = card.name.toLowerCase().replace(/[.-]/g, "_");
  if (normalizedName !== "lifecycle") {
    return null;
  }

  const args = card.args;
  if (!args || typeof args !== "object") {
    return card.text?.trim() ?? null;
  }

  const data = args as Record<string, unknown>;
  const phase = typeof data.phase === "string" ? data.phase.toLowerCase() : "";
  const errorText =
    (typeof data.error === "string" && data.error.trim()) ||
    (typeof data.reason === "string" && data.reason.trim()) ||
    null;

  if (phase === "error") {
    return errorText ?? card.text?.trim() ?? "Lifecycle error";
  }

  return errorText;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return undefined;
}
