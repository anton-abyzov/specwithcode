import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@specweave-studio/contracts";
import { RelayConnectionTarget } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";

import { gateConnectSignIn, projectEnvironmentPresentation } from "../state/environments";
import { connectSignInShown } from "./connectAccountState";

const REFUSED = {
  phase: "error",
  error: "Sign in to SpecWithCode Connect to connect this environment.",
  blockedReason: "authentication",
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
    // Its "authentication" reason waits too, so no "Signed out" word flashes either.
    expect(starting).toEqual({ phase: "error", error: REFUSED.error });
    expect(starting).not.toHaveProperty("blockedReason");
    expect(gateConnectSignIn(REFUSED, "unknown")).not.toHaveProperty("connectSignInRequired");
    const plain: { phase: string; connectSignInRequired?: boolean } = { phase: "connected" };
    expect(gateConnectSignIn(plain, "signed-in")).toBe(plain);
  });
});

describe("the projection every label reads", () => {
  const environmentId = EnvironmentId.make("office");
  const presentation = {
    entry: {
      target: new RelayConnectionTarget({ environmentId, label: "Office Mac" }),
      profile: Option.none(),
    },
    connection: REFUSED,
  } as unknown as Parameters<typeof projectEnvironmentPresentation>[1];

  it("keeps the sign-in mark only once Clerk says signed out", () => {
    const out = projectEnvironmentPresentation(environmentId, presentation, "signed-out");
    expect(out.connection.connectSignInRequired).toBe(true);
    expect(out.connection.blockedReason).toBe("authentication");
    for (const account of ["unknown", "signed-in"] as const) {
      const starting = projectEnvironmentPresentation(environmentId, presentation, account);
      expect(starting.connection).not.toHaveProperty("connectSignInRequired");
      expect(starting.connection).not.toHaveProperty("blockedReason");
      expect(starting.connection.phase).toBe("error");
    }
  });
});
