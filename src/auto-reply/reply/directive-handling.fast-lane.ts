import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ReplyPayload } from "../types.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { resolveCurrentDirectiveLevels } from "./directive-handling.levels.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model.js";
import type { ApplyInlineDirectivesFastLaneParams } from "./directive-handling.params.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import { isDirectiveOnly } from "./directive-handling.parse.js";

export async function applyInlineDirectivesFastLane(
  params: ApplyInlineDirectivesFastLaneParams,
): Promise<{ directiveAck?: ReplyPayload; provider: string; model: string }> {
  const {
    directives,
    commandAuthorized,
    ctx,
    cfg,
    agentId,
    isGroup,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    formatModelSwitchEvent,
    modelState,
  } = params;

  let { provider, model } = params;
  if (
    !commandAuthorized ||
    isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    })
  ) {
    return { directiveAck: undefined, provider, model };
  }

  const agentCfg = params.agentCfg;
  const { currentThinkLevel, currentVerboseLevel, currentReasoningLevel, currentElevatedLevel } =
    await resolveCurrentDirectiveLevels({
      sessionEntry,
      agentCfg,
      resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
    });

  const directivesForAck = directives.hasModelDirective
    ? parseInlineDirectives(directives.cleaned)
    : directives;

  const directiveAck = await handleDirectiveOnly({
    cfg,
    directives: directivesForAck,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    messageProviderKey,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    provider,
    model,
    initialModelLabel: params.initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  });

  // For mixed messages, treat /model as one-shot: apply to this turn only.
  if (directives.hasModelDirective && directives.rawModelDirective) {
    const activeAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
    const agentDir = resolveAgentDir(cfg, activeAgentId);
    const resolved = resolveModelSelectionFromDirective({
      directives,
      cfg,
      agentDir,
      defaultProvider,
      defaultModel,
      aliasIndex,
      allowedModelKeys,
      allowedModelCatalog,
      provider,
    });
    if (!resolved.errorText && resolved.modelSelection) {
      provider = resolved.modelSelection.provider;
      model = resolved.modelSelection.model;
    }
  } else {
    if (sessionEntry?.providerOverride) {
      provider = sessionEntry.providerOverride;
    }
    if (sessionEntry?.modelOverride) {
      model = sessionEntry.modelOverride;
    }
  }

  return { directiveAck, provider, model };
}
