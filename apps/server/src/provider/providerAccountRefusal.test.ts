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
  it("recognizes Google's refusal by message or by code beside Gemini's name", () => {
    expect(providerAccountRefusalInText(GOOGLE_REFUSAL)).toBe("personal_account_unsupported");
    expect(providerAccountRefusalInText("Gemini Code Assist: UNSUPPORTED_CLIENT")).toBe(
      "personal_account_unsupported",
    );
    // The bare code from any other provider is not Google's refusal.
    expect(providerAccountRefusalInText("status UNSUPPORTED_CLIENT")).toBeUndefined();
    expect(providerAccountRefusalInText("login required")).toBeUndefined();
    expect(providerAccountRefusalInText(undefined)).toBeUndefined();
  });

  it("finds it in an ACP error, its data and nested causes", () => {
    expect(providerAccountRefusal({ errorMessage: GOOGLE_REFUSAL })).toBe(
      "personal_account_unsupported",
    );
    expect(
      providerAccountRefusal({
        message: "Gemini request failed",
        data: { reason: "UNSUPPORTED_CLIENT" },
      }),
    ).toBe("personal_account_unsupported");
    expect(
      providerAccountRefusal({ message: "failed", data: { reason: "UNSUPPORTED_CLIENT" } }),
    ).toBeUndefined();
    expect(providerAccountRefusal({ message: "outer", cause: new Error(GOOGLE_REFUSAL) })).toBe(
      "personal_account_unsupported",
    );
    const loop: { message: string; cause?: unknown } = { message: "loop" };
    loop.cause = loop;
    expect(providerAccountRefusal(loop)).toBeUndefined();
    const throwing = {
      get message(): string {
        throw new Error("unreadable");
      },
    };
    expect(providerAccountRefusal(throwing)).toBeUndefined();
  });

  it("turns a refused turn into one plain sentence", () => {
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
    // An open failure keeps its own code so the track fallback still moves on.
    const open = makeProviderFailure({
      message: GOOGLE_REFUSAL,
      code: "provider_open_failed",
      retryable: true,
    });
    expect(open.message).toBe(PERSONAL_ACCOUNT_UNSUPPORTED_MESSAGE);
    expect(open.code).toBe("provider_open_failed");
    expect(open.retryable).toBe(true);
  });
});
