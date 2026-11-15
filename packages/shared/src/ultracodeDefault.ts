/**
 * Ultracode by default. One rule decides whether a Claude Code chat that never
 * set its own Ultracode toggle starts with it on. The server applies it when a
 * turn starts and the composer uses it for the chip, so both name the same
 * state. The result is never written into a thread's saved model selection.
 *
 * @module ultracodeDefault
 */
import {
  type ClaudeUltracodeDefault,
  type ClaudeWorkflowMode,
  isProjectCoordinatorThreadId,
  type ServerProvider,
} from "@specweave-studio/contracts";

import { isPersonalAssistantProject } from "./personalAssistant.ts";
import { isClaudeApiKeyProvider } from "./providerFallback.ts";
import { isLiveWindow, windowAppliesToModel } from "./usageWindows.ts";

/** The default stops applying at this share of a Claude session or weekly limit. */
export const ULTRACODE_DEFAULT_PAUSE_PERCENT = 80;

/**
 * What a chat is, for the default. A thread is a chat a person starts in a
 * project, or a worker a coordinator starts or delegates. A nested subagent is
 * a task delegated by a chat that is not a coordinator.
 */
export type UltracodeChatKind = "thread" | "coordinator" | "routine" | "nested-subagent";

/** What the default gives a chat with no toggle of its own. */
export type UltracodeDefaultState = "on" | "off" | "paused";

export type UltracodeDefaultReason =
  | "workflows-disabled"
  | "default-off"
  | "chat-kind"
  | "api-key"
  | "usage"
  | "default";

export interface UltracodeDefaultResolution {
  readonly state: UltracodeDefaultState;
  readonly reason: UltracodeDefaultReason;
}

/** The stored mode Automatic is On request plus the default "all". */
export function effectiveClaudeWorkflowMode(
  mode: ClaudeWorkflowMode | undefined,
): "disabled" | "on-request" {
  return mode === "disabled" ? "disabled" : "on-request";
}

/** The default in force: a stored Automatic mode always means every chat. */
export function effectiveClaudeUltracodeDefault(
  mode: ClaudeWorkflowMode | undefined,
  stored: ClaudeUltracodeDefault | undefined,
): ClaudeUltracodeDefault {
  if (mode === "automatic") return "all";
  return stored ?? "threads";
}

