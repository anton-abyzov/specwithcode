import { describe, it, expect } from "@effect/vitest";
import {
  WS_METHODS,
  clientRpcRequiredScopes,
  AuthStandardClientScopes,
} from "@specweave-studio/contracts";

describe("managed update destination commands", () => {
  it("ordinary pairing can check but cannot grant or revoke remote permission", () => {
    for (const tag of [WS_METHODS.managedUpdatesEnroll, WS_METHODS.managedUpdatesRevoke]) {
      const scopes = clientRpcRequiredScopes(tag, {});
      expect(scopes).toEqual(["access:write", "environment:maintain"]);
      expect(scopes.every((scope) => AuthStandardClientScopes.some((allowed) => allowed === scope))).toBe(false);
    }
    expect(clientRpcRequiredScopes(WS_METHODS.managedUpdatesCheck, {})).toEqual([
      "environment:maintain",
    ]);
  });
});
