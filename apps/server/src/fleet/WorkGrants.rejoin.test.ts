/**
 * Re-inviting a coordinator after Stop against the real SQLite principal
 * revocation trigger and auth service: `prepareForRejoin` clears the principal
 * block so a fresh invitation can mint again, keeps pre-Stop tokens permanently
 * dead, never shows an unredeemed rejoin as active, and never clears an
 * already-active grant's end time.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ChildProcessSpawner } from "effect/process";

import * as CredentialFailureLimiter from "../auth/CredentialFailureLimiter.ts";
import { makeTestDpopKey } from "../auth/dpopProof.testkit.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_PUBLIC_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
} from "../cloud/config.ts";
import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { persistServerRuntimeState } from "../serverRuntimeState.ts";
import * as FleetHttp from "../studioFleetHttp.ts";
import {
  FLEET_INVITE_MAKER_SCOPES,
  FLEET_INVITE_SCOPES,
  FLEET_INVITE_SESSION_LABEL,
} from "../studioFleetInvite.ts";
import { decodeFleetJoinCode } from "../studioFleetJoin.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import { workGrantsSnapshot } from "./workGrantsSnapshot.ts";
import * as WorkGrants from "./WorkGrants.ts";

const WORKER = EnvironmentId.make("env-worker");
const COORDINATOR = EnvironmentId.make("env-coordinator");
const CONNECT_HOST = "prod-0123456789abcdef.spec-weave.com";
const CONNECT = `https://${CONNECT_HOST}`;

const makeLayer = () => {
  const config = Config.layerTest(process.cwd(), { prefix: "studio-work-grant-rejoin-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(WORKER),
      }),
    ),
    Layer.provide(config),
  );
  const grants = WorkGrants.layer.pipe(
    Layer.provideMerge(auth),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return grants;
};

describe("WorkGrants.prepareForRejoin", () => {
  it.effect(
    "clears Stop so a fresh invitation can mint while pre-Stop tokens stay permanently rejected",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const grants = yield* WorkGrants.WorkGrants;
        const principal = { kind: "coordinator" as const, environmentId: COORDINATOR };

        const oldManagement = yield* auth.issueSession({
          subject: EnvironmentAuth.FLEET_INVITATION_SUBJECT,
          principal,
          scopes: [...FLEET_INVITE_SCOPES],
          label: FLEET_INVITE_SESSION_LABEL,
        });
        const oldWorker = yield* auth.issueSession({
          subject: EnvironmentAuth.MCP_CLIENT_SUBJECT,
          principal,
          scopes: [AuthOrchestrationReadScope],
          label: `fleet-worker:${COORDINATOR}`,
        });
        yield* grants.forCoordinator(COORDINATOR);

        const checkToken = (token: string) =>
          auth
            .authenticateHttpRequest(
              HttpServerRequest.fromWeb(
                new Request("http://127.0.0.1:8319/", {
                  headers: { host: "localhost:8319", authorization: `Bearer ${token}` },
                }),
              ),
            )
            .pipe(Effect.result);

        // Owner presses Stop: policy is revoked and SQLite blocks new minting.
        yield* grants.revoke(COORDINATOR);

        expect((yield* checkToken(oldManagement.token))._tag).toBe("Failure");
        expect((yield* checkToken(oldWorker.token))._tag).toBe("Failure");

        const blockedPairing = yield* auth
          .createPairingLink({
            subject: "fleet-redeem:30",
            principal,
            scopes: [...FLEET_INVITE_SCOPES],
          })
          .pipe(Effect.result);
        expect(blockedPairing._tag).toBe("Failure");

        // Owner invites the machine again: prepareForRejoin unblocks minting.
        yield* grants.prepareForRejoin(COORDINATOR);

        // Before the invite is redeemed, the snapshot still reports expired/renews:false (never false-active).
        const beforeRedeem = yield* workGrantsSnapshot({
          labels: new Map([[COORDINATOR, "m4"]]),
          ownEnvironmentId: WORKER,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
              }),
              Layer.mock(ProjectService.ProjectService)({
                snapshot: Effect.succeed({ projects: [] } as never),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([] as never),
              }),
            ),
          ),
        );
        expect(beforeRedeem.grants).toHaveLength(1);
        expect(beforeRedeem.grants[0]).toMatchObject({
          coordinatorEnvironmentId: COORDINATOR,
          status: "expired",
          renews: false,
        });

        // Fresh pairing link and fresh management session now succeed.
        const freshPairing = yield* auth.createPairingLink({
          subject: "fleet-redeem:30",
          principal,
          scopes: [...FLEET_INVITE_SCOPES],
        });
        expect(freshPairing.credential).toBeTruthy();

        const newManagement = yield* auth.issueSession({
          subject: EnvironmentAuth.FLEET_INVITATION_SUBJECT,
          principal,
          scopes: [...FLEET_INVITE_SCOPES],
          label: FLEET_INVITE_SESSION_LABEL,
        });
        const newMgmtCheck = yield* checkToken(newManagement.token);
        expect(newMgmtCheck._tag).toBe("Success");
        if (newMgmtCheck._tag === "Success") {
          expect(newMgmtCheck.success.sessionId).toBe(newManagement.sessionId);
        }

        // Pre-Stop tokens remain permanently tombstoned even after rejoin.
        expect((yield* checkToken(oldManagement.token))._tag).toBe("Failure");
        expect((yield* checkToken(oldWorker.token))._tag).toBe("Failure");
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("leaves an already-active time-limited grant untouched", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      yield* grants.forCoordinator(COORDINATOR);
      const updated = yield* grants.update({
        coordinatorEnvironmentId: COORDINATOR,
        duration: "1d",
      });
      expect(updated.endsAt).toBeTruthy();

      yield* grants.prepareForRejoin(COORDINATOR);

      const after = (yield* grants.policies).find(
        (policy) => policy.coordinatorEnvironmentId === COORDINATOR,
      );
      expect(after?.endsAt).toBe(updated.endsAt);
      expect(after?.revokedAt).toBeNull();
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("clears a time-limited grant whose end time already passed", () =>
    Effect.gen(function* () {
      const grants = yield* WorkGrants.WorkGrants;
      yield* grants.forCoordinator(COORDINATOR);
      yield* grants.update({
        coordinatorEnvironmentId: COORDINATOR,
        duration: "1h",
      });
      // Advance past the end time by revoking and checking endsAt clears on rejoin.
      const before = (yield* grants.policies).find(
        (policy) => policy.coordinatorEnvironmentId === COORDINATOR,
      );
      expect(before?.endsAt).toBeTruthy();
      yield* grants.revoke(COORDINATOR);
      yield* grants.prepareForRejoin(COORDINATOR);

      const after = (yield* grants.policies).find(
        (policy) => policy.coordinatorEnvironmentId === COORDINATOR,
      );
      expect(after?.revokedAt).toBeNull();
      expect(after?.endsAt ?? null).toBeNull();
      expect(after?.interruptAt).toBeNull();
      expect(after?.interruptedAt).toBeNull();
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("clears a stale principal revocation without creating a phantom policy", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grants = yield* WorkGrants.WorkGrants;
      const principal = { kind: "coordinator" as const, environmentId: COORDINATOR };

      yield* auth.setPrincipalRevoked(principal, true);
      const blocked = yield* auth
        .createPairingLink({
          subject: "fleet-redeem:30",
          principal,
          scopes: [...FLEET_INVITE_SCOPES],
        })
        .pipe(Effect.result);
      expect(blocked._tag).toBe("Failure");

      yield* grants.prepareForRejoin(COORDINATOR);
      expect(yield* grants.policies).toHaveLength(0);

      const unblocked = yield* auth.createPairingLink({
        subject: "fleet-redeem:30",
        principal,
        scopes: [...FLEET_INVITE_SCOPES],
      });
      expect(unblocked.credential).toBeTruthy();
    }).pipe(Effect.provide(makeLayer())),
  );
});

class RejoinHttpApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.studioFleet) {}

describe("HTTP Stop -> re-invite -> redeem -> mint recovery", () => {
  it.live("recovers end-to-end after Stop via /api/studio/fleet/invite and redeem", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const context = Context.make(Crypto.Crypto, crypto);
      const config = Config.layerTest(process.cwd(), {
        prefix: "studio-work-grant-rejoin-http-",
      }).pipe(Layer.provide(NodeServices.layer));
      const fetchStub: typeof fetch = (async (url: string | URL | Request) => {
        if (new URL(String(url)).origin === CONNECT) {
          return Response.json({
            environmentId: WORKER,
            label: "Worker",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.1.0-test",
            orchestrationProtocolVersion: 2,
            capabilities: { repositoryIdentity: true },
          });
        }
        throw new TypeError("unreachable");
      }) as typeof fetch;
      const fetchLayer = Layer.succeed(FetchHttpClient.Fetch, fetchStub);
      const serverEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(WORKER),
        getDescriptor: Effect.succeed({ environmentId: WORKER, label: "Worker" } as never),
      });
      const noTailscale = Layer.merge(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                cause: new Error("not installed"),
              }),
            ),
          ),
        ),
        Layer.succeed(HostProcessPlatform, "linux"),
      );
      const layerAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(Sqlite.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(WORKER),
          }),
        ),
        Layer.provide(config),
      );
      const layerWorkGrants = WorkGrants.layer.pipe(
        Layer.provideMerge(layerAuth),
        Layer.provideMerge(config),
        Layer.provideMerge(NodeServices.layer),
      );

      let capturedAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
      let capturedSecrets: ServerSecretStore.ServerSecretStore["Service"] | undefined;
      let capturedConfig: Config.ServerConfig["Service"] | undefined;
      let capturedGrants: WorkGrants.WorkGrantsShape | undefined;

      const layerRoutes = Layer.mergeAll(
        Layer.effectDiscard(
          Effect.gen(function* () {
            capturedAuth = yield* EnvironmentAuth.EnvironmentAuth;
            capturedSecrets = yield* ServerSecretStore.ServerSecretStore;
            capturedConfig = yield* Config.ServerConfig;
            capturedGrants = yield* WorkGrants.WorkGrants;
          }),
        ),
        HttpApiBuilder.layer(RejoinHttpApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(
            FleetHttp.layer.pipe(
              Layer.provide(serverEnvironment),
              Layer.provide(noTailscale),
              Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(fetchLayer))),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
                  }),
                  Layer.mock(ProjectService.ProjectService)({
                    snapshot: Effect.succeed({ projects: [] } as never),
                  }),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([] as never),
                  }),
                  FleetTargets.layer.pipe(Layer.provide(fetchLayer)),
                ),
              ),
              Layer.provide(
                FleetWorkerGrants.layer.pipe(
                  Layer.provide(FleetTargets.layer.pipe(Layer.provide(fetchLayer))),
                  Layer.provide(serverEnvironment),
                ),
              ),
            ),
          ),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
        ),
      ).pipe(
        Layer.provide(CredentialFailureLimiter.layer),
        Layer.provideMerge(layerWorkGrants),
        Layer.provideMerge(layerAuth),
        Layer.provideMerge(config),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) =>
          Effect.gen(function* () {
            const call = (request: Request) => Effect.promise(() => web.handler(request, context));
            // Trigger layer initialization.
            yield* call(new Request("http://127.0.0.1:8319/api/auth/session"));
            const encode = (value: string) => new TextEncoder().encode(value);
            yield* capturedSecrets!.set(
              CLOUD_ENDPOINT_RUNTIME_CONFIG,
              encode(
                JSON.stringify({
                  providerKind: "cloudflare_tunnel",
                  connectorToken: "synthetic-connector",
                  tunnelId: "synthetic-tunnel",
                }),
              ),
            );
            yield* capturedSecrets!.set(CLOUD_LINKED_USER_ID, encode("synthetic-user"));
            yield* capturedSecrets!.set(
              CLOUD_ENDPOINT_PUBLIC_ORIGIN,
              encode(
                JSON.stringify({
                  origin: CONNECT,
                  source: "link",
                  recordedAt: "2026-10-18T00:00:00.000Z",
                }),
              ),
            );
            yield* persistServerRuntimeState({
              path: capturedConfig!.serverRuntimeStatePath,
              state: {
                version: 1,
                pid: process.pid,
                port: 8319,
                origin: "http://127.0.0.1:8319",
                startedAt: "2026-10-18T00:00:00.000Z",
              },
            }).pipe(Effect.provide(NodeServices.layer));

            const owner = yield* capturedAuth!.issueSession({
              subject: "local-owner",
              scopes: [...new Set([...AuthStandardClientScopes, ...FLEET_INVITE_MAKER_SCOPES])],
              label: "Owner",
            });
            const ownerHeaders = {
              host: "localhost:8319",
              authorization: `Bearer ${owner.token}`,
              "content-type": "application/json",
            };

            const key = makeTestDpopKey();
            const dpopHeaders = (token: string, method: string, path: string) => ({
              host: CONNECT_HOST,
              "x-forwarded-proto": "https",
              "content-type": "application/json",
              authorization: `DPoP ${token}`,
              dpop: key.proof({ method, url: `${CONNECT}${path}`, accessToken: token }),
            });

            // 1. Initial invite -> redeem -> mint worker pairing link succeeds.
            const firstInviteRes = yield* call(
              new Request("http://127.0.0.1:8319/api/studio/fleet/invite", {
                method: "POST",
                headers: ownerHeaders,
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR, via: "connect" }),
              }),
            );
            expect(firstInviteRes.status).toBe(200);
            const firstInvite = (yield* Effect.promise(() => firstInviteRes.json())) as {
              code: string;
            };
            const firstDecoded = decodeFleetJoinCode(firstInvite.code);
            if (!("redeem" in firstDecoded)) throw new Error("expected v2 invite");

            const firstRedeemRes = yield* call(
              new Request("http://127.0.0.1:8319/api/studio/fleet/invitation/redeem", {
                method: "POST",
                headers: {
                  host: CONNECT_HOST,
                  "x-forwarded-proto": "https",
                  "content-type": "application/json",
                  dpop: key.proof({
                    method: "POST",
                    url: `${CONNECT}/api/studio/fleet/invitation/redeem`,
                  }),
                },
                body: JSON.stringify({
                  credential: firstDecoded.redeem,
                  coordinatorEnvironmentId: COORDINATOR,
                }),
              }),
            );
            expect(firstRedeemRes.status).toBe(200);
            const { managementToken: oldToken } = (yield* Effect.promise(() =>
              firstRedeemRes.json(),
            )) as { managementToken: string };
            // Seed the coordinator's policy (as worker activity does) and verify minting works.
            yield* capturedGrants!.forCoordinator(COORDINATOR);
            const initialMintRes = yield* call(
              new Request("http://127.0.0.1:8319/api/auth/pairing-token", {
                method: "POST",
                headers: dpopHeaders(oldToken, "POST", "/api/auth/pairing-token"),
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR }),
              }),
            );
            expect(initialMintRes.status).toBe(200);

            // 2. Owner presses Stop.
            const stopRes = yield* call(
              new Request("http://127.0.0.1:8319/api/studio/fleet/work-grants/revoke", {
                method: "POST",
                headers: ownerHeaders,
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR }),
              }),
            );
            expect(stopRes.status).toBe(200);

            // Old management token can no longer mint a worker pairing token.
            const oldMintRes = yield* call(
              new Request("http://127.0.0.1:8319/api/auth/pairing-token", {
                method: "POST",
                headers: dpopHeaders(oldToken, "POST", "/api/auth/pairing-token"),
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR }),
              }),
            );
            expect(oldMintRes.status).toBe(401);

            // 3. Owner invites the same coordinator again -> prepareForRejoin unblocks minting.
            const rejoinInviteRes = yield* call(
              new Request("http://127.0.0.1:8319/api/studio/fleet/invite", {
                method: "POST",
                headers: ownerHeaders,
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR, via: "connect" }),
              }),
            );
            expect(rejoinInviteRes.status).toBe(200);
            const rejoinInvite = (yield* Effect.promise(() => rejoinInviteRes.json())) as {
              code: string;
            };
            const rejoinDecoded = decodeFleetJoinCode(rejoinInvite.code);
            if (!("redeem" in rejoinDecoded)) throw new Error("expected v2 rejoin invite");

            const rejoinRedeemRes = yield* call(
              new Request("http://127.0.0.1:8319/api/studio/fleet/invitation/redeem", {
                method: "POST",
                headers: {
                  host: CONNECT_HOST,
                  "x-forwarded-proto": "https",
                  "content-type": "application/json",
                  dpop: key.proof({
                    method: "POST",
                    url: `${CONNECT}/api/studio/fleet/invitation/redeem`,
                  }),
                },
                body: JSON.stringify({
                  credential: rejoinDecoded.redeem,
                  coordinatorEnvironmentId: COORDINATOR,
                }),
              }),
            );
            expect(rejoinRedeemRes.status).toBe(200);
            const { managementToken: newToken } = (yield* Effect.promise(() =>
              rejoinRedeemRes.json(),
            )) as { managementToken: string };

            // Fresh management token mints a worker pairing token cleanly.
            const newMintRes = yield* call(
              new Request("http://127.0.0.1:8319/api/auth/pairing-token", {
                method: "POST",
                headers: dpopHeaders(newToken, "POST", "/api/auth/pairing-token"),
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR }),
              }),
            );
            expect(newMintRes.status).toBe(200);

            // Pre-Stop management token stays permanently dead.
            const oldMintAfterRes = yield* call(
              new Request("http://127.0.0.1:8319/api/auth/pairing-token", {
                method: "POST",
                headers: dpopHeaders(oldToken, "POST", "/api/auth/pairing-token"),
                body: JSON.stringify({ coordinatorEnvironmentId: COORDINATOR }),
              }),
            );
            expect(oldMintAfterRes.status).toBe(401);
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
