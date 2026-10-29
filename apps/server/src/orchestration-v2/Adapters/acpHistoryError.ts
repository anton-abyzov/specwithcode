import type { OrchestrationV2ProviderFailure } from "@specweave-studio/contracts";
import { ORCHESTRATION_V2_NATIVE_HISTORY_INVALID_FAILURE_CODE } from "@specweave-studio/contracts";

import { makeProviderFailure } from "../ProviderFailure.ts";

/**
 * Gemini rejects a request whose restored history no longer has a shape the
 * API accepts. Some agents (Gemini CLI) rebuild a loaded session's history
 * from their own recording and lose parts of it, so every later prompt on
 * that native session fails the same way until the session is discarded.
 * Observed wordings, as surfaced through ACP prompt errors:
 *
 * "Function call is missing a thought_signature in functionCall parts. This
 * is required for tools to work correctly, and missing thought_signature
 * may lead to degraded model performance. ..." (a `functionCall` part lost
 * its thought signature)
 *
 * "Requests ending with a model turn are not supported." (that dropped call
 * now ends the rebuilt history, so it ends on a model turn)
 *
 * Both are the same poison in different states of the same session.
 */
export function isNativeHistoryInvalidError(message: string): boolean {
  const text = message.toLowerCase();
  const signaturePoison =
    (text.includes("thought_signature") || text.includes("thoughtsignature")) &&
    (text.includes("missing") || text.includes("required"));
  const modelTurnEnding =
    text.includes("ending with a model turn") && text.includes("not supported");
  return signaturePoison || modelTurnEnding;
}

/**
 * The run failure for such a prompt error: a short actionable notice with
 * the native-history-invalid code, so the next turn retires the poisoned
 * native session and continues in a fresh one with a context handoff
 * instead of replaying the raw API text and failing identically forever.
 * Null for any other error.
 */
export function nativeHistoryInvalidFailure(
  message: string,
): OrchestrationV2ProviderFailure | null {
  if (!isNativeHistoryInvalidError(message)) return null;
  return makeProviderFailure({
    message:
      "The provider could not restore this conversation's saved history, so the saved session was retired. Send the message again to continue in a fresh session with the conversation handed over.",
    code: ORCHESTRATION_V2_NATIVE_HISTORY_INVALID_FAILURE_CODE,
    class: "provider_error",
  });
}
