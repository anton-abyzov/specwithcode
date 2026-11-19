/**
 * 0898 AC-01: only a person on this machine opts it in or out of the team
 * view, or reads what it would send. Another machine's coordinator key that
 * reached the socket is refused at the server, whatever its scopes.
 */
import { AuthSettingsWriteScope, EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { RpcScopeAuthorization } from "@specweave-studio/contracts";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const methods = [WS_METHODS.teamUsageStatus, WS_METHODS.teamUsageUpdate, WS_METHODS.teamUsageOrgs];
const coordinator = { kind: "coordinator" as const, environmentId: EnvironmentId.make("env-other") };

describe("team usage RPCs are the member's own", () => {
  it("need settings:write", () => {
    for (const method of methods)
      expect(RpcAuthorization.requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
  });

  it("refuse a coordinator key, let the person's own device through", () => {
    for (const method of methods) {
      expect(RpcAuthorization.refusesOwnerOnlyRpc(method, coordinator)).toBe(true);
      expect(RpcAuthorization.refusesOwnerOnlyRpc(method, { kind: "device", id: "mac" })).toBe(false);
    }
  });

  it.effect("the socket middleware refuses the update before it runs", () =>
    Effect.gen(function* () {
      const authorize = yield* RpcScopeAuthorization;
      let ran = false;
      const call = Effect.sync(() => {
        ran = true;
      });
      const refused = yield* Effect.flip(
        authorize(call as never, {
          rpc: { _tag: WS_METHODS.teamUsageUpdate },
          payload: { config: { enabled: true } },
        } as never) as Effect.Effect<unknown, { message: string }>,
      );
      expect(refused.message).toBe("Only a person on this machine can change what it shares with a team.");
      expect(ran).toBe(false);
    }).pipe(
      Effect.provide(RpcAuthorization.layer([AuthSettingsWriteScope], coordinator)),
    ),
  );
});
