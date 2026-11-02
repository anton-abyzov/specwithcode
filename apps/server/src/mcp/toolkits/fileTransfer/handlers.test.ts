// @effect-diagnostics nodeBuiltinImport:off - real files in a temporary folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { RuntimeMode } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../../../config.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant } from "../../../fleet/workGrantPolicy.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { withoutFileBytes } from "../../../observability/Observability.ts";
import { layer as handlers } from "./handlers.ts";
import { FileTransferToolkit } from "./tools.ts";

const callerId = ThreadId.make("worker");
const projectId = ProjectId.make("project");
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };

let root: string;
let local: string;
let remote: string;
let localProject: string;
let remoteProject: string;

beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-transfer-")));
  local = NodePath.join(root, "local");
  remote = NodePath.join(root, "remote");
  localProject = NodePath.join(root, "local-project");
  remoteProject = NodePath.join(root, "remote-project");
  NodeFS.mkdirSync(localProject, { recursive: true });
  NodeFS.mkdirSync(remoteProject, { recursive: true });
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

interface Machine {
  readonly base: string;
  readonly project: string;
}

const machineServices = (machine: Machine, worktreePath?: string, runtimeMode?: RuntimeMode) => {
  const shell = {
    id: projectId,
    title: "project",
    workspaceRoot: machine.project,
    workspaceSettings: { kind: "code" },
  };
  return Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, {
      baseDir: machine.base,
      stateDir: NodePath.join(machine.base, "userdata"),
      worktreesDir: NodePath.join(machine.base, "worktrees"),
    } as never),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some(shell)) as never,
      listShells: () => Effect.succeed([shell]) as never,
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          ...liveThreadShell(callerId, runtimeMode === undefined ? {} : { runtimeMode }),
          projectId,
          ...(worktreePath === undefined ? {} : { worktreePath }),
        }),
    }),
  );
};

const toolkitFor = (
  machine: Machine,
  input: {
    readonly scope: Partial<McpInvocationContext.McpInvocationScope>;
    readonly grant: ReturnType<typeof unscopedGrant> | undefined;
    readonly origin?: boolean;
    readonly proxy?: RemoteWorkers.RemoteWorkersShape["proxy"];
    readonly approved?: ProjectActionRequests.SecretTransfer;
    readonly cards?: ProjectActionRequests.ProjectActionRequestInput[];
    readonly worktreePath?: string;
    readonly runtimeMode?: RuntimeMode;
  },
) => {
  const services = Layer.mergeAll(
    machineServices(machine, input.worktreePath, input.runtimeMode),
    NodeServices.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env"),
      requestNamespace: "test",
      issuedAt: 1,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread: undefined,
      ...input.scope,
    }),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...WorkGrants.WorkGrants.defaultValue(),
      enabled: true,
      forClient: () => Effect.succeed(input.grant),
      originOf: () =>
        Effect.succeed(
          input.origin === true
            ? ({ coordinatorEnvironmentId: EnvironmentId.make("env-m4") } as never)
            : undefined,
        ),
      forCoordinator: (id) => Effect.succeed(unscopedGrant(id)),
    }),
    Layer.succeed(RemoteWorkers.RemoteWorkers, {
      ...RemoteWorkers.RemoteWorkers.defaultValue(),
      machineLabels: Effect.succeed(new Map([[EnvironmentId.make("env-m4"), "M4"]])),
      resolveMachine: () => Effect.succeed({ kind: "remote", machine: M1 } as never),
      ...(input.proxy ? { proxy: input.proxy } : {}),
    } as never),
    Layer.mock(ProjectActionRequests.ProjectActionRequests)({
      request: (card) => {
        input.cards?.push(card);
        return Effect.succeed({ requestId: RuntimeRequestId.make("project-action:card") });
      },
      useSecretTransfer: () => Effect.succeed(input.approved),
    }),
  );
  return (tool: string, args: Record<string, unknown>) =>
    FileTransferToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(handlers).pipe(Layer.provide(services))),
      Effect.flatMap((toolkit) =>
        (
          toolkit.handle as unknown as (
            name: string,
            params: unknown,
          ) => Effect.Effect<Stream.Stream<unknown>>
        )(tool, args).pipe(Stream.unwrap, Stream.runCollect, Effect.provide(services)),
      ),
      Effect.map(
        (results) => (results.at(-1) as unknown as { result: Record<string, unknown> }).result,
      ),
    );
};

