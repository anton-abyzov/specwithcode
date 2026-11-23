import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_ACCOUNT_UNSUPPORTED_MESSAGE,
  providerAccountRefusal,
  providerAccountRefusalInText,
} from "./providerAccountRefusal.ts";
import { makeProviderFailure } from "../orchestration-v2/ProviderFailure.ts";

const GOOGLE_REFUSAL =
  "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google";

describe("provider account refusal", () => {
  it("recognizes Google's refusal by message or code, and nothing else", () => {
    expect(providerAccountRefusalInText(GOOGLE_REFUSAL)).toBe("personal_account_unsupported");
    expect(providerAccountRefusalInText("status UNSUPPORTED_CLIENT")).toBe(
      "personal_account_unsupported",
    );
    expect(providerAccountRefusalInText("login required")).toBeUndefined();
    expect(providerAccountRefusalInText(undefined)).toBeUndefined();
  });

  it("finds it in an ACP error, its data and nested causes", () => {
    expect(providerAccountRefusal({ errorMessage: GOOGLE_REFUSAL })).toBe(
      "personal_account_unsupported",
    );
    expect(
      providerAccountRefusal({ message: "failed", data: { reason: "UNSUPPORTED_CLIENT" } }),
    ).toBe("personal_account_unsupported");
    expect(providerAccountRefusal({ message: "outer", cause: new Error(GOOGLE_REFUSAL) })).toBe(
      "personal_account_unsupported",
    );
    const loop: { message: string; cause?: unknown } = { message: "loop" };
    loop.cause = loop;
    expect(providerAccountRefusal(loop)).toBeUndefined();
  });

  it("turns a refused turn into one plain sentence that is not retried", () => {
    const failure = makeProviderFailure({
      message: `Error: ${GOOGLE_REFUSAL}`,
      class: "provider_error",
    });
    expect(failure.message).toBe(PERSONAL_ACCOUNT_UNSUPPORTED_MESSAGE);
    expect(failure.code).toBe("provider_account_refused");
    expect(failure.retryable).toBe(false);
    expect(
      makeProviderFailure({ message: "Network down", class: "provider_error" }).code,
    ).toBeNull();
  });
});
