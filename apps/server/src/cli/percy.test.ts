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
  EnvironmentId,
  PersonalLinkError,
  type PersonalLinkSetSharedInput,
  type PersonalLinkUndoInput,
  type PersonalShareStatus,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsPersonalShareRpcGroup,
} from "@specweave-studio/contracts";
import * as NetService from "@specweave-studio/shared/Net";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
import * as LocalCliCredential from "../auth/LocalCliCredential.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { FLEET_CONFIG_FILE } from "../studioFleet.ts";
import { resolveCliAuthConfig } from "./config.ts";
import { formatPercyStatus, PercyCommandError, resolveWithMachines } from "./percy.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return (
      (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ??
      ""
    );
  });

const laptop = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const desktop = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
const studio = EnvironmentId.make("33333333-3333-4333-8333-333333333333");
const unlisted = EnvironmentId.make("44444444-4444-4444-8444-444444444444");
const LINK_ID = "logical:percy:0123456789abcdef0123456776543210";

const fleet = [
  { id: "desktop", label: "Desktop", environmentId: desktop },
  { id: "studio", label: "Studio", environmentId: studio },
];

const offStatus: PersonalShareStatus = {
  enabled: false,
  environmentId: laptop,
  machineLabel: "Laptop",
  connectLinked: true,
  linkId: LINK_ID,
  projectId: null,
  assistantName: null,
  linked: false,
  members: [],
  routineOwner: true,
  start: false,
  machines: [],
  restorePoints: [],
  refusal: null,
};

const percyHere = ProjectId.make("proj-percy-laptop");
const percyThere = ProjectId.make("proj-percy-desktop");
const onStatus: PersonalShareStatus = {
  ...offStatus,
  enabled: true,
  projectId: percyHere,
  assistantName: "Percy",
  linked: true,
  start: true,
  members: [
    {
      environmentId: laptop,
      projectId: percyHere,
      coordinatorThreadId: ThreadId.make(`project-coordinator:${percyHere}`),
    },
    {
      environmentId: desktop,
      projectId: percyThere,
      coordinatorThreadId: ThreadId.make(`project-coordinator:${percyThere}`),
    },
  ],
  machines: [
    {
      environmentId: desktop,
      label: "Desktop",
      state: "joined",
      lastSyncedAt: "2026-11-20T10:05:00.000Z",
    },
    { environmentId: studio, label: "Studio", state: "switch_off" },
    { environmentId: unlisted, label: null, state: "older_version", detail: "It runs 1.0.400." },
  ],
  restorePoints: [
    {
      id: "rp-1",
      savedAt: "2026-11-20T09:00:00.000Z",
      reason: "before-link",
      memoryFileCount: 12,
    },
  ],
};

describe("percy --with", () => {
  it.effect("takes environment ids, and names that match exactly one machine", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveWithMachines(
          ["Desktop", `studio, ${unlisted}`, desktop],
          fleet,
          "specwithcode",
        ),
        [desktop, studio, unlisted],
      );
      // A name in any case, and an id of a machine that is not in this list.
      assert.deepStrictEqual(yield* resolveWithMachines(["STUDIO"], fleet, "specwithcode"), [
        studio,
      ]);
      assert.deepStrictEqual(yield* resolveWithMachines([" , "], fleet, "specwithcode"), []);
    }),
  );

  it.effect("asks for the id when a name matches no machine", () =>
    Effect.gen(function* () {
      const refused = yield* resolveWithMachines(["Garage"], fleet, "specwithcode").pipe(
        Effect.flip,
      );
      assert.instanceOf(refused, PercyCommandError);
      assert.strictEqual(
        refused.message,
        'No machine named "Garage" is in this machine\'s list (`specwithcode fleet list`). Give its environment id instead; `specwithcode percy status` on that machine shows it.',
      );
    }),
  );

  it.effect("asks for the id when a name matches two machines", () =>
    Effect.gen(function* () {
      const twins = [...fleet, { id: "desktop-2", label: "desktop", environmentId: unlisted }];
      const refused = yield* resolveWithMachines(["Desktop"], twins, "specwithcode").pipe(
        Effect.flip,
      );
      assert.strictEqual(
        refused.message,
        `"Desktop" names 2 machines in this machine's list. Give the environment id instead: ${desktop} (Desktop), ${unlisted} (desktop).`,
      );
    }),
  );
});