const remoteMachine = () => ({ base: remote, project: remoteProject });
const localMachine = () => ({ base: local, project: localProject });
const thread = {
  thread: {
    threadId: callerId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "s",
  },
};

/** The other machine, reached the way a real call reaches it: its own toolkit, under a grant. */
const overTheFleet = (seen: Array<Record<string, unknown>> = []) => {
  const target = toolkitFor(remoteMachine(), {
    scope: { client: { sessionId: "s", label: "M4", access: "full-access" } },
    grant: unscopedGrant(EnvironmentId.make("env-m4")),
  });
  const proxy: RemoteWorkers.RemoteWorkersShape["proxy"] = (request) => {
    seen.push(request.arguments);
    return target(request.tool, request.arguments).pipe(
      Effect.flatMap((answer) =>
        "_tag" in answer && answer._tag === "OrchestratorMcpFailure"
          ? Effect.fail(answer as unknown as OrchestratorMcpFailure)
          : Effect.succeed(answer),
      ),
      Effect.orDie,
    );
  };
  return proxy;
};

const caller = (over: Partial<Parameters<typeof toolkitFor>[1]> = {}) =>
  toolkitFor(localMachine(), { scope: thread, grant: undefined, proxy: overTheFleet(), ...over });

it.effect("sends a file, verified, into the other machine's inbox", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "app-release.apk");
    NodeFS.writeFileSync(source, Buffer.alloc(3 * 1024 * 1024, 7));
    const result = yield* caller()("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: source,
    });
    expect(result).toMatchObject({ status: "done", machine: "M1", secret: false });
    expect(String(result.path).startsWith(remote)).toBe(true);
    expect(NodeFS.readFileSync(String(result.path)).equals(NodeFS.readFileSync(source))).toBe(true);
  }),
);

it.effect("gets a file from the other machine", () =>
  Effect.gen(function* () {
    const source = NodePath.join(remoteProject, "app-release.aab");
    NodeFS.writeFileSync(source, "built there");
    const result = yield* caller()("studio_file_transfer", {
      machine: "m1",
      direction: "get",
      path: source,
    });
    expect(result).toMatchObject({ status: "done", machine: "this machine", secret: false });
    expect(String(result.path).startsWith(local)).toBe(true);
    expect(NodeFS.readFileSync(String(result.path), "utf8")).toBe("built there");
  }),
);

it.effect("tells work another machine started to ask its coordinator", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "a.bin");
    NodeFS.writeFileSync(source, "x");
    const result = yield* caller({ origin: true })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: source,
    });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(String(result.message)).toContain("the coordinator on M4 moves it");
  }),
);

it.effect("names who can fix a missing grant, and creates none", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "a.bin");
    NodeFS.writeFileSync(source, "x");
    const result = yield* caller({
      proxy: () =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "machine_not_authorized", message: "not allowed" }),
        ),
    })("studio_file_transfer", { machine: "m1", direction: "send", path: source });
    expect(result).toMatchObject({ code: "machine_not_authorized" });
    expect(String(result.message)).toContain("Only the user allows that");
    expect(String(result.message)).toContain("your coordinator");
  }),
);

