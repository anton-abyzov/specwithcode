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
