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
  ORCHESTRATION_V2_WORKSPACE_BRANCH_MISSING_FAILURE_CODE,
  ORCHESTRATION_V2_WORKSPACE_MISSING_FAILURE_CODE,
  ProjectEnvironmentError,
} from "@specweave-studio/contracts";
import {
  LOCAL_STORAGE_FAILURE_CODE,
  LOCAL_STORAGE_FAILURE_MESSAGE,
  PREVIOUS_TURN_ACTIVE_FAILURE_CODE,
  PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE,
  providerFailureFallbackMessage,
  unwrapProviderErrorMessage,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import type { IdAllocatorV2Shape } from "./IdAllocator.ts";
import { ContextHandoffBudgetError } from "./ContextHandoffDelivery.ts";
import { providerSetupFailure } from "./ProviderAdapter.ts";

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

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
  if (
    failure.code === ORCHESTRATION_V2_WORKSPACE_BRANCH_MISSING_FAILURE_CODE ||
    failure.code === ORCHESTRATION_V2_WORKSPACE_MISSING_FAILURE_CODE
  )
    return true;
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
export function providerFailureDiagnostics(input: unknown): {
  readonly errorTags: ReadonlyArray<string>;
  readonly errorCode?: string;
} {
  let cause = input;
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
  // The classified cause stands in for detail text, which names internal ids.
  errorCode ??= classifiedFailureCode(input);
  return { errorTags, ...(errorCode === undefined ? {} : { errorCode }) };
}

const STORAGE_ERROR_TAGS: ReadonlySet<string> = new Set([
  "PersistenceSqlError",
  "EventStoreAppendEventsError",
]);
const STORAGE_ERROR_CODE =
  /^(?:ENOSPC|EDQUOT|SQLITE_(?:FULL|CANTOPEN|IOERR|READONLY|CORRUPT|NOTADB))/u;
const STORAGE_ERROR_TEXT =
  /\bSQLITE\(\d+\)|\bSQLITE_(?:FULL|CANTOPEN|IOERR)|\bENOSPC\b|no space left on device/iu;

/**
 * Whether a cause chain says SpecWithCode could not write its own state: a
 * SQL or event store failure, a full disk, or a database SQLite could not
 * open. Such a turn failed locally, not in the provider.
 */
export function isLocalStorageFailure(error: unknown): boolean {
  let storage = false;
  walkCauses(error, (cause) => {
    const tag = stringField(cause, "_tag");
    const code = stringField(cause, "code");
    if (
      (tag !== undefined && STORAGE_ERROR_TAGS.has(tag)) ||
      (code !== undefined && STORAGE_ERROR_CODE.test(code)) ||
      STORAGE_ERROR_TEXT.test(
        typeof cause === "string" ? cause : (stringField(cause, "message") ?? ""),
      )
    ) {
      storage = true;
      return "stop";
    }
  });
  return storage;
}

// Claude, Cursor and ACP all word it this way (see their startTurn guards).
const PREVIOUS_TURN_ACTIVE_DETAIL = /provider turn (\S+) is still active\.?$/u;

/**
 * When a start failed because the provider is still running an earlier turn
 * on this session: that turn's id, or null when the error does not name it.
 * Undefined for any other failure.
 */
export function previousActiveProviderTurn(error: unknown): ProviderTurnId | null | undefined {
  let found: ProviderTurnId | null | undefined;
  walkCauses(error, (cause) => {
    if (stringField(cause, "_tag") !== "ProviderAdapterProtocolError") return;
    const named = previousTurnActivePayload(cause);
    const match = PREVIOUS_TURN_ACTIVE_DETAIL.exec(stringField(cause, "detail") ?? "");
    if (named === undefined && match === null) return;
    found = (named ?? match?.[1] ?? null) as ProviderTurnId | null;
    return "stop";
  });
  return found;
}

function previousTurnActivePayload(cause: unknown): string | undefined {
  try {
    const payload = (cause as { readonly payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const previous = (payload as { readonly previousTurnActive?: unknown }).previousTurnActive;
    if (typeof previous !== "object" || previous === null) return undefined;
    const id = (previous as { readonly providerTurnId?: unknown }).providerTurnId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export const isPreviousTurnActiveFailure = (error: unknown): boolean =>
  previousActiveProviderTurn(error) !== undefined;

/** The stable code of a failure SpecWithCode recognizes in the cause chain itself. */
function classifiedFailureCode(error: unknown): string | undefined {
  if (isPreviousTurnActiveFailure(error)) return PREVIOUS_TURN_ACTIVE_FAILURE_CODE;
  if (isLocalStorageFailure(error)) return LOCAL_STORAGE_FAILURE_CODE;
  return undefined;
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
        case "ProviderAdapterProtocolError":
          if (isPreviousTurnActiveFailure(cause)) return PREVIOUS_TURN_ACTIVE_FAILURE_MESSAGE;
          break;
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

// Session and adapter wrappers name internal ids (provider-session:…, run and
// thread ids); makeProviderFailure translates them into curated guidance.
const INTERNAL_ID_WRAPPER_TAGS: ReadonlySet<string> = new Set([
  "ProviderSessionOpenError",
  "ProviderAdapterOpenSessionError",
  "ProviderAdapterCloseSessionError",
  "ProviderAdapterResumeThreadError",
  "ProviderAdapterEnsureThreadError",
  "ProviderAdapterReadThreadSnapshotError",
  "ProviderAdapterRollbackThreadError",
  "ProviderAdapterForkThreadError",
  "ProviderAdapterTurnStartError",
  "ProviderAdapterSteerRunUnsupportedError",
  "ProviderAdapterSteerRunError",
  "ProviderAdapterInterruptError",
  "ProviderAdapterRuntimeRequestResponseError",
  "ProviderAdapterEventStreamError",
]);

// Causes whose text causeMessage rebuilds from a closed set instead of reading it.
const CURATED_CAUSE_TAGS: ReadonlySet<string> = new Set([
  "ProjectEnvironmentError",
  "ContextHandoffBudgetError",
  "ContextHandoffDeliveryUncertainError",
]);

// Errors whose message is deliberate, user-facing text; their raw cause (fetch,
// JSON or fs errors that may name local paths) is never shown in its place.
const REASON_BEARING_TAGS: ReadonlySet<string> = new Set([
  "AcpRegistryError",
  "AcpRegistryOperationError",
  "ProviderSetupError",
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
]);

/** Studio's own id forms (IdAllocator), such as `provider-session:…` or `run:thread:…`. */
const INTERNAL_ID_PATTERN =
  /(?:^|[^\w-])(?:provider-session|provider-thread|provider-turn|run-attempt|run|thread|turn-item):[\w-]/u;

const MAX_CAUSE_DEPTH = 16;

/** Walks a cause chain, squashing Effect Causes, bounded and cycle-safe; stops on a throw. */
function walkCauses(error: unknown, visit: (cause: unknown) => "stop" | void): void {
  const seen = new Set<unknown>();
  let cause = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (visit(cause) === "stop" || typeof cause !== "object") return;
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      return;
    }
  }
}

const readableReason = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed && !INTERNAL_ID_PATTERN.test(trimmed) ? trimmed : undefined;
};

/**
 * The innermost readable reason in a start failure's cause chain: a plain
 * string or an error message that names no internal ids, skipping the
 * session and adapter wrappers. A reason-bearing error ends the walk with its
 * own text. Undefined when only wrappers speak, or when a curated cause should
 * be translated by makeProviderFailure instead.
 */
export function innermostCauseMessage(error: unknown): string | undefined {
  let message: string | undefined;
  walkCauses(error, (cause) => {
    if (typeof cause === "string") {
      message = readableReason(cause) ?? message;
      return "stop";
    }
    const tag = stringField(cause, "_tag");
    if (tag !== undefined && CURATED_CAUSE_TAGS.has(tag)) {
      message = undefined;
      return "stop";
    }
    if (tag !== undefined && REASON_BEARING_TAGS.has(tag)) {
      message = readableReason(stringField(cause, "message")) ?? message;
      return "stop";
    }
    if (tag === undefined || !INTERNAL_ID_WRAPPER_TAGS.has(tag)) {
      message = readableReason(stringField(cause, "message")) ?? message;
    }
  });
  return message;
}

/** The innermost string `code` in a cause chain, so a wrapped typed error keeps its own. */
function causeCode(error: unknown): string | undefined {
  let code: string | undefined;
  walkCauses(error, (cause) => {
    const candidate = stringField(cause, "code");
    if (candidate !== undefined && candidate.trim().length > 0) code = candidate;
  });
  return code;
}

function stringField(
  value: unknown,
  key: "_tag" | "message" | "code" | "detail",
): string | undefined {
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
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
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
  const classifiedCode = classifiedFailureCode(input.cause);
  const rawMessage =
    input.message ??
    (classifiedCode === LOCAL_STORAGE_FAILURE_CODE ? LOCAL_STORAGE_FAILURE_MESSAGE : undefined) ??
    causeMessage(input.cause) ??
    fallbackMessage;
  const message = boundedText(
    unwrapProviderErrorMessage(rawMessage),
    MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  );
  const rawCode =
    input.code ??
    (setup?.unavailable && failureClass !== "usage_limit"
      ? ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE
      : undefined) ??
    classifiedCode ??
    causeCode(input.cause) ??
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
