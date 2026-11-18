import { describe, expect, it } from "vite-plus/test";

import { gateConnectSignIn } from "../state/environments";
import { connectSignInShown } from "./connectAccountState";

const REFUSED = {
  phase: "error",
  error: "Sign in to SpecWithCode Connect to connect this environment.",
  connectSignInRequired: true,
} as const;

describe("the needs-sign-in mark on a connection", () => {
  it("shows only once Clerk says this window is signed out", () => {
    expect(connectSignInShown(true, "signed-out")).toBe(true);
    // Clerk still loading, or a signed-in session not yet handed to the relay client.
    expect(connectSignInShown(true, "unknown")).toBe(false);
    expect(connectSignInShown(true, "signed-in")).toBe(false);
    expect(connectSignInShown(undefined, "signed-out")).toBe(false);
  });

  it("is dropped from the projected connection during the startup race", () => {
    expect(gateConnectSignIn(REFUSED, "signed-out")).toBe(REFUSED);
    const starting = gateConnectSignIn(REFUSED, "signed-in");
    expect(starting).not.toHaveProperty("connectSignInRequired");
    expect(starting).toEqual({ phase: "error", error: REFUSED.error });
    expect(gateConnectSignIn(REFUSED, "unknown")).not.toHaveProperty("connectSignInRequired");
    const plain: { phase: string; connectSignInRequired?: boolean } = { phase: "connected" };
    expect(gateConnectSignIn(plain, "signed-in")).toBe(plain);
  });
});