describe("percy status text", () => {
  it("says the machine, on or off, the link's last 8 characters and each machine's state", () => {
    const text = formatPercyStatus(onStatus, {
      json: false,
      cliName: "specwithcode",
      timeZone: "UTC",
    });
    assert.deepStrictEqual(text.split("\n"), [
      "Your Percy is on for Laptop.",
      `This machine's id: ${laptop}`,
      "Link: ...76543210, the same on every machine of your SpecWithCode Connect account.",
      "Assistant here: Percy, linked with 1 other machine.",
      "The link starts from this machine.",
      "Other machines:",
      `- Desktop (${desktop}): joined. Last in step November 20, 2026 at 10:05 AM.`,
      `- Studio (${studio}): its Percy switch is off.`,
      `- ${unlisted}: it runs a version without the shared Percy; update it. It runs 1.0.400.`,
      "Saved copies (`specwithcode percy undo --restore-point <id>` goes back to one):",
      "- rp-1: saved November 20, 2026 at 9:00 AM, before the link, 12 memory files.",
    ]);
    // The whole link id is never printed.
    assert.notInclude(text, LINK_ID);
  });

  it("says what is missing on a machine that is off and cannot be turned on", () => {
    const text = formatPercyStatus(
      { ...offStatus, connectLinked: false, linkId: null, refusal: "not_connected" },
      { json: false, cliName: "specwithcode" },
    );
    assert.deepStrictEqual(text.split("\n"), [
      "Your Percy is off for Laptop.",
      `This machine's id: ${laptop}`,
      "This machine is not linked to SpecWithCode Connect, so it has no link to join.",
      "This machine has no personal assistant yet; turning Percy on makes one.",
      "It cannot be turned on yet: this machine is not linked to SpecWithCode Connect.",
      "No other machine is confirmed here. Confirm one with `specwithcode percy on --with <machine>`.",
      "No copy of this machine's Percy has been saved yet.",
    ]);
  });

  it("prints the service's answer as one JSON line", () => {
    assert.deepStrictEqual(JSON.parse(formatPercyStatus(onStatus, { json: true })), onStatus);
  });
});

interface Seen {
  readonly scopes: Array<ReadonlyArray<AuthEnvironmentScope>>;
  readonly setShared: Array<PersonalLinkSetSharedInput>;
  readonly undo: Array<PersonalLinkUndoInput>;
  statusCalls: number;
}

interface Answers {
  readonly setShared?: (
    input: PersonalLinkSetSharedInput,
  ) => Effect.Effect<PersonalShareStatus, PersonalLinkError>;
  readonly undo?: (
    input: PersonalLinkUndoInput,
  ) => Effect.Effect<PersonalShareStatus, PersonalLinkError>;
}

/**
 * A `/ws` route that authenticates the upgrade as ws.ts does (the same
 * EnvironmentAuth on the same home), checks each call with the production
 * RpcAuthorization middleware, and answers the three share calls.
 */
