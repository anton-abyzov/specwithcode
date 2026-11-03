import type { OrchestrationV2Run, PromptSuggestionsMode } from "@specweave-studio/contracts";

import type { SessionPhase } from "../../types";

export interface ComposerGhostSuggestion {
  readonly runId: string;
  readonly text: string;
}

type SuggestionRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "promptSuggestion">;

/**
 * The suggested next prompt of the thread's newest run, offered only once that
 * run completed. An older run's suggestion never resurfaces after a newer run.
 */
export function latestRunPromptSuggestion(
  runs: ReadonlyArray<SuggestionRun>,
  mode: PromptSuggestionsMode = "all",
): ComposerGhostSuggestion | null {
  if (mode === "off") return null;
  let latest: SuggestionRun | null = null;
  for (const run of runs) {
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  if (latest === null || latest.status !== "completed") return null;
  const suggestion = latest.promptSuggestion;
  if (!suggestion) return null;
  // `native` keeps only what the provider sent with its reply.
  if (mode === "native" && suggestion.source !== "provider") return null;
  const text = suggestion.text.trim();
  return text.length === 0 ? null : { runId: latest.id, text };
}

export interface ComposerGhostSuggestionGate {
  readonly suggestion: ComposerGhostSuggestion | null;
  readonly dismissedRunId: string | null;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly isApprovalState: boolean;
  readonly hasPendingUserInput: boolean;
  readonly showPlanFollowUpPrompt: boolean;
  readonly environmentUnavailable: boolean;
  readonly projectSelectionRequired: boolean;
  readonly isEditingQueuedMessage: boolean;
  /** Text, images, files or chips in the draft. */
  readonly draftHasUserContent: boolean;
  readonly prompt: string;
}

/** The ghost only fills an idle, empty composer the user has not waved it off from. */
export function visibleComposerGhostSuggestion(
  gate: ComposerGhostSuggestionGate,
): ComposerGhostSuggestion | null {
  const { suggestion } = gate;
  if (suggestion === null || suggestion.runId === gate.dismissedRunId) return null;
  if (
    gate.phase !== "ready" ||
    gate.isSendBusy ||
    gate.isConnecting ||
    gate.isApprovalState ||
    gate.hasPendingUserInput ||
    gate.showPlanFollowUpPrompt ||
    gate.environmentUnavailable ||
    gate.projectSelectionRequired ||
    gate.isEditingQueuedMessage ||
    gate.draftHasUserContent ||
    gate.prompt !== ""
  ) {
    return null;
  }
  return suggestion;
}

export interface ComposerGhostSuggestionKey {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
}

/**
 * Plain Tab accepts a visible ghost and Escape dismisses it. Anything else,
 * including Shift+Tab, an open menu or a send shortcut, keeps its usual meaning.
 */
export function composerGhostSuggestionKeyAction(
  event: ComposerGhostSuggestionKey,
  context: { ghostVisible: boolean; menuIsActive: boolean; hasSubmissionIntent: boolean },
): "accept" | "dismiss" | null {
  if (!context.ghostVisible || context.menuIsActive || context.hasSubmissionIntent) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "Tab") return "accept";
  if (event.key === "Escape") return "dismiss";
  return null;
}
