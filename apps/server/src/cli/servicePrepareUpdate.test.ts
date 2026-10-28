// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses a real Node HTTP server and temporary homes.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  ServerPrepareServiceUpdateError,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { RpcServer } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as TestConsole from "effect/testing/TestConsole";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as LocalCliCredential from "../auth/LocalCliCredential.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import { LiveServiceCredentialError } from "./liveService.ts";
import {
  formatPrepareResult,
  prepareInputFromFlags,
  ServicePrepareUpdateCallError,
  ServicePrepareUpdateNotRunningError,
  serviceWebSocketUrl,
} from "./servicePrepareUpdate.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  });

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

/** The service's group narrowed to the one RPC, so the test serves only it. */
const PrepareGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<WsRpcMethod, typeof WS_METHODS.serverPrepareServiceUpdate> =>
      tag !== WS_METHODS.serverPrepareServiceUpdate,
  ),
);

const heldResult: ServerPrepareServiceUpdateResult = {
  idle: true,
  stoppedThreads: 2,
  blockers: [],
  held: true,
  holdUntil: "2026-10-16T12:15:00.000Z",
  holdReason: "install",
  interruptedRuns: 1,
  openTerminals: 0,
};

interface Seen {
  readonly urls: Array<URL>;
  readonly scopes: Array<ReadonlyArray<AuthEnvironmentScope>>;
  readonly payloads: Array<ServerPrepareServiceUpdateInput>;
}

/**
 * A `/ws` route that authenticates the upgrade as ws.ts does (the same
 * EnvironmentAuth on the same home), checks each call's scope with the
 * production RpcAuthorization middleware, and answers prepareServiceUpdate.
 */
const startService = (
  baseDir: string,
  answer: (
    input: ServerPrepareServiceUpdateInput,
  ) => Effect.Effect<ServerPrepareServiceUpdateResult, ServerPrepareServiceUpdateError>,
  options?: { readonly publishCliCredential?: boolean },
) =>
  Effect.gen(function* () {
    const seen: Seen = { urls: [], scopes: [], payloads: [] };
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    // The service's own auth store, with the credential it publishes for the CLI at start.
    const layerAuth = (
      options?.publishCliCredential === false
        ? EnvironmentAuth.layerRuntime
        : LocalCliCredential.layer.pipe(Layer.provideMerge(EnvironmentAuth.layerRuntime))
    ).pipe(Layer.provide(ServerConfig.layer(config)));
    // `/api/auth/websocket-ticket` as auth/http.ts answers it: a bearer session in, a ticket out.
    const ticketRoute = HttpRouter.add(
      "POST",
      "/api/auth/websocket-ticket",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
        const sessions = yield* SessionStore.SessionStore;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* sessions.verify(bearer);
        const ticket = yield* auth.issueWebSocketTicket({ sessionId: session.sessionId });
        return yield* HttpServerResponse.json({
          ticket: ticket.ticket,
          expiresAt: ticket.expiresAt.toJSON(),
        });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("denied", { status: 401 }))),
    );
    // The environment descriptor, which the CLI checks before it sends its token.
    const descriptorRoute = HttpRouter.add(
      "GET",
      "/.well-known/studio/environment",
      Effect.gen(function* () {
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        return yield* HttpServerResponse.json({
          environmentId: yield* identity.getEnvironmentId,
          label: "prepare-update-test",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.1",
          capabilities: { repositoryIdentity: true },
        });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("failed", { status: 500 }))),
    );
    const handlers = PrepareGroup.toLayerHandler(WS_METHODS.serverPrepareServiceUpdate, (input) => {
      seen.payloads.push(input);
      return answer(input);
    });
    const route = HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isSome(url)) seen.urls.push(url.value);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* auth.authenticateWebSocketUpgrade(request);
        seen.scopes.push(session.scopes);
        const httpEffect = yield* RpcServer.toHttpEffectWebsocket(PrepareGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              handlers,
              RpcAuthorization.layer(session.scopes),
              RpcSerialization.layerJson,
            ),
          ),
        );
        return yield* httpEffect;
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("denied", { status: 401 }))),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      HttpRouter.serve(Layer.mergeAll(route, ticketRoute, descriptorRoute), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provideMerge(layerAuth),
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
      scope,
    );
    const address = Context.get(context, HttpServer.HttpServer).address;
    const port = NetAddress.isInetAddress(address) ? address.port : 0;
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port,
    });
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      // A real start time: the CLI checks this process started before it was recorded,
      // and the test clock would record 1970.
      state: { ...state, startedAt: DateTime.formatIso(DateTime.nowUnsafe()) },
    });
    const sql = Context.get(context, SqlClient.SqlClient);
    return {
      seen,
      /**
       * Every auth_sessions row, without `last_connected_at`: the cells update.py's
       * prestate (auth_invariant_hash) compares between snapshot and apply. Once #466
       * lands it leaves out `client_app_version` as well, while `client_surface` stays
       * guarded; both stay here, which also shows this command's connect leaves them unset.
       */
      guardedSessionRows: sql
        .unsafe<Record<string, unknown>>(
          "SELECT * FROM auth_sessions ORDER BY issued_at, session_id",
        )
        .pipe(
          Effect.map((rows) =>
            rows.map(({ last_connected_at: _heartbeat, ...guarded }) => guarded),
          ),
        ),
      stop: Scope.close(scope, Exit.void),
    };
  });

