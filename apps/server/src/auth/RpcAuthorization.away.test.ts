import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  EnvironmentId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { refusesOwnerOnlyRpc, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

/**
 * away.decideAccess changes this machine's work grants, so over the socket it
 * must meet the bar HTTP updateWorkGrant sets: access:write, never another
 * machine's coordinator key (the socket's origin is checked when it opens).
 */
describe("away.decideAccess over the socket", () => {
  const method = WS_METHODS.awayDecideAccess;

  it("needs access:write, the scope HTTP grant changes need", () => {
    expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.awayAccessRequests)).toBe(AuthAccessReadScope);
  });

  it("refuses a coordinator principal even with the scope, as HTTP does", () => {
    expect(
      refusesOwnerOnlyRpc(method, {
        kind: "coordinator",
        environmentId: EnvironmentId.make("env-m4"),
      }),
    ).toBe(true);
  });

  it("lets the owner's own device or session through to the scope check", () => {
    expect(refusesOwnerOnlyRpc(method, { kind: "device", id: "owner-mac" })).toBe(false);
    expect(refusesOwnerOnlyRpc(method, undefined)).toBe(false);
    // Other methods are left to their scopes.
    expect(
      refusesOwnerOnlyRpc(WS_METHODS.awayPreflight, {
        kind: "coordinator",
        environmentId: EnvironmentId.make("env-m4"),
      }),
    ).toBe(false);
  });
});

/**
 * Starting Away, bringing work back, asking another machine for access and
 * changing the Away triggers move this machine's work, so another machine's
 * coordinator key is refused for them even when it holds the scope.
 */
describe("Away owner-only methods over the socket", () => {
  const coordinator = { kind: "coordinator", environmentId: EnvironmentId.make("env-m4") } as const;
  const ownerOnly = [
    WS_METHODS.awayStart,
    WS_METHODS.awayBringBack,
    WS_METHODS.awayUpdateConfig,
    WS_METHODS.awayRequestAccess,
  ];

  it.each(ownerOnly)("refuses a coordinator principal for %s", (method) => {
    expect(refusesOwnerOnlyRpc(method, coordinator)).toBe(true);
  });

  it.each(ownerOnly)("lets the owner's device or session through for %s", (method) => {
    expect(refusesOwnerOnlyRpc(method, { kind: "device", id: "owner-mac" })).toBe(false);
    expect(refusesOwnerOnlyRpc(method, undefined)).toBe(false);
  });

  it("leaves reads to their scopes", () => {
    for (const method of [
      WS_METHODS.awaySnapshot,
      WS_METHODS.awayAccessStatus,
      WS_METHODS.awayPreflight,
    ]) {
      expect(refusesOwnerOnlyRpc(method, coordinator)).toBe(false);
    }
  });
});
