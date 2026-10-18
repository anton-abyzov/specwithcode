// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses a real Node HTTP server and temporary homes.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  type AuthEnvironmentScope,
  ServerPrepareServiceUpdateError,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { Command } from "effect/cli";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { RpcServer } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as TestConsole from "effect/testing/TestConsole";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import {
  formatPrepareResult,
  prepareInputFromFlags,
  SESSION_LABEL,
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
) =>
  Effect.gen(function* () {
    const seen: Seen = { urls: [], scopes: [], payloads: [] };
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    const layerAuth = EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)));
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
      HttpRouter.serve(route, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(layerAuth),
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
        ),
      ),
      scope,
    );
    const address = Context.get(context, HttpServer.HttpServer).address;
    const port = NetAddress.isInetAddress(address) ? address.port : 0;
    yield* persistServerRuntimeState({
      path: config.serverRuntimeStatePath,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port,
      }),
    });
    return {
      seen,
      auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
      stop: Scope.close(scope, Exit.void),
    };
  });

const temporaryHome = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-prepare-update-test-"));

describe("service prepare-update input", () => {
  const flags = {
    stopWork: false,
    hold: false,
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
    }),
  );

  it.effect("refuses a hold without a drain and a release mixed with either", () =>
    Effect.gen(function* () {
      for (const bad of [
        { ...flags, hold: true },
        { ...flags, releaseHold: true, stopWork: true },
        { ...flags, releaseHold: true, hold: true, stopWork: true },
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
    "holds the running service over its socket with a short-lived maintain session",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const service = yield* startService(baseDir, () => Effect.succeed(heldResult));
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
        // Only the scope the RPC needs, through a ticket on the protocol the service speaks.
        assert.deepStrictEqual(service.seen.scopes, [[AuthEnvironmentMaintainScope]]);
        assert.isTrue((service.seen.urls[0]?.searchParams.get("wsTicket") ?? "").length > 0);
        assert.equal(service.seen.urls[0]?.searchParams.get("orchestrationProtocol"), "2");
        // The session is revoked once the call returns.
        const active = yield* service.auth.listSessions();
        assert.isFalse(active.some((session) => session.client.label === SESSION_LABEL));

        yield* runCli(["service", "prepare-update", "--base-dir", baseDir, "--release-hold"]);
        assert.deepStrictEqual(service.seen.payloads[1], { stopWork: false, releaseHold: true });
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