const temporaryHome = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-prepare-update-test-"));

describe("service prepare-update input", () => {
  const flags = {
    stopWork: false,
    hold: false,
    ifIdle: false,
    releaseHold: false,
    reason: Option.none(),
  } as const;

  it.effect("sends what Update now and Cancel update send", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* prepareInputFromFlags({
          ...flags,
          stopWork: true,
          hold: true,
          reason: Option.some("install"),
        }),
        { stopWork: true, hold: true, reason: "install" },
      );
      assert.deepStrictEqual(yield* prepareInputFromFlags({ ...flags, releaseHold: true }), {
        stopWork: false,
        releaseHold: true,
      });
      assert.deepStrictEqual(yield* prepareInputFromFlags(flags), { stopWork: false });
      assert.deepStrictEqual(yield* prepareInputFromFlags({ ...flags, hold: true, ifIdle: true }), {
        stopWork: false,
        hold: true,
        ifIdle: true,
      });
    }),
  );

  it.effect("refuses a hold without a drain and a release mixed with either", () =>
    Effect.gen(function* () {
      for (const bad of [
        { ...flags, hold: true },
        { ...flags, releaseHold: true, stopWork: true },
        { ...flags, releaseHold: true, hold: true, stopWork: true },
        // --if-idle stops nothing and needs --hold.
        { ...flags, ifIdle: true },
        { ...flags, ifIdle: true, hold: true, stopWork: true },
      ]) {
        const error = yield* prepareInputFromFlags(bad).pipe(Effect.flip);
        assert.equal(error._tag, "ServicePrepareUpdateUsageError");
      }
    }),
  );

  it("connects to the service's /ws with the ticket and the orchestration protocol", () => {
    const url = new URL(serviceWebSocketUrl("http://127.0.0.1:8319", "ticket.signature"));
    assert.equal(url.protocol, "ws:");
    assert.equal(url.host, "127.0.0.1:8319");
    assert.equal(url.pathname, "/ws");
    assert.equal(url.searchParams.get("wsTicket"), "ticket.signature");
    assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
  });

  it("prints the service's answer as one JSON line", () => {
    assert.deepStrictEqual(JSON.parse(formatPrepareResult(heldResult, { json: true })), heldResult);
    assert.include(formatPrepareResult(heldResult, { json: false }), "held for the update");
  });
});