const startService = (baseDir: string, answers: Answers = {}) =>
  Effect.gen(function* () {
    const seen: Seen = { scopes: [], setShared: [], undo: [], statusCalls: 0 };
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    // The service's own auth store, with the credential it publishes for the CLI at start.
    const layerAuth = LocalCliCredential.layer.pipe(
      Layer.provideMerge(EnvironmentAuth.layerRuntime),
      Layer.provide(ServerConfig.layer(config)),
    );
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
          label: "percy-test",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.1",
          capabilities: { repositoryIdentity: true },
        });
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("failed", { status: 500 }))),
    );
    const handlers = WsPersonalShareRpcGroup.toLayer({
      [WS_METHODS.personalLinkSetShared]: (input) => {
        seen.setShared.push(input);
        return (
          answers.setShared?.(input) ??
          Effect.succeed({ ...onStatus, enabled: input.enabled, start: input.start ?? false })
        );
      },
      [WS_METHODS.personalLinkShareStatus]: () => {
        seen.statusCalls += 1;
        return Effect.succeed(onStatus);
      },
      [WS_METHODS.personalLinkUndo]: (input) => {
        seen.undo.push(input);
        return answers.undo?.(input) ?? Effect.succeed(offStatus);
      },
    });
    const route = HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* auth.authenticateWebSocketUpgrade(request);
        seen.scopes.push(session.scopes);
        const httpEffect = yield* RpcServer.toHttpEffectWebsocket(WsPersonalShareRpcGroup).pipe(
          Effect.provide(
            Layer.mergeAll(
              handlers,
              // As ws.ts builds it: the session's scopes and whose key it is.
              RpcAuthorization.layer(session.scopes, session.principal),
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
    return { seen, stop: Scope.close(scope, Exit.void) };
  });

const temporaryHome = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-percy-test-"));

/** This machine's list of other machines, private as the service requires. */
const writeFleet = (baseDir: string) =>
  NodeFS.writeFileSync(
    NodePath.join(baseDir, FLEET_CONFIG_FILE),
    JSON.stringify({
      version: 1,
      machines: fleet.map((machine) => ({
        ...machine,
        url: `https://${machine.id}.example.ts.net`,
      })),
    }),
    { mode: 0o600 },
  );

describe("specwithcode percy", () => {
  it.effect(
    "turns the switch on as this machine's owner, naming machines by name or id",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        writeFleet(baseDir);
        const service = yield* startService(baseDir);
        yield* runCli([
          "percy",
          "on",
          "--base-dir",
          baseDir,
          "--with",
          "Desktop",
          "--with",
          `studio,${unlisted}`,
          "--start",
          "--name",
          "Percy",
        ]);
        assert.deepStrictEqual(service.seen.setShared, [
          { enabled: true, machines: [desktop, studio, unlisted], start: true, name: "Percy" },
        ]);
        // Through a ticket for the local command line's own session.
        assert.deepStrictEqual(service.seen.scopes, [AuthAdministrativeScopes]);
        const printed = (yield* TestConsole.logLines).join("\n");
        assert.include(printed, "Your Percy is on for Laptop.");
        assert.include(printed, "Link: ...76543210");
        assert.include(printed, `- Desktop (${desktop}): joined.`);
        assert.include(printed, "Machines link by themselves");

        // Without --with the confirmed machines are left as they are.
        yield* runCli(["percy", "on", "--base-dir", baseDir]);
        assert.deepStrictEqual(service.seen.setShared[1], { enabled: true });
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "does not call the service when a name matches no machine",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        writeFleet(baseDir);
        const service = yield* startService(baseDir);
        const error = yield* runCli([
          "percy",
          "on",
          "--base-dir",
          baseDir,
          "--with",
          "Garage",
        ]).pipe(Effect.flip);
        assert.instanceOf(error, PercyCommandError);
        assert.include(error.message, 'No machine named "Garage"');
        assert.deepStrictEqual(service.seen.setShared, []);
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "fails with the refusal's own sentence",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const sentence =
          "This machine is not linked to SpecWithCode Connect, so it cannot use your Percy.";
        const service = yield* startService(baseDir, {
          setShared: () =>
            Effect.fail(new PersonalLinkError({ code: "not_connected", message: sentence })),
          undo: () =>
            Effect.fail(
              new PersonalLinkError({
                code: "no_restore_point",
                message: "This machine has no saved copy of Percy to go back to.",
              }),
            ),
        });
        const refused = yield* runCli(["percy", "on", "--base-dir", baseDir]).pipe(Effect.flip);
        assert.instanceOf(refused, PercyCommandError);
        assert.strictEqual(refused.message, sentence);
        assert.strictEqual(refused.code, "not_connected");

        const noCopy = yield* runCli([
          "percy",
          "undo",
          "--base-dir",
          baseDir,
          "--restore-point",
          "rp-1",
        ]).pipe(Effect.flip);
        assert.instanceOf(noCopy, PercyCommandError);
        assert.strictEqual(
          noCopy.message,
          "This machine has no saved copy of Percy to go back to.",
        );
        assert.deepStrictEqual(service.seen.undo, [{ restorePointId: "rp-1" }]);
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "turns the switch off, reports status as JSON and undoes to the newest copy",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const service = yield* startService(baseDir);
        yield* runCli(["percy", "off", "--base-dir", baseDir]);
        assert.deepStrictEqual(service.seen.setShared, [{ enabled: false }]);
        assert.include(
          (yield* TestConsole.logLines).join("\n"),
          "This machine keeps its own memory and chats",
        );

        const json = yield* runCli(["percy", "status", "--base-dir", baseDir, "--json"]);
        assert.deepStrictEqual(JSON.parse(json), onStatus);
        assert.strictEqual(service.seen.statusCalls, 1);

        yield* runCli(["percy", "undo", "--base-dir", baseDir]);
        assert.deepStrictEqual(service.seen.undo, [{}]);
        yield* service.stop;
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );

  it.effect(
    "says so when no service runs for the home",
    () =>
      Effect.gen(function* () {
        const baseDir = temporaryHome();
        const error = yield* runCli(["percy", "status", "--base-dir", baseDir]).pipe(Effect.flip);
        assert.instanceOf(error, PercyCommandError);
        assert.include(error.message, "SpecWithCode is not running for");
      }).pipe(Effect.provide(layerCliRuntime)),
    60_000,
  );
});
