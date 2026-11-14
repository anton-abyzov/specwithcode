import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@specweave-studio/contracts";

import { codexSignInCanSwitch, signInAccountKey, signInFinished } from "./signInAccount";

describe("signInFinished", () => {
  it("ends a first sign-in once the agent is signed in", () => {
    expect(signInFinished(undefined, undefined)).toBe(false);
    expect(signInFinished({ status: "unauthenticated" }, undefined)).toBe(false);
    expect(signInFinished({ status: "authenticated", email: "a@example.com" }, undefined)).toBe(
      true,
    );
  });

  it("keeps an account switch open until another account is signed in", () => {
    const from = signInAccountKey({ email: "Old@Example.com" });
    expect(from).toBe("old@example.com|");
    expect(signInFinished({ status: "authenticated", email: "old@example.com" }, from)).toBe(false);
    expect(signInFinished({ status: "unauthenticated" }, from)).toBe(false);
    expect(signInFinished({ status: "authenticated", email: "new@example.com" }, from)).toBe(true);
  });

  it("tells accounts apart by login when there is no email, and by plan for one email", () => {
    expect(signInAccountKey({ login: "Work" })).toBe("work|");
    expect(signInAccountKey({})).toBe("|");
    const personal = signInAccountKey({ email: "a@example.com", label: "Free" });
    expect(
      signInFinished({ status: "authenticated", email: "a@example.com", label: "Team" }, personal),
    ).toBe(true);
  });

  it("switches only a Codex on a ChatGPT sign-in", () => {
    const codex = ProviderDriverKind.make("codex");
    const auth = (type?: string) => ({ status: "authenticated" as const, ...(type ? { type } : {}) });
    expect(codexSignInCanSwitch({ driver: codex, auth: auth("chatgpt") })).toBe(true);
    for (const type of ["apiKey", "amazonBedrock", undefined])
      expect(codexSignInCanSwitch({ driver: codex, auth: auth(type) })).toBe(false);
    expect(codexSignInCanSwitch({ driver: codex, auth: { status: "unauthenticated" } })).toBe(false);
    expect(
      codexSignInCanSwitch({ driver: ProviderDriverKind.make("grok"), auth: auth("chatgpt") }),
    ).toBe(false);
    expect(
      codexSignInCanSwitch({ driver: codex, auth: { ...auth("chatgpt"), subscriptionSharing: true } }),
    ).toBe(false);
    expect(codexSignInCanSwitch(undefined)).toBe(false);
  });
});