describe("specweave-studio service prepare-update", () => {
  it.effect(
    "holds the running service over its socket with the CLI credential it published, writing no row",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const service = yield* startService(baseDir, () => Effect.succeed(heldResult));
        // The service issued its CLI session in memory: a start writes no auth row
        // (update.py's post-restart proof requires the same session identities).
        const beforeHold = yield* service.guardedSessionRows;
        assert.lengthOf(beforeHold, 0);
        assert.isTrue(
          NodeFS.existsSync(
            NodePath.join(
              baseDir,
              "userdata",
              "secrets",
              `${LocalCliCredential.LOCAL_CLI_CREDENTIAL_SECRET}.bin`,
            ),
          ),
        );

        const output = yield* runCli([
          "service",
          "prepare-update",
          "--base-dir",
          baseDir,
          "--stop-work",
          "--hold",
          "--reason",
          "install",
          "--json",
        ]);
        assert.deepStrictEqual(JSON.parse(output), heldResult);
        assert.deepStrictEqual(service.seen.payloads, [
          { stopWork: true, hold: true, reason: "install" },
        ]);
        // Through a ticket for the CLI session, on the protocol the service speaks.
        assert.deepStrictEqual(service.seen.scopes, [AuthAdministrativeScopes]);
        assert.isTrue((service.seen.urls[0]?.searchParams.get("wsTicket") ?? "").length > 0);
        assert.equal(service.seen.urls[0]?.searchParams.get("orchestrationProtocol"), "2");
        // The two parameters that make ws.ts record client metadata in the session row.
        assert.isNull(service.seen.urls[0]?.searchParams.get("clientSurface"));
        assert.isNull(service.seen.urls[0]?.searchParams.get("clientAppVersion"));

        yield* runCli(["service", "prepare-update", "--base-dir", baseDir, "--release-hold"]);
        assert.deepStrictEqual(service.seen.payloads[1], { stopWork: false, releaseHold: true });
        // The CLI wrote nothing: the one row is unchanged in every guarded cell
        // (update.py's prestate compares them between snapshot and apply).
        assert.deepStrictEqual(yield* service.guardedSessionRows, beforeHold);
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "says the running service published no CLI credential instead of opening its database",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const service = yield* startService(baseDir, () => Effect.succeed(heldResult), {
          publishCliCredential: false,
        });
        const before = yield* service.guardedSessionRows;
        const error = yield* runCli([
          "service",
          "prepare-update",
          "--base-dir",
          baseDir,
          "--stop-work",
          "--json",
        ]).pipe(Effect.flip);
        assert.instanceOf(error, LiveServiceCredentialError);
        assert.include(error.message, "has not published a credential for this CLI");
        assert.deepStrictEqual(service.seen.payloads, []);
        assert.deepStrictEqual(yield* service.guardedSessionRows, before);
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "fails with the service's own message when it cannot prepare",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const service = yield* startService(baseDir, () =>
          Effect.fail(
            new ServerPrepareServiceUpdateError({
              message: "Could not check what is still running.",
            }),
          ),
        );
        const error = yield* runCli([
          "service",
          "prepare-update",
          "--base-dir",
          baseDir,
          "--stop-work",
          "--hold",
          "--json",
        ]).pipe(Effect.flip);
        assert.instanceOf(error, ServicePrepareUpdateCallError);
        assert.include(error.message, "Could not check what is still running.");
        // With --json the reason is also the last stdout line, for the script that asked.
        const printed = (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        );
        assert.include(JSON.parse(printed ?? "{}").error, "Could not check what is still running.");
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "says so when no service runs for the home, and leaves the home as it is",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const error = yield* runCli([
          "service",
          "prepare-update",
          "--base-dir",
          baseDir,
          "--stop-work",
          "--hold",
          "--json",
        ]).pipe(Effect.flip);
        assert.instanceOf(error, ServicePrepareUpdateNotRunningError);
        // No auth store, secret or session was made for a home no service runs from: only the
        // empty folders every command's config makes.
        const files = NodeFS.readdirSync(baseDir, { recursive: true, withFileTypes: true })
          .filter((entry) => !entry.isDirectory())
          .map((entry) => entry.name);
        assert.deepStrictEqual(files, []);
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );
});
