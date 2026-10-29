import { assert, describe, it } from "@effect/vitest";

import { isMissingThoughtSignatureError, missingThoughtSignatureFailure } from "./acpHistoryError.ts";

// The exact text a Gemini coordinator run surfaced through ACP (2026-10-29).
const GEMINI_SIGNATURE_ERROR =
  "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly, and missing thought_signature may lead to degraded model performance. Additional data, function call `default_api:mcp_studio-code_orchestrator_capabilities` , position 2. Please refer to https://ai.google.dev/gemini-api/docs/thought-signatures for more details.";

describe("missing thought signature errors", () => {
  it("reads the Gemini API wording as a poisoned native history", () => {
    assert.isTrue(isMissingThoughtSignatureError(GEMINI_SIGNATURE_ERROR));
    assert.isTrue(
      isMissingThoughtSignatureError(
        "INVALID_ARGUMENT: thoughtSignature is required for function calling",
      ),
    );
  });

  it("turns it into a coded, actionable failure instead of the raw API text", () => {
    const failure = missingThoughtSignatureFailure(GEMINI_SIGNATURE_ERROR);
    assert.deepStrictEqual(failure, {
      class: "provider_error",
      message:
        "The provider could not restore this conversation's earlier tool calls, so the saved session was retired. Send the message again to continue in a fresh session with the conversation handed over.",
      code: "native_history_invalid",
      retryable: null,
    });
  });

  it("leaves other errors and prose alone", () => {
    for (const message of [
      "",
      "Network error: fetch failed",
      "Error: rate limit exceeded",
      // Mentions the field as part of an answer, not as the failure.
      "The thought_signature field is documented on the Gemini API page.",
      "Missing required parameter: model",
    ]) {
      assert.isFalse(isMissingThoughtSignatureError(message), message);
      assert.isNull(missingThoughtSignatureFailure(message), message);
    }
  });
});
