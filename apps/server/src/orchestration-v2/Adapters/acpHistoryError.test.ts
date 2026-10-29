import { assert, describe, it } from "@effect/vitest";

import { isNativeHistoryInvalidError, nativeHistoryInvalidFailure } from "./acpHistoryError.ts";

// The exact texts a Gemini coordinator run surfaced through ACP (2026-10-29):
// the same poisoned session failed with the signature wording in the morning
// and with the model-turn wording after SpecWithCode 1.0.116, because the
// rebuilt history now ends on the dropped function call.
const GEMINI_SIGNATURE_ERROR =
  "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:mcp_studio-code_orchestrator_capabilities` , position 2. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.";
const GEMINI_MODEL_TURN_ERROR = "Requests ending with a model turn are not supported.";

describe("native history invalid errors", () => {
  it("reads the Gemini API wordings as a poisoned native history", () => {
    assert.isTrue(isNativeHistoryInvalidError(GEMINI_SIGNATURE_ERROR));
    assert.isTrue(
      isNativeHistoryInvalidError(
        "INVALID_ARGUMENT: thoughtSignature is required for function calling",
      ),
    );
    assert.isTrue(isNativeHistoryInvalidError(GEMINI_MODEL_TURN_ERROR));
  });

  it("turns each into a coded, actionable failure instead of the raw API text", () => {
    for (const message of [GEMINI_SIGNATURE_ERROR, GEMINI_MODEL_TURN_ERROR]) {
      const failure = nativeHistoryInvalidFailure(message);
      assert.deepStrictEqual(failure, {
        class: "provider_error",
        message:
          "The provider could not restore this conversation's saved history, so the saved session was retired. Send the message again to continue in a fresh session with the conversation handed over.",
        code: "native_history_invalid",
        retryable: null,
      });
    }
  });

  it("leaves other errors and prose alone", () => {
    for (const message of [
      "",
      "Network error: fetch failed",
      "Error: rate limit exceeded",
      // Mentions the field as part of an answer, not as the failure.
      "The thought_signature field is documented on the Gemini API page.",
      "Missing required parameter: model",
      "The docs discuss a conversation ending with a model turn.",
      "This operation is not supported on Windows.",
    ]) {
      assert.isFalse(isNativeHistoryInvalidError(message), message);
      assert.isNull(nativeHistoryInvalidFailure(message), message);
    }
  });
});
