import { describe, expect, it } from "vite-plus/test";

import {
  CONTEXT_HANDOFF_TOO_LARGE_MESSAGE,
  isContextHandoffBudgetMessage,
  isContextLimitError,
  providerFailureDisplayMessage,
  providerFailureDisplayTitle,
} from "./orchestrationV2ThreadError.ts";

const legacy =
  "Insufficient context allowance for the provider handoff. SpecWithCode compacts the conversation and sends the request again once; if it still does not fit, use a larger-context model. The current request has not been truncated.";

describe("a provider handoff that does not fit", () => {
  it("reads as a context limit with one short explanation, in either wording", () => {
    for (const message of [legacy, CONTEXT_HANDOFF_TOO_LARGE_MESSAGE]) {
      const failure = { class: "provider_error" as const, message };
      expect(isContextHandoffBudgetMessage(message)).toBe(true);
      expect(isContextLimitError(message)).toBe(true);
      expect(providerFailureDisplayTitle(failure)).toBe("Context limit reached");
      expect(providerFailureDisplayMessage(failure)).toBe(CONTEXT_HANDOFF_TOO_LARGE_MESSAGE);
    }
    expect(CONTEXT_HANDOFF_TOO_LARGE_MESSAGE).not.toMatch(/compacts the conversation/);
  });

  it("leaves other provider errors alone", () => {
    expect(isContextHandoffBudgetMessage("Provider session failed to open")).toBe(false);
    expect(
      providerFailureDisplayMessage({ class: "provider_error", message: "Something broke" }),
    ).toBe("Something broke");
  });
});
