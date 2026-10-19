import type { RunError } from "@cursor/sdk";
import {
  ProviderSetupError,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderFailureClass,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";

import { ConfigurationError, CursorSdkError, RateLimitError } from "../../provider/cursorSdk.ts";
import { makeProviderFailure, redactProviderFailureText } from "../ProviderFailure.ts";

/**
 * Cursor's usage and rate-limit error codes. The SDK reports them as the
 * backend enum name (`FREE_USER_USAGE_LIMIT`) or the lowercase Connect status
 * (`resource_exhausted`), so matching ignores case and an `ERROR_` prefix.
 */
const CURSOR_USAGE_LIMIT_CODES = new Set([
  "resource_exhausted",
  "free_user_usage_limit",
  "pro_user_usage_limit",
  "free_user_rate_limit_exceeded",
  "pro_user_rate_limit_exceeded",
  "usage_pricing_required",
  "usage_pricing_required_changeable",
  "rate_limited",
  "rate_limited_changeable",
  "generic_rate_limit_exceeded",
  "api_key_rate_limit",
]);

/** Weekly pool, prepaid credit and usage-based pricing stops carry no stable code everywhere. */
const CURSOR_USAGE_LIMIT_MESSAGE =
  /usage limit|weekly (?:usage|pool)|buy credits|prepaid credit|usage.?based pricing|out of credits/iu;

/**
 * Codes that mean this account can't use the chosen model. The SDK raises most as
 * ConfigurationError, but MODEL_NO_LONGER_SUPPORTED arrives as UnknownAgentError.
 */
const CURSOR_MODEL_CONFIGURATION_CODES = new Set([
  "bad_model_name",
  "model_blocked",
  "deprecated",
  "model_no_longer_supported",
]);

/** The SDK's own catalog check throws this without a code. */
const CURSOR_MODEL_CONFIGURATION_MESSAGE = /^Cannot use this model:/u;

function normalizedCode(code: string | undefined): string | undefined {
  return code
    ?.trim()
    .toLowerCase()
    .replace(/^error_/u, "");
}

export function isCursorUsageLimitCode(code: string | undefined): boolean {
  const normalized = normalizedCode(code);
  return normalized !== undefined && CURSOR_USAGE_LIMIT_CODES.has(normalized);
}

/** Walks Effect causes and `.cause` links; Cursor runner errors wrap the thrown SDK error. */
function findInCauseChain<A>(
  cause: unknown,
  refine: (value: unknown) => value is A,
): A | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  for (let depth = 0; depth < 16 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    try {
      if (Cause.isCause(current)) {
        current = Cause.squash(current);
        continue;
      }
      if (refine(current)) return current;
      current =
        typeof current === "object" ? (current as { readonly cause?: unknown }).cause : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const isCursorSdkError = (value: unknown): value is InstanceType<typeof CursorSdkError> =>
  value instanceof CursorSdkError;

export function cursorSdkErrorInCause(
  cause: unknown,
): InstanceType<typeof CursorSdkError> | undefined {
  return findInCauseChain(cause, isCursorSdkError);
}

/**
 * Cursor's weekly pool, plan limits and credit stops become `usage_limit` so
 * the limit banner, usage-limit recovery and provider fallback run.
 */
export function cursorFailureClass(
  input: { readonly cause?: unknown; readonly code?: string; readonly message?: string },
  fallback: OrchestrationV2ProviderFailureClass,
): OrchestrationV2ProviderFailureClass {
  const sdkError = cursorSdkErrorInCause(input.cause);
  // A plan-gated model can mention credit or usage pricing; it is a model
  // problem, so only codes classify a ConfigurationError.
  const messageCanClassify = !(sdkError instanceof ConfigurationError);
  const usageLimit =
    sdkError instanceof RateLimitError ||
    isCursorUsageLimitCode(input.code ?? sdkError?.code) ||
    (messageCanClassify &&
      CURSOR_USAGE_LIMIT_MESSAGE.test(input.message ?? sdkError?.message ?? ""));
  return usageLimit ? "usage_limit" : fallback;
}

/** A run that ended with status `error`: Cursor's own text, redacted by makeProviderFailure. */
export function cursorRunErrorFailure(error: RunError | undefined): OrchestrationV2ProviderFailure {
  return makeProviderFailure({
    cause: error,
    message: error?.message,
    code: error?.code,
    class: cursorFailureClass(
      {
        ...(error?.code === undefined ? {} : { code: error.code }),
        ...(error?.message === undefined ? {} : { message: error.message }),
      },
      "provider_error",
    ),
  });
}

/** A run whose wait threw: keep the SDK error's message, code and retryable flag. */
export function cursorThrownFailure(cause: unknown): OrchestrationV2ProviderFailure {
  const sdkError = cursorSdkErrorInCause(cause);
  return makeProviderFailure({
    cause,
    ...(sdkError === undefined
      ? {}
      : { message: sdkError.message, code: sdkError.code, retryable: sdkError.isRetryable }),
    class: cursorFailureClass({ cause }, "transport_error"),
  });
}

export function cursorModelUnavailableDetail(model: string): string {
  return `Cursor can't use model "${model}" on this account. Pick another model; Auto or a Composer or Grok model works on every Cursor plan.`;
}

export const CURSOR_TURN_START_USAGE_LIMIT_DETAIL =
  "Cursor stopped this turn at a usage or rate limit. Wait for the limit to reset, add credit in Cursor, or switch to another provider.";

function cursorUsageLimitDetail(sdkError: InstanceType<typeof CursorSdkError> | undefined): string {
  const text = redactProviderFailureText(sdkError?.message ?? "")
    .trim()
    .slice(0, 500);
  return text.length === 0
    ? CURSOR_TURN_START_USAGE_LIMIT_DETAIL
    : `${CURSOR_TURN_START_USAGE_LIMIT_DETAIL} Cursor said: ${text}`;
}

function isCursorModelConfigurationError(value: unknown): boolean {
  if (!(value instanceof CursorSdkError)) return false;
  const code = normalizedCode(value.code);
  if (code !== undefined) return CURSOR_MODEL_CONFIGURATION_CODES.has(code);
  return (
    value instanceof ConfigurationError && CURSOR_MODEL_CONFIGURATION_MESSAGE.test(value.message)
  );
}

/**
 * Turn-start failures retrying cannot fix get Studio's own setup text: a
 * plan-gated or retired model names the model, and a usage stop stays typed
 * as a usage limit with Cursor's own text. Anything else passes through.
 */
export function cursorTurnStartCause(
  cause: unknown,
  input: { readonly instanceId: ProviderInstanceId; readonly model: string },
): unknown {
  const sdkError = cursorSdkErrorInCause(cause);
  if (isCursorModelConfigurationError(sdkError)) {
    return new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "model",
      detail: cursorModelUnavailableDetail(input.model),
      cause,
    });
  }
  if (cursorFailureClass({ cause }, "provider_error") === "usage_limit") {
    return new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "session",
      detail: cursorUsageLimitDetail(sdkError),
      usageLimit: {},
      cause,
    });
  }
  return cause;
}