export interface UltracodeChatKindInput {
  readonly threadId: string;
  readonly project:
    | {
        readonly id: string;
        readonly kind?: string | undefined;
        readonly workspaceSettings?:
          | {
              readonly coordinatorThreadId?: string | null | undefined;
              readonly kind?: string | undefined;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
  readonly lineage?:
    | {
        readonly parentThreadId: string | null;
        readonly relationshipToParent: "fork" | "subagent" | null;
      }
    | null
    | undefined;
  /** The chat belongs to a routine (a scheduled task runs in it). */
  readonly routine: boolean;
}

/** Classify a chat. A coordinator's delegated worker is a thread; a thread's own subagent is not. */
export function ultracodeChatKind(input: UltracodeChatKindInput): UltracodeChatKind {
  const { project, lineage } = input;
  const coordinatorProject = project
    ? { id: project.id, workspaceSettings: project.workspaceSettings ?? undefined }
    : null;
  const subagent = lineage?.relationshipToParent === "subagent";
  if (coordinatorProject && isProjectCoordinatorThreadId(input.threadId, coordinatorProject)) {
    return "coordinator";
  }
  if (subagent) {
    return coordinatorProject &&
      isProjectCoordinatorThreadId(lineage?.parentThreadId, coordinatorProject)
      ? "thread"
      : "nested-subagent";
  }
  // Every chat a person holds with the personal assistant is the assistant itself.
  if (project && isPersonalAssistantProject(project)) return "coordinator";
  return input.routine ? "routine" : "thread";
}

export interface UltracodeDefaultInput {
  /** The project's resolved Claude workflow mode. */
  readonly workflowMode: ClaudeWorkflowMode | undefined;
  /** The project's resolved "Ultracode by default" value. */
  readonly ultracodeDefault: ClaudeUltracodeDefault | undefined;
  readonly chatKind: UltracodeChatKind;
  /** The Claude instance bills an API key instead of a subscription. */
  readonly apiKeyBilling: boolean;
  /** Claude's session or weekly usage is at or above the pause share. */
  readonly usagePaused: boolean;
}

/**
 * What the default gives a chat that left its toggle unset, on a model that
 * offers Ultracode. Workflows Disabled and the default Off come first, then
 * the chat kind, then API-key billing, then high usage.
 */
export function resolveUltracodeDefault(input: UltracodeDefaultInput): UltracodeDefaultResolution {
  if (input.workflowMode === "disabled") return { state: "off", reason: "workflows-disabled" };
  const scope = effectiveClaudeUltracodeDefault(input.workflowMode, input.ultracodeDefault);
  if (scope === "off") return { state: "off", reason: "default-off" };
  if (scope === "threads" && input.chatKind !== "thread") {
    return { state: "off", reason: "chat-kind" };
  }
  if (input.apiKeyBilling) return { state: "off", reason: "api-key" };
  if (input.usagePaused) return { state: "paused", reason: "usage" };
  return { state: "on", reason: "default" };
}

type UsageProvider = Pick<ServerProvider, "usageLimits">;

/**
 * Whether Claude's session or weekly usage is high enough to pause the
 * default. Only live windows that cap `model` count, so the pause ends at the
 * reset and a spent Fable weekly never pauses Opus. Unknown usage never pauses.
 */
export function claudeUsagePausesUltracodeDefault(
  provider: UsageProvider | undefined,
  nowMs: number,
  model: string | null | undefined,
): boolean {
  return (provider?.usageLimits?.windows ?? []).some(
    (window) =>
      (window.kind === "session" || window.kind === "weekly") &&
      window.usedPercent >= ULTRACODE_DEFAULT_PAUSE_PERCENT &&
      isLiveWindow(window, nowMs) &&
      windowAppliesToModel(window, model),
  );
}

export interface UltracodeDefaultForChatInput {
  readonly workflowMode: ClaudeWorkflowMode | undefined;
  readonly ultracodeDefault: ClaudeUltracodeDefault | undefined;
  readonly chatKind: UltracodeChatKind;
  /** The chat's provider instance as its machine reports it; unknown reads as a subscription with no usage. */
  readonly provider: ServerProvider | undefined;
  readonly model: string | null | undefined;
  readonly nowMs: number;
}

/** The default for one chat, read from its provider instance's sign-in and usage. */
export function ultracodeDefaultForChat(
  input: UltracodeDefaultForChatInput,
): UltracodeDefaultResolution {
  return resolveUltracodeDefault({
    workflowMode: input.workflowMode,
    ultracodeDefault: input.ultracodeDefault,
    chatKind: input.chatKind,
    apiKeyBilling: isClaudeApiKeyProvider(input.provider),
    usagePaused: claudeUsagePausesUltracodeDefault(input.provider, input.nowMs, input.model),
  });
}

export interface UltracodeInput {
  readonly workflowMode: ClaudeWorkflowMode | undefined;
  /** The chat's own Ultracode toggle; undefined when it never chose. */
  readonly toggle: boolean | undefined;
  /** The model lists an Ultracode toggle. */
  readonly modelOffersUltracode: boolean;
  /** What the default gives this chat; undefined reads as off. */
  readonly defaultState: UltracodeDefaultState | undefined;
}

export interface UltracodeResolution {
  /** Ultracode reaches Claude Code for this chat. */
  readonly enabled: boolean;
  /** The default would be on, and is held back by high usage. */
  readonly paused: boolean;
  readonly source: "workflows-disabled" | "toggle" | "unsupported" | "default";
}

/**
 * Whether a chat runs with Ultracode: Workflows Disabled turns it off
 * everywhere, then the chat's own toggle wins, then a model without the toggle
 * gets nothing, then the default decides.
 */
export function resolveUltracode(input: UltracodeInput): UltracodeResolution {
  if (input.workflowMode === "disabled") {
    return { enabled: false, paused: false, source: "workflows-disabled" };
  }
  if (input.toggle !== undefined) {
    return { enabled: input.toggle, paused: false, source: "toggle" };
  }
  if (!input.modelOffersUltracode) {
    return { enabled: false, paused: false, source: "unsupported" };
  }
  return {
    enabled: input.defaultState === "on",
    paused: input.defaultState === "paused",
    source: "default",
  };
}
