import { describe, expect, it } from "vite-plus/test";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@specweave-studio/client-runtime/connection";
import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import { layerRemoteHttpClient } from "@specweave-studio/client-runtime/rpc";
import { RemoteEnvironmentAuthorization } from "@specweave-studio/client-runtime/studio";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { requestCapacity } from "./capacityRequest";

const response = {
  schemaVersion: 1,
  observedAt: "2026-10-07T18:00:00Z",
  source: "specweave-switch",
  scope: "environment-local",
  available: false,
  error: "switch-unavailable",
  quotaPoolIdentity: "unavailable",
  verifiedQuotaPoolCount: null,
  accounts: [],
  policy: null,
  recommendations: [],
};
const environmentId = EnvironmentId.make("worker-test");
function prepared(auth: PreparedConnection["httpAuthorization"]): PreparedConnection {
  return {
    environmentId,
    label: "Worker",
    httpBaseUrl: "https://worker.example.test/ignored?not-a-switch-url=1",
    socketUrl: "wss://worker.example.test/ws",
    target: new BearerConnectionTarget({ environmentId, label: "Worker", connectionId: "test" }),
    httpAuthorization: auth,
  };
}
function harness(reply: () => Response = () => Response.json(response)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const layer = layerRemoteHttpClient(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  });
  return { calls, layer };
}
describe("typed authenticated environment capacity requests", () => {
  it("GETs only the selected registered environment, using its prepared bearer", async () => {
    const h = harness();
    const value = await Effect.runPromise(
      requestCapacity(prepared({ _tag: "Bearer", token: "synthetic-test-credential" }), {
        kind: "read",
      }).pipe(Effect.provide(h.layer)),
    );
    expect(value).toEqual(response);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("https://worker.example.test/api/studio/capacity");
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer synthetic-test-credential",
    );
  });
  it("uses credentialed cookie fetch for a registered browser environment", async () => {
    const h = harness();
    await Effect.runPromise(
      requestCapacity(prepared(null), { kind: "read" }).pipe(Effect.provide(h.layer)),
    );
    expect(h.calls[0]?.init.credentials).toBe("include");
    expect(new Headers(h.calls[0]?.init.headers).has("authorization")).toBe(false);
  });
  it("sends nullable Automatic selection through the typed POST endpoint", async () => {
    const h = harness();
    await Effect.runPromise(
      requestCapacity(prepared(null), { kind: "select", input: { id: null } }).pipe(
        Effect.provide(h.layer),
      ),
    );
    expect(h.calls[0]?.url).toBe("https://worker.example.test/api/studio/capacity/select");
    expect(h.calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ id: null });
  });
  it("rejects an invalid successful payload instead of manufacturing ready capacity", async () => {
    const h = harness(() =>
      Response.json({ accounts: [{ authenticated: true, status: "ready" }] }),
    );
    await expect(
      Effect.runPromise(
        requestCapacity(prepared(null), { kind: "read" }).pipe(Effect.provide(h.layer)),
      ),
    ).rejects.toThrow();
  });
  it("binds DPoP proof to the renewed environment request and never downgrades to bearer", async () => {
    const h = harness();
    const proofs: Array<{ method: string; url: string }> = [];
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("synthetic-thumbprint"),
      createProof: (input) =>
        Effect.sync(() => {
          proofs.push(input);
          return "synthetic-request-proof";
        }),
    });
    const authorization = RemoteEnvironmentAuthorization.of({
      authorizeBearer: () => Effect.die("No bearer fallback"),
      authorizeDpop: () => Effect.die("No socket preparation"),
      authorizeDpopHttp: () =>
        Effect.succeed({
          environmentId,
          label: "Worker",
          httpBaseUrl: "https://current-worker.example.test",
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "synthetic-current-token",
            expiresAtEpochMs: Date.now() + 60000,
          },
        }),
    });
    const connection = {
      ...prepared({ _tag: "Dpop", accessToken: "synthetic-old-token", expiresAtEpochMs: 0 }),
      target: new RelayConnectionTarget({ environmentId, label: "Worker" }),
    };
    await Effect.runPromise(
      requestCapacity(connection, { kind: "policy", input: { mode: "spend-first" } }).pipe(
        Effect.provide(h.layer),
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, signer),
        Effect.provideService(RemoteEnvironmentAuthorization, authorization),
      ),
    );
    expect(proofs).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "https://current-worker.example.test/api/studio/capacity/policy",
      }),
    ]);
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
      "DPoP synthetic-current-token",
    );
    expect(new Headers(h.calls[0]?.init.headers).get("dpop")).toBe("synthetic-request-proof");
  });
});
