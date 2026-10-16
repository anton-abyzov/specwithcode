import type { AuthSessionState } from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { environmentScopeAccess, providerManageBlockedText } from "./session";

const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "studio_session_8319_abc",
  serverUpdateScope: "environment:maintain",
} as const;

const signedIn = (scopes: ReadonlyArray<string>) =>
  AsyncResult.success({
    authenticated: true,
    auth,
    sessionMethod: "browser-session-cookie",
    scopes,
  } as unknown as AuthSessionState);

describe("environmentScopeAccess", () => {
  it("separates a missing grant from a lost or unloaded sign-in", () => {
    expect(environmentScopeAccess(signedIn(["providers:manage"]), "providers:manage")).toBe(
      "granted",
    );
    expect(environmentScopeAccess(signedIn(["orchestration:read"]), "providers:manage")).toBe(
      "denied",
    );
    expect(
      environmentScopeAccess(
        AsyncResult.success({ authenticated: false, auth } as unknown as AuthSessionState),
        "providers:manage",
      ),
    ).toBe("signed-out");
    expect(environmentScopeAccess(AsyncResult.initial(), "providers:manage")).toBe("unknown");
    expect(
      environmentScopeAccess(
        AsyncResult.failure(new Error("offline") as never),
        "providers:manage",
      ),
    ).toBe("unknown");
  });

  it("does not trust a cached grant while the connection is down", () => {
    const cached = signedIn(["providers:manage"]);
    expect(environmentScopeAccess(cached, "providers:manage", { phase: "connected" })).toBe(
      "granted",
    );
    expect(environmentScopeAccess(cached, "providers:manage", { phase: "reconnecting" })).toBe(
      "unknown",
    );
    expect(
      environmentScopeAccess(cached, "providers:manage", {
        phase: "error",
        blockedReason: "authentication",
      }),
    ).toBe("signed-out");
  });

  it("only blames the connection's permissions when the grant is missing", () => {
    expect(providerManageBlockedText("granted")).toBeNull();
    expect(providerManageBlockedText("denied")).toMatch(/cannot manage provider accounts/);
    expect(providerManageBlockedText("signed-out")).toMatch(/signed out/);
    expect(providerManageBlockedText("unknown")).not.toMatch(/cannot manage/);
  });
});
