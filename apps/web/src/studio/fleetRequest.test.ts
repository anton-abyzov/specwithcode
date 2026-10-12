import { describe, expect, it } from "vite-plus/test";
import {
  BearerConnectionTarget,
  type PreparedConnection,
} from "@specweave-studio/client-runtime/connection";
import { layerRemoteHttpClient } from "@specweave-studio/client-runtime/rpc";
import { AuthOrchestrationReadScope, EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { requestFleet, requestFleetPairing } from "./fleetRequest";
const environmentId = EnvironmentId.make("env-m4");
const prepared: PreparedConnection = {
  environmentId,
  label: "M4",
  httpBaseUrl: "http://localhost:8319",
  socketUrl: "ws://localhost:8319/ws",
  target: new BearerConnectionTarget({ environmentId, label: "M4", connectionId: "fixture" }),
  httpAuthorization: null,
};
describe("browser fleet requests", () => {
  it("uses the prepared environment's authenticated cookie request and accepts metadata without credentials", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const layer = layerRemoteHttpClient(async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return Response.json({
        configured: true,
        connectPermission: "access:write",
        observedAt: new Date().toISOString(),
        listener: "loopback",
        machines: [],
      });
    });
    await Effect.runPromise(requestFleet(prepared).pipe(Effect.provide(layer)));
    expect(seen?.url).toBe("http://localhost:8319/api/studio/fleet");
    expect(seen?.init.credentials).toBe("include");
  });
  it("posts only an allowlisted machine ID and preserves the pinned destination for ordinary onboarding", async () => {
    let seen: RequestInit | undefined;
    const layer = layerRemoteHttpClient(async (_url, init) => {
      seen = init;
      return Response.json({
        environmentId: "env-m1",
        host: "https://fixture.tailnet.ts.net:8443",
        pairingCode: "one-time",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        scopes: [AuthOrchestrationReadScope],
      });
    });
    const result = await Effect.runPromise(
      requestFleetPairing(prepared, "m1").pipe(Effect.provide(layer)),
    );
    expect(JSON.parse(String(seen?.body))).toEqual({ id: "m1" });
    expect(seen?.method).toBe("POST");
    expect(seen?.credentials).toBe("include");
    expect(result.environmentId).toBe("env-m1");
  });
});
