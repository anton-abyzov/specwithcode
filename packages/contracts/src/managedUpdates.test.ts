import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ManagedUpdateEnrollment, ManagedUpdateMutation } from "./managedUpdates.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

const enrollment = {
  installationId: "studio-work",
  environmentId: "destination",
  expectedRevision: 0,
  consent: true,
};
describe("managed updates contract", () => {
  it("requires affirmative consent and a bounded exact destination", () => {
    const decode = Schema.decodeUnknownSync(ManagedUpdateEnrollment);
    expect(decode(enrollment)).toEqual(enrollment);
    for (const bad of [
      { ...enrollment, consent: false },
      { ...enrollment, consent: undefined },
      { ...enrollment, installationId: "../m4" },
      { ...enrollment, installationId: "A" },
      { ...enrollment, expectedRevision: -1 },
      { ...enrollment, expectedRevision: 1.5 },
    ])
      expect(() => decode(bad)).toThrow();
  });
  it("requires a revision when revoking and both administrative scopes when mutating", () => {
    expect(() =>
      Schema.decodeUnknownSync(ManagedUpdateMutation)({
        installationId: "work",
        environmentId: "e",
      }),
    ).toThrow();
    for (const method of [WS_METHODS.managedUpdatesEnroll, WS_METHODS.managedUpdatesRevoke])
      expect(clientRpcRequiredScopes(method, enrollment)).toEqual([
        "access:write",
        "environment:maintain",
      ]);
    expect(clientRpcRequiredScopes(WS_METHODS.managedUpdatesCheck, enrollment)).toEqual([
      "environment:maintain",
    ]);
  });
});
