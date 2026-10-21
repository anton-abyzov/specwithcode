import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  ProjectEnvironmentError,
} from "@specweave-studio/contracts";
import { providerFailureFallbackMessage } from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import type { IdAllocatorV2Shape } from "./IdAllocator.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import { providerSetupFailure } from "./ProviderAdapter.ts";

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

/** A run whose thread folder and branch were deleted; every provider fails it the same way. */
export const WORKSPACE_BRANCH_MISSING_FAILURE_CODE = "workspace_branch_missing";

/**
 * Whether a failed run should hold the thread's queued messages. A provider
 * that just failed will likely fail the next message too, so the user decides
 * when to resume. Validation failures (setup, unsupported handoff) belong to
 * that message alone, and a message queued for another provider is how users
 * recover. A deleted thread folder fails every message on every provider.
 */
export function shouldHoldQueueAfterFailure(input: {
  readonly failure: Pick<OrchestrationV2ProviderFailure, "class" | "code"> | undefined;
  readonly failedProviderInstanceId: string | null | undefined;
  readonly queuedProviderInstanceId: string | null | undefined;
}): boolean {
  const { failure } = input;
  if (failure === undefined) return false;
  if (failure.code === WORKSPACE_BRANCH_MISSING_FAILURE_CODE) return true;
  return (
    failure.class !== "validation_error" &&
    input.failedProviderInstanceId === input.queuedProviderInstanceId
  );
}

const isProjectEnvironmentCode = Schema.is(ProjectEnvironmentError.fields.code);

/** Reconstruct guidance from the closed code set, never trust a cause-provided message. */
function projectEnvironmentCode(
  cause: unknown,
): typeof ProjectEnvironmentError.fields.code.Type | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  try {
    const record = cause as Record<string, unknown>;
    return record._tag === "ProjectEnvironmentError" && isProjectEnvironmentCode(record.code)
      ? record.code
      : undefined;
  } catch {
    return undefined;
  }
}

const DIAGNOSTIC_ERROR_TAGS = new Set([
  "ProviderAdapterTurnStartError",
  "ProviderAdapterOpenSessionError",
  "ProviderAdapterEventStreamError",
  "ProviderAdapterProtocolError",
  "ProviderAdapterResumeThreadError",
  "ProviderSetupError",
  "ProjectEnvironmentError",
  "ContextHandoffBudgetError",
  "ContextHandoffDeliveryUncertainError",
  "AcpRequestError",
  "AcpSpawnError",
  "AcpTransportError",
  "SystemError",
]);

/** Local logs need the cause category, never raw prompts, paths, credentials or defect text. */
export function providerFailureDiagnostics(cause: unknown): {
  readonly errorTags: ReadonlyArray<string>;
  readonly errorCode?: string;
} {
  const errorTags: string[] = [],
    seen = new Set<unknown>();
  let errorCode: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const tag = (cause as Record<string, unknown>)._tag;
      errorTags.push(
        typeof tag === "string" && DIAGNOSTIC_ERROR_TAGS.has(tag) ? tag : "UnknownError",
      );
      const projectCode = projectEnvironmentCode(cause);
      if (projectCode !== undefined) errorCode = projectCode;
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return { errorTags, ...(errorCode === undefined ? {} : { errorCode }) };
}

/** Translate known categories without exposing arbitrary provider defect text. */
function causeMessage(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let message: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      switch ((cause as Record<string, unknown>)._tag) {
        case "ProjectEnvironmentError":
          const projectCode = projectEnvironmentCode(cause);
          if (projectCode !== undefined) {
            return projectCode === "unsupported_provider"
              ? "This provider cannot use additional project folders under the current permissions. For ACP, select Full access without a restrictive sandbox or approval override, use a provider that supports folder grants, or remove the extra folders in Project settings."
              : new ProjectEnvironmentError({
                  projectId: "diagnostic-project" as ProjectEnvironmentError["projectId"],
                  code: projectCode,
                }).message;
          }
          break;
        case "ContextHandoffBudgetError":
          return new ContextHandoffBudgetError().message;
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
          return stringField(cause, "message");
        // Setup details are Studio's own safe text (see ProviderSetupError) and
        // name the real reason, such as a native status check that timed out.
        case "ProviderSetupError":
          return stringField(cause, "detail") ?? message;
        case "ContextHandoffDeliveryUncertainError":
          return "SpecWithCode could not confirm whether conversation history reached the provider. Retry the turn to recover the session.";
        case "ProviderAdapterTurnStartError":
          message =
            "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";
          break;
        case "ProviderAdapterEventStreamError":
          message =
            "The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
        case "ProviderAdapterOpenSessionError":
          message =
            "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.";
          break;
        case "ProviderAdapterResumeThreadError":
          message =
            "The provider conversation could not be resumed. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return message;
}

function stringField(value: unknown, key: "message" | "code" | "detail"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

/**
 * Removes common credential forms before provider text crosses a transport
 * boundary. Cursor and xAI keys (`crsr_`, `grok_`, `xai_`, `xai-`) can appear bare; `grok-` is left alone because model ids use it.
 */
export function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replace(/\b(?:(?:grok|xai|crsr)_|xai-)[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const setup = providerSetupFailure(input.cause);
  const failureClass = setup?.usageLimit ? "usage_limit" : (input.class ?? "unknown");
  const resetAt = setup?.usageLimit?.resetAt ?? input.resetAt;
  // Without a message the class still says what kind of failure it was;
  // untranslated cause text stays in the server log.
  const fallbackMessage = providerFailureFallbackMessage(failureClass);
  const rawMessage = input.message ?? causeMessage(input.cause) ?? fallbackMessage;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode =
    input.code ??
    (setup?.unavailable && failureClass !== "usage_limit"
      ? ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE
      : undefined) ??
    stringField(input.cause, "code") ??
    null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: failureClass,
    message: message || fallbackMessage,
    code,
    retryable: input.retryable ?? null,
    ...(failureClass === "usage_limit" && resetAt != null && Number.isFinite(Date.parse(resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(resetAt)) }
      : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

export function makeProviderRetryTurnItem(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}

/** A stop with this message is not a real limit, even after the variable is unset. */
export const SIMULATED_USAGE_LIMIT_MESSAGE = "Simulated usage limit (STUDIO_SIMULATE_USAGE_LIMIT).";

/** The provider instance ids `STUDIO_SIMULATE_USAGE_LIMIT` lists, comma separated. */
export function simulatedUsageLimitInstances(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<string> {
  return (env.STUDIO_SIMULATE_USAGE_LIMIT ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * A usage-limit stop for testing the limit banner and the fallback switch
 * without spending a real allowance: `STUDIO_SIMULATE_USAGE_LIMIT` lists the
 * provider instance ids (comma separated) whose turns stop before they start.
 * Anything that costs the account (a banked reset, paid credits) stays off
 * while the variable is set at all, since the stop is not a real limit.
 */
export function simulatedUsageLimitFailure(
  instanceId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMs: number = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): OrchestrationV2ProviderFailure | null {
  if (!simulatedUsageLimitInstances(env).includes(instanceId)) return null;
  return makeProviderFailure({
    class: "usage_limit",
    code: "simulated_usage_limit",
    message: SIMULATED_USAGE_LIMIT_MESSAGE,
    retryable: false,
    resetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60 * 60 * 1000)),
  });
}
