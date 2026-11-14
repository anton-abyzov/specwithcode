import { describe, expect, it } from "vite-plus/test";

import { signInAccountKey, signInFinished } from "./signInAccount";

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
    expect(from).toBe("old@example.com");
    expect(signInFinished({ status: "authenticated", email: "old@example.com" }, from)).toBe(false);
    expect(signInFinished({ status: "unauthenticated" }, from)).toBe(false);
    expect(signInFinished({ status: "authenticated", email: "new@example.com" }, from)).toBe(true);
  });

  it("tells accounts apart by login when there is no email", () => {
    expect(signInAccountKey({ login: "Work" })).toBe("work");
    expect(signInAccountKey({})).toBe("");
  });
});
