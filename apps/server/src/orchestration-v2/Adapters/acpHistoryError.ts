import type { OrchestrationV2ProviderFailure } from "@specweave-studio/contracts";
import { ORCHESTRATION_V2_NATIVE_HISTORY_INVALID_FAILURE_CODE } from "@specweave-studio/contracts";

import { makeProviderFailure } from "../ProviderFailure.ts";

/**
 * Gemini 3+ rejects a request whose restored history has a `functionCall`
 * part without its thought signature. Some agents (Gemini CLI) rebuild a
 * loaded session's history from their own recording and drop those
 * signatures, so every later prompt on that native session fails the same
 * way until the session is discarded. The API wording, as surfaced through
 * ACP prompt errors:
 *
 * "Function call is missing a thought_signature in functionCall parts. This
 * is required for tools to work correctly, and missing thought_signature
 * may lead to degraded model performance. ..."
 */
export function isMissingThoughtSignatureError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("thought_signature") || text.includes("thoughtsignature")) &&
    (text.includes("missing") || text.includes("required"))
  );
}

/**
 * The run failure for such a prompt error: a short actionable notice with
 * the native-history-invalid code, so the next turn retires the poisoned
 * native session and continues in a fresh one with a context handoff
 * instead of replaying the raw API text and failing identically forever.
 * Null for any other error.
 */
export function missingThoughtSignatureFailure(
  message: string,
): OrchestrationV2ProviderFailure | null {
  if (!isMissingThoughtSignatureError(message)) return null;
  return makeProviderFailure({
    message:
      "The provider could not restore this conversation's earlier tool calls, so the saved session was retired. Send the message again to continue in a fresh session with the conversation handed over.",
    code: ORCHESTRATION_V2_NATIVE_HISTORY_INVALID_FAILURE_CODE,
    class: "provider_error",
  });
}
