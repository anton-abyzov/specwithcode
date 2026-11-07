import { describe, expect, it } from "vite-plus/test";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@specweave-studio/client-runtime/connection";
import { layerRemoteHttpClient } from "@specweave-studio/client-runtime/rpc";
import { AuthOrchestrationReadScope, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import { RemoteEnvironmentAuthorization } from "@specweave-studio/client-runtime/studio";
import { normalizeDpopHtu } from "@specweave-studio/shared/dpopCommon";
import * as Effect from "effect/Effect";
import { requestFleet, requestFleetPairing, requestRemoteWorkers } from "./fleetRequest";
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
  it("signs the remote worker path sent by the HTTP client without encoding its query into the path", async () => {
    const proofs: string[] = [];
    const requests: string[] = [];
    const relayPrepared: PreparedConnection = {
      ...prepared,
      httpBaseUrl: "https://m4.example.test",
      target: new RelayConnectionTarget({ environmentId, label: "M4" }),
      httpAuthorization: { _tag: "Dpop", accessToken: "fixture", expiresAtEpochMs: 9999999999999 },
    };
    const layer = layerRemoteHttpClient(async (url) => {
      requests.push(String(url));
      expect(normalizeDpopHtu(proofs.at(-1)!)).toBe(normalizeDpopHtu(String(url)));
      expect(new URL(String(url)).searchParams.get("projectId")).toBe("project:linux/m4");
      return Response.json({ workers: [] });
    });
    await Effect.runPromise(
      requestRemoteWorkers(relayPrepared, ProjectId.make("project:linux/m4")).pipe(
        Effect.provide(layer),
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: Effect.succeed("fixture"),
          createProof: ({ url }) =>
            Effect.sync(() => {
              proofs.push(url);
              return "proof";
            }),
        }),
        Effect.provideService(RemoteEnvironmentAuthorization, {
          authorizeBearer: () => Effect.die("Unexpected bearer"),
          authorizeDpop: () => Effect.die("Unexpected socket"),
          authorizeDpopHttp: () =>
            Effect.succeed({
              environmentId,
              label: "M4",
              httpBaseUrl: relayPrepared.httpBaseUrl,
              httpAuthorization: {
                _tag: "Dpop",
                accessToken: "fixture",
                expiresAtEpochMs: 9999999999999,
              },
            }),
        }),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(proofs).toHaveLength(1);
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
