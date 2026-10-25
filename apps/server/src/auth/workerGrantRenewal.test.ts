import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  EnvironmentHttpApi,
  type RuntimeMode,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as AuthHttp from "./http.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./utils.ts";

const environmentId = EnvironmentId.make("destination");
const coordinatorEnvironmentId = EnvironmentId.make("coordinator");
const layerIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const originalInput = {
  principal: { kind: "coordinator", environmentId: coordinatorEnvironmentId },
  subject: "mcp-client",
  method: "bearer-access-token",
  ttl: Duration.seconds(1),
  scopes: ["orchestration:read", "orchestration:operate"],
  runtimeModeCeiling: "approval-required",
  client: { label: "SpecWithCode workers · coordinator", deviceType: "bot" },
} as const;
const request = (accessToken: string) => ({ accessToken, environmentId, coordinatorEnvironmentId });
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-worker-renewal-" });
const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(layerIdentity),
  Layer.provide(layerConfig),
);
const claimsOf = (token: string) => JSON.parse(base64UrlDecodeUtf8(token.split(".")[0]!));
const signClaims = (token: string, changes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
    const payload = base64UrlEncode(JSON.stringify({ ...claimsOf(token), ...changes }));
    return `${payload}.${signPayload(payload, secret)}`;
  });

it.layer(NodeServices.layer)("worker grant renewal", (it) => {
  it.effect(
    "recovers expired grants without weakening normal verification or increasing any runtime ceiling",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const repository = yield* AuthSessions.AuthSessionRepository;
        for (const runtimeModeCeiling of [
          "approval-required",
          "auto-accept-edits",
          "auto",
          "full-access",
        ] satisfies RuntimeMode[]) {
          const original = yield* sessions.issue({ ...originalInput, runtimeModeCeiling });
          yield* TestClock.adjust("2 seconds");
          expect((yield* Effect.flip(sessions.verify(original.token)))._tag).toBe(
            "SessionTokenExpiredError",
          );
          const renewed = yield* sessions.renewWorkerGrant(request(original.token));
          const claims = claimsOf(renewed.accessToken);
          expect(claims).toEqual({
            ...claimsOf(original.token),
            exp: renewed.expiresAt.epochMilliseconds,
          });
          expect((yield* sessions.verify(renewed.accessToken)).runtimeModeCeiling).toBe(
            runtimeModeCeiling,
          );
          const row = Option.getOrThrow(
            yield* repository.getById({ sessionId: original.sessionId }),
          );
          expect(row.expiresAt).toEqual(renewed.expiresAt);
          expect(row.principal).toEqual(originalInput.principal);
          expect((yield* Effect.flip(sessions.verify(original.token)))._tag).toBe(
            "SessionTokenExpiredError",
          );
          yield* sessions.revoke(original.sessionId);
          expect((yield* Effect.flip(sessions.verify(renewed.accessToken)))._tag).toBe(
            "SessionTokenRevokedError",
          );
          expect(
            yield* Effect.flip(sessions.renewWorkerGrant(request(original.token))),
          ).toMatchObject({ code: "grant_revoked" });
        }
      }).pipe(Effect.provide(layerAuth)),
  );

  it.effect("publishes the recovered row to already subscribed access observers", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const original = yield* sessions.issue(originalInput);
      yield* TestClock.adjust("2 seconds");
      expect(yield* sessions.listActive()).toEqual([]);
      const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
      yield* sessions.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const renewed = yield* sessions.renewWorkerGrant(request(original.token));
      yield* Effect.yieldNow;
      const event = yield* Queue.poll(changes);
      expect(Option.isSome(event)).toBe(true);
      expect(Option.getOrThrow(event)).toMatchObject({
        type: "clientUpserted",
        clientSession: {
          sessionId: original.sessionId,
          expiresAt: renewed.expiresAt,
          client: originalInput.client,
          current: false,
          connected: false,
        },
      });
      yield* sessions.revoke(original.sessionId);
      expect(yield* Queue.take(changes)).toEqual({
        type: "clientRemoved",
        sessionId: original.sessionId,
      });
      expect(yield* sessions.listActive()).toEqual([]);
    }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );

  it.effect("publishes removal when revocation wins before the renewed row is reloaded", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const original = yield* sessions.issue(originalInput);
      yield* TestClock.adjust("2 seconds");
      const racedRepository = {
        ...repository,
        renewWorker: (input: AuthSessions.RenewWorkerAuthSessionInput) =>
          repository.renewWorker(input).pipe(
            Effect.tap(() =>
              repository.revoke({
                sessionId: input.sessionId,
                revokedAt: DateTime.makeUnsafe(2000),
              }),
            ),
          ),
      };
      const raced = yield* SessionStore.make.pipe(
        Effect.provideService(AuthSessions.AuthSessionRepository, racedRepository),
        Effect.provide(Layer.merge(layerIdentity, layerConfig)),
      );
      const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
      yield* raced.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const renewed = yield* raced.renewWorkerGrant(request(original.token));
      expect(yield* Queue.take(changes)).toEqual({
        type: "clientRemoved",
        sessionId: original.sessionId,
      });
      expect((yield* Effect.flip(raced.verify(renewed.accessToken)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect(yield* raced.listActive()).toEqual([]);
    }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );

  it.effect("orders concurrent removal after any in-flight recovery snapshot", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const original = yield* sessions.issue(originalInput);
      yield* TestClock.adjust("2 seconds");
      const readSnapshot = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const revokeCommitted = yield* Deferred.make<void>();
      let renewed = false;
      let intercepted = false;
      const racedRepository = {
        ...repository,
        renewWorker: (input: AuthSessions.RenewWorkerAuthSessionInput) =>
          repository.renewWorker(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                renewed = true;
              }),
            ),
          ),
        getById: (input: AuthSessions.GetAuthSessionByIdInput) =>
          repository.getById(input).pipe(
            Effect.flatMap((row) => {
              if (!renewed || intercepted) return Effect.succeed(row);
              intercepted = true;
              return Deferred.succeed(readSnapshot, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
                Effect.as(row),
              );
            }),
          ),
        revoke: (input: AuthSessions.RevokeAuthSessionInput) =>
          repository
            .revoke(input)
            .pipe(Effect.tap(() => Deferred.succeed(revokeCommitted, undefined))),
      };
      const raced = yield* SessionStore.make.pipe(
        Effect.provideService(AuthSessions.AuthSessionRepository, racedRepository),
        Effect.provide(Layer.merge(layerIdentity, layerConfig)),
      );
      const changes = yield* Queue.unbounded<SessionStore.SessionCredentialChange>();
      yield* raced.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const renewal = yield* raced
        .renewWorkerGrant(request(original.token))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(readSnapshot);
      const revocation = yield* raced
        .revoke(original.sessionId)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(revokeCommitted);
      yield* Deferred.succeed(releaseSnapshot, undefined);
      const result = yield* Fiber.join(renewal);
      expect(yield* Fiber.join(revocation)).toBe(true);
      expect(yield* Queue.take(changes)).toMatchObject({
        type: "clientUpserted",
        clientSession: { sessionId: original.sessionId },
      });
      expect(yield* Queue.take(changes)).toEqual({
        type: "clientRemoved",
        sessionId: original.sessionId,
      });
      expect((yield* Effect.flip(raced.verify(result.accessToken)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect(yield* raced.listActive()).toEqual([]);
    }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );

  it.effect(
    "rejects invalid signatures, audiences, methods, bindings, scopes, ceiling, identity and row claims",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const original = yield* sessions.issue(originalInput);
        const invalidTokens = [
          "garbage",
          `${original.token}.extra`,
          original.token.replace(/.$/, "!"),
          yield* signClaims(original.token, { sub: "browser" }),
          yield* signClaims(original.token, { method: "browser-session-cookie" }),
          yield* signClaims(original.token, { method: "dpop-access-token" }),
          yield* signClaims(original.token, { jkt: "proof-binding" }),
          yield* signClaims(original.token, { jkt: "" }),
          yield* signClaims(original.token, { scopes: ["orchestration:read"] }),
          yield* signClaims(original.token, { scopes: [...originalInput.scopes, "access:write"] }),
          yield* signClaims(original.token, {
            scopes: ["orchestration:read", "orchestration:read"],
          }),
          yield* signClaims(original.token, { rtc: undefined }),
          yield* signClaims(original.token, { rtc: "unknown" }),
          yield* signClaims(original.token, { iat: claimsOf(original.token).iat + 1 }),
          yield* signClaims(original.token, { exp: claimsOf(original.token).iat }),
        ];
        for (const token of invalidTokens)
          expect(yield* Effect.flip(sessions.renewWorkerGrant(request(token)))).toMatchObject({
            code: "grant_invalid",
          });
        for (const change of [
          { environmentId: EnvironmentId.make("wrong-destination") },
          { coordinatorEnvironmentId: EnvironmentId.make("wrong-coordinator") },
          { coordinatorEnvironmentId: EnvironmentId.make("coordinator".repeat(20)) },
        ])
          expect(
            yield* Effect.flip(
              sessions.renewWorkerGrant({ ...request(original.token), ...change }),
            ),
          ).toMatchObject({ code: "grant_invalid" });
        const sql = yield* SqlClient.SqlClient;
        for (const [column, value] of [
          ["subject", "other"],
          ["method", "browser-session-cookie"],
          ["scopes", '["orchestration:read"]'],
          ["principal", JSON.stringify({ kind: "coordinator", environmentId: "other" })],
        ] as const) {
          const issued = yield* sessions.issue(originalInput);
          yield* sql`UPDATE auth_sessions SET ${sql(column)} = ${value} WHERE session_id = ${issued.sessionId}`;
          expect(
            yield* Effect.flip(sessions.renewWorkerGrant(request(issued.token))),
          ).toMatchObject({ code: "grant_invalid" });
        }
      }).pipe(Effect.provide(layerAuth)),
  );

  it.effect(
    "distinguishes missing/revoked expired originals and prevents a read/update revocation race",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const repository = yield* AuthSessions.AuthSessionRepository;
        const sql = yield* SqlClient.SqlClient;
        const missing = yield* sessions.issue(originalInput);
        yield* sql`DELETE FROM auth_sessions WHERE session_id = ${missing.sessionId}`;
        expect(yield* Effect.flip(sessions.renewWorkerGrant(request(missing.token)))).toMatchObject(
          { code: "grant_missing" },
        );
        const original = yield* sessions.issue(originalInput);
        yield* TestClock.adjust("2 seconds");
        const racedRepository = {
          ...repository,
          renewWorker: (input: AuthSessions.RenewWorkerAuthSessionInput) =>
            repository
              .revoke({ sessionId: input.sessionId, revokedAt: DateTime.makeUnsafe(2000) })
              .pipe(Effect.andThen(repository.renewWorker(input))),
        };
        const racedSessions = yield* SessionStore.make.pipe(
          Effect.provideService(AuthSessions.AuthSessionRepository, racedRepository),
          Effect.provide(Layer.merge(layerIdentity, layerConfig)),
        );
        expect(
          yield* Effect.flip(racedSessions.renewWorkerGrant(request(original.token))),
        ).toMatchObject({ code: "grant_revoked" });
        expect(
          (yield* repository.getById({ sessionId: original.sessionId })).pipe(Option.getOrThrow)
            .expiresAt,
        ).toEqual(original.expiresAt);
        expect(yield* sql`SELECT session_id FROM auth_sessions`).toHaveLength(1);
      }).pipe(Effect.provide(layerAuth)),
  );

  it.effect(
    "renews after reopening the same durable store and keeps revocation across reopening",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-worker-reopen-" });
        const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });
        yield* ServerConfig.ensureServerDirectories(paths);
        const diskLayer = () =>
          SessionStore.layer.pipe(
            Layer.provide(SqlitePersistence.layerFromPath(paths.dbPath)),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(layerIdentity),
            Layer.provide(
              Layer.effect(
                ServerConfig.ServerConfig,
                Effect.gen(function* () {
                  return { ...(yield* ServerConfig.ServerConfig), ...paths, baseDir };
                }),
              ).pipe(Layer.provide(layerConfig)),
            ),
          );
        const original = yield* Effect.gen(function* () {
          return yield* (yield* SessionStore.SessionStore).issue(originalInput);
        }).pipe(Effect.provide(diskLayer()), Effect.scoped);
        yield* TestClock.adjust("2 seconds");
        const renewed = yield* Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          expect((yield* Effect.flip(sessions.verify(original.token)))._tag).toBe(
            "SessionTokenExpiredError",
          );
          return yield* sessions.renewWorkerGrant(request(original.token));
        }).pipe(Effect.provide(diskLayer()), Effect.scoped);
        yield* Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          expect((yield* sessions.verify(renewed.accessToken)).sessionId).toBe(original.sessionId);
          yield* sessions.revoke(original.sessionId);
        }).pipe(Effect.provide(diskLayer()), Effect.scoped);
        yield* Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          expect(
            yield* Effect.flip(sessions.renewWorkerGrant(request(original.token))),
          ).toMatchObject({ code: "grant_revoked" });
          expect((yield* Effect.flip(sessions.verify(renewed.accessToken)))._tag).toBe(
            "SessionTokenRevokedError",
          );
        }).pipe(Effect.provide(diskLayer()), Effect.scoped);
      }),
  );

  it.effect(
    "enforces current management authority on the real HTTP route, independently of grant errors",
    () =>
      Effect.gen(function* () {
        const now = yield* TestClock.withLive(Clock.currentTimeMillis);
        yield* TestClock.setTime(now);
        const crypto = yield* Crypto.Crypto;
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        const context = yield* Layer.build(layerAuth);
        const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
        const sessions = Context.get(context, SessionStore.SessionStore);
        const original = yield* sessions.issue(originalInput);
        // Keep a well-formed historical issuance interval while making the token expired.
        const expiredToken = yield* signClaims(original.token, {
          iat: now - 10000,
          exp: now - 1000,
        }).pipe(Effect.provide(context));
        const sql = Context.get(context, SqlClient.SqlClient);
        yield* sql`UPDATE auth_sessions SET issued_at = ${DateTime.formatIso(DateTime.makeUnsafe(claimsOf(expiredToken).iat))} WHERE session_id = ${original.sessionId}`;
        const full = yield* auth.issueSession({
          scopes: ["access:write", ...originalInput.scopes],
        });
        const managementScopes: ReadonlyArray<AuthEnvironmentScope> = [
          "access:write",
          ...originalInput.scopes,
        ];
        const restricted = yield* Effect.forEach(managementScopes, (omitted) =>
          auth.issueSession({
            scopes: managementScopes.filter((scope) => scope !== omitted),
          }),
        );
        const expiredManagement = yield* auth.issueSession({ ttl: Duration.millis(-1) });
        const revokedManagement = yield* auth.issueSession({
          scopes: ["access:write", ...originalInput.scopes],
        });
        yield* sessions.revoke(revokedManagement.sessionId);
        class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
        const routes = HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (handler) =>
            Effect.tryPromise(async () => {
              const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
                Context.add(
                  ServerSecretStore.ServerSecretStore,
                  Context.get(context, ServerSecretStore.ServerSecretStore),
                ),
              );
              const call = (token?: string, body = request(expiredToken)) =>
                handler.handler(
                  new Request("http://127.0.0.1/api/auth/worker-grants/renew", {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      ...(token ? { authorization: `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify(body),
                  }),
                  requestContext,
                );
              for (const token of [
                undefined,
                "invalid",
                expiredManagement.token,
                revokedManagement.token,
                original.token,
              ]) {
                const response = await call(token);
                expect(response.status).toBe(401);
                expect(await response.json()).toMatchObject({ code: "auth_invalid" });
              }
              for (const credential of restricted) {
                const response = await call(credential.token);
                expect(response.status).toBe(403);
                expect(await response.json()).toMatchObject({ code: "insufficient_scope" });
              }
              const invalid = await call(full.token, request("not-a-grant"));
              expect(invalid.status).toBe(400);
              expect(await invalid.json()).toMatchObject({ code: "grant_invalid" });
              const success = await call(full.token);
              expect(success.status).toBe(200);
              expect(success.headers.get("cache-control")).toBe("no-store");
              const renewed = await Schema.decodeUnknownPromise(
                Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.String }),
              )(await success.json());
              expect(typeof renewed.expiresAt).toBe("string");
              expect(claimsOf(renewed.accessToken).sid).toBe(original.sessionId);
              await run(sessions.revoke(original.sessionId));
              const revoked = await call(full.token);
              expect(revoked.status).toBe(409);
              expect(await revoked.json()).toMatchObject({ code: "grant_revoked" });
              const missingToken = await run(
                signClaims(expiredToken, { sid: AuthSessionId.make("missing") }).pipe(
                  Effect.provide(context),
                ),
              );
              const missing = await call(full.token, request(missingToken));
              expect(missing.status).toBe(409);
              expect(await missing.json()).toMatchObject({ code: "grant_missing" });
            }),
          (handler) => Effect.promise(() => handler.dispose()),
        );
      }).pipe(Effect.scoped),
  );
});