it.effect("moves a secret only after the owner's card, encrypted, and owner-only", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "publisher.json");
    NodeFS.writeFileSync(source, '{"private_key":"PLAINTEXT-KEY-VALUE"}');
    const seen: Array<Record<string, unknown>> = [];
    const cards: ProjectActionRequests.ProjectActionRequestInput[] = [];
    const args = { machine: "m1", direction: "send", path: source };
    const asked = yield* caller({ cards, proxy: overTheFleet(seen) })("studio_file_transfer", args);
    expect(asked).toMatchObject({ status: "awaiting_user", secret: true });
    expect(cards[0]).toMatchObject({ action: "transfer_secret" });
    expect(seen).toEqual([]);

    const moved = yield* caller({
      proxy: overTheFleet(seen),
      approved: {
        machineId: "m1",
        machineLabel: "M1",
        direction: "send",
        path: source,
        sizeBytes: 1,
      },
    })("studio_file_transfer", { ...args, approvalId: "project-action:card" });
    expect(moved).toMatchObject({ status: "done", secret: true });
    expect(moved).not.toHaveProperty("sha256");
    expect(JSON.stringify(moved)).not.toContain("PLAINTEXT-KEY-VALUE");
    expect(JSON.stringify(seen)).not.toContain("PLAINTEXT-KEY-VALUE");
    expect(JSON.stringify(seen)).not.toContain(
      Buffer.from('{"private_key"').toString("base64").slice(0, 16),
    );
    // Windows has no such mode bits; the user profile's folder permissions apply there.
    if (NodePath.sep === "/") expect(NodeFS.statSync(String(moved.path)).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(String(moved.path), "utf8")).toContain("PLAINTEXT-KEY-VALUE");
  }),
);

it.effect("refuses an approval for a different transfer", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, ".env");
    NodeFS.writeFileSync(source, "A=1");
    const result = yield* caller({
      approved: {
        machineId: "m1",
        machineLabel: "M1",
        direction: "send",
        path: "/somewhere/else",
        sizeBytes: 3,
      },
    })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: source,
      approvalId: "project-action:card",
    });
    expect(String(result.message)).toContain("does not cover this transfer");
  }),
);

it.effect("asks the owner for a secret found on the other machine", () =>
  Effect.gen(function* () {
    const source = NodePath.join(remoteProject, ".env");
    NodeFS.writeFileSync(source, "A=PLAINTEXT");
    const cards: ProjectActionRequests.ProjectActionRequestInput[] = [];
    const args = { machine: "m1", direction: "get", path: source };
    const asked = yield* caller({ cards })("studio_file_transfer", args);
    expect(asked).toMatchObject({ status: "awaiting_user" });
    expect(cards[0]?.secretTransfer).toMatchObject({ direction: "get", path: source });
    const moved = yield* caller({
      approved: {
        machineId: "m1",
        machineLabel: "M1",
        direction: "get",
        path: source,
        sizeBytes: 11,
      },
    })("studio_file_transfer", { ...args, approvalId: "project-action:card" });
    expect(moved).toMatchObject({ status: "done", secret: true });
    expect(NodeFS.readFileSync(String(moved.path), "utf8")).toBe("A=PLAINTEXT");
    // Windows has no such mode bits; the user profile's folder permissions apply there.
    if (NodePath.sep === "/") expect(NodeFS.statSync(String(moved.path)).mode & 0o777).toBe(0o600);
  }),
);

it.effect("never sends this app's keys, even with an approval", () =>
  Effect.gen(function* () {
    const key = NodePath.join(local, "studio-fleet-key.json");
    NodeFS.mkdirSync(NodePath.dirname(key), { recursive: true });
    NodeFS.writeFileSync(key, '{"private_key":"x"}');
    const result = yield* caller({
      approved: { machineId: "m1", machineLabel: "M1", direction: "send", path: key, sizeBytes: 1 },
    })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: key,
      approvalId: "project-action:card",
    });
    expect(String(result.message)).toContain("never moves between machines");
  }),
);

it.effect("sends from a managed worktree, where threads really run", () =>
  Effect.gen(function* () {
    const worktree = NodePath.join(local, "worktrees", "feature");
    NodeFS.mkdirSync(worktree, { recursive: true });
    const source = NodePath.join(worktree, "app.apk");
    NodeFS.writeFileSync(source, "built here");
    const result = yield* toolkitFor(localMachine(), {
      scope: thread,
      grant: undefined,
      proxy: overTheFleet(),
      worktreePath: worktree,
    })("studio_file_transfer", { machine: "m1", direction: "send", path: source });
    expect(result).toMatchObject({ status: "done" });
  }),
);

it.effect("names an older machine and how to fix it", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "a.bin");
    NodeFS.writeFileSync(source, "x");
    const result = yield* caller({
      proxy: () =>
        Effect.fail(new OrchestratorMcpFailure({ code: "machine_unsupported", message: "old" })),
    })("studio_file_transfer", { machine: "m1", direction: "send", path: source });
    expect(String(result.message)).toContain("older SpecWithCode without file transfer");
  }),
);

it.effect("shows the owner the file a link leads to, and refuses when it moves", () =>
  Effect.gen(function* () {
    const key = NodePath.join(localProject, "prod.pem");
    NodeFS.writeFileSync(key, "A=1");
    const link = NodePath.join(localProject, "local.env");
    NodeFS.symlinkSync(key, link);
    const cards: ProjectActionRequests.ProjectActionRequestInput[] = [];
    const first = yield* caller({ cards })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: link,
    });
    expect(first).toMatchObject({ status: "awaiting_user" });
    expect(cards[0]?.secretTransfer?.path).toBe(key);

    const other = NodePath.join(localProject, "other.env");
    NodeFS.writeFileSync(other, "B=2");
    NodeFS.rmSync(link);
    NodeFS.symlinkSync(other, link);
    const second = yield* caller({
      approved: { machineId: "m1", machineLabel: "M1", direction: "send", path: key, sizeBytes: 3 },
    })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: link,
      approvalId: "project-action:card",
    });
    expect(String(second.message)).toContain("does not cover this transfer");
  }),
);

it.effect("lets only a full-access thread choose where a file lands", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, "a.bin");
    NodeFS.writeFileSync(source, "x");
    const result = yield* caller({ runtimeMode: "approval-required" })("studio_file_transfer", {
      machine: "m1",
      direction: "get",
      path: source,
      destinationPath: NodePath.join(localProject, ".claude", "settings.json"),
    });
    expect(result).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("binds an approval to its destination too", () =>
  Effect.gen(function* () {
    const source = NodePath.join(localProject, ".env");
    NodeFS.writeFileSync(source, "A=1");
    const result = yield* caller({
      approved: {
        machineId: "m1",
        machineLabel: "M1",
        direction: "send",
        path: source,
        sizeBytes: 3,
      },
    })("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: source,
      destinationPath: NodePath.join(remoteProject, ".env"),
      approvalId: "project-action:card",
    });
    expect(String(result.message)).toContain("does not cover this transfer");
  }),
);

it.effect("refuses a plain file outside the thread's folders", () =>
  Effect.gen(function* () {
    const source = NodePath.join(root, "elsewhere.bin");
    NodeFS.writeFileSync(source, "x");
    const result = yield* caller()("studio_file_transfer", {
      machine: "m1",
      direction: "send",
      path: source,
    });
    expect(String(result.message)).toContain("outside this thread's project");
  }),
);

it.effect("keeps the machine-to-machine tools away from agents", () =>
  Effect.gen(function* () {
    const offer = yield* caller()("studio_file_offer", { direction: "get", path: "/etc/hosts" });
    const chunk = yield* caller()("studio_file_chunk", { offerId: "x", index: 0 });
    for (const answer of [offer, chunk])
      expect(answer).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("keeps file bytes out of the trace, for a refused or malformed call too", () =>
  Effect.gen(function* () {
    const seen: Array<Tracer.Span> = [];
    const tracer = withoutFileBytes(
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          seen.push(span);
          return span;
        },
      }),
    );
    const data = Buffer.from("BYTES").toString("base64");
    const annotate = (tool: string, parameters: unknown) =>
      Effect.annotateCurrentSpan({ tool, parameters }).pipe(
        Effect.withSpan("tool"),
        Effect.withTracer(tracer),
      );
    yield* annotate("studio_file_chunk", { offerId: "x", index: -1, data });
    yield* annotate("studio_project_read", { projectId: "visible" });
    expect(seen.map((span) => span.attributes.get("parameters"))).toEqual([
      "[file bytes]",
      { projectId: "visible" },
    ]);
  }),
);
