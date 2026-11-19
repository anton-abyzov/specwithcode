// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A worker a thread here launched is handed off to another machine; its result
 * must reach that thread once. The source's moves talk to a real receiver over
 * real Git repositories, and the other machine's MCP tools are a fake that
 * answers the way that machine's wait does for what the receiver launched.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type HandoffCheckpoint,
  type HandoffRunEnding,
  ProjectId,
  ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import type { FakeToolAnswer } from "../fleet/fakeStudioMcp.testkit.ts";
import * as RemoteWorkerFollower from "../fleet/RemoteWorkerFollower.ts";
import { allow, eventually, project, rows, setup } from "../fleet/remoteWorkers.testkit.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffConnectivity } from "./handoffConnectivity.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffMoves from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import { EMPTY_HANDOFF_DOCUMENT, emptyThreadRecord, type HandoffDocument } from "./handoffState.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Handoff Test", "-c", "user.email=handoff@example.invalid", "-C", cwd, ...args],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

// The names the shared remote-worker world uses: this server and the machine it may run work on.
const here = EnvironmentId.make("env-m4");
const there = EnvironmentId.make("env-m1");
const sourceProject = ProjectId.make("project-here");
const destinationProject = ProjectId.make("project-there");
const worker = ThreadId.make("thread:fix-build");
const launcher = ThreadId.make("coordinator");
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;

/** The other machine as its MCP tools show it: the threads its receiver launched and their runs. */
interface OtherMachine {
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly runs: Array<{ readonly id: string; status: string }>;
  unreachable: boolean;
  /** Waits this machine answered, whatever the answer. */
  waits: number;
  readonly wait: (args: Record<string, unknown>) => Promise<FakeToolAnswer>;
}

function otherMachine(): OtherMachine {
  const other: OtherMachine = {
    launches: [],
    runs: [],
    unreachable: false,
    waits: 0,
    wait: async (args) => {
      // A running turn holds the real wait open; a short pause stands in for it.
      await new Promise((resolve) => setTimeout(resolve, 2));
      other.waits += 1;
      if (other.unreachable) return { raw: new Response("down", { status: 503 }) };
      const threadId = String(args.threadId);
      if (!other.launches.some((launch) => launch.threadId === threadId)) {
        return {
          failure: JSON.stringify({
            code: "thread_not_found",
            message: `Thread ${threadId} was not found.`,
          }),
        };
      }
      const run =
        typeof args.runId === "string"
          ? other.runs.find((candidate) => candidate.id === args.runId)
          : other.runs.at(-1);
      // What the released receiver's wait answers for a thread with no run.
      if (run === undefined) {
        return { result: { threadId, runId: null, status: "idle", timedOut: false } };
      }
      const open = ["queued", "preparing", "starting", "running", "waiting"].includes(run.status);
      return { result: { threadId, runId: run.id, status: run.status, timedOut: open } };
    },
  };
  return other;
}

const scenario = (world: ReturnType<typeof setup>["world"], other: OtherMachine) =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-follow-")),
    );
    temporary.push(base);
    const sourceRoot = NodePath.join(base, "here-repo");
    NodeFS.mkdirSync(sourceRoot);
    git(sourceRoot, "init", "-q", "-b", "feat/fix-build");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 1;\n");
    git(sourceRoot, "add", "-A");
    git(sourceRoot, "commit", "-q", "-m", "base");
    const destinationRoot = NodePath.join(base, "there-repo");
    git(base, "clone", "-q", sourceRoot, destinationRoot);
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 2;\n");

    const fixture = {
      runEnding: "usage-limit" as HandoffRunEnding,
      sequence: 0,
      /** Who sent the worker's first message. */
      startedBy: "agent" as "agent" | "user",
    };
    const documents: Record<"source" | "destination", HandoffDocument> = {
      source: EMPTY_HANDOFF_DOCUMENT,
      destination: EMPTY_HANDOFF_DOCUMENT,
    };
    const handoffFor = (side: "source" | "destination") =>
      ({
        environmentId: side === "source" ? here : there,
        machineLabel: side === "source" ? "M4" : "M1",
        document: Effect.sync(() => documents[side]),
        updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
          Effect.sync(() => {
            const [result, next] = change(documents[side]);
            documents[side] = next;
            return result;
          }),
        checkpoint: () =>
          Effect.promise(async () => {
            const written = await writeCheckpoint({ cwd: sourceRoot, threadId: worker });
            fixture.sequence += 1;
            const record = documents[side].threads[worker] ?? emptyThreadRecord(sourceProject);
            const checkpoint: HandoffCheckpoint = {
              sequence: fixture.sequence,
              commit: written.commit,
              baseCommit: written.baseCommit,
              branch: written.branch,
              ref: written.ref,
              createdAt: "2026-10-20T14:00:00.000Z",
              reason: "handoff",
              skipped: [...written.skipped],
              excludedSecretCount: written.excludedSecretCount,
              requiredSecretPaths: [...written.requiredSecretPaths],
              transcriptMessageCount: 1,
              note: {
                done: "Fixed the types",
                next: "Run the build",
                openQuestions: "",
                createdAt: "2026-10-20T14:00:00.000Z",
              },
              pushedToOrigin: false,
              epoch: record.lease?.epoch ?? 0,
              latestRunId: null,
              turnKey: threadTurnKey(worker, "run-1"),
              runEnding: record.fencedBy ?? fixture.runEnding,
              sideEffects: [],
              sourceRoot: {
                environmentId: here,
                machineLabel: "M4",
                projectId: sourceProject,
                threadId: worker,
                workspaceRoot: written.root,
                branch: written.branch,
              },
            };
            documents[side] = {
              ...documents[side],
              threads: { ...documents[side].threads, [worker]: { ...record, checkpoint } },
            };
            return checkpoint;
          }),
      }) as unknown as HandoffMode["Service"];

    const orchestrator = Layer.succeed(Orchestrator.OrchestratorV2, {
      dispatch: () => Effect.succeed({}),
    } as never);
    const destinationProjectRow = {
      id: destinationProject,
      title: "App",
      workspaceRoot: destinationRoot,
      workspaceSettings: {
        logicalProject: {
          members: [
            { environmentId: here, projectId: sourceProject },
            { environmentId: there, projectId: destinationProject },
          ],
        },
      },
    };
    const destinationReceiver = yield* HandoffReceiver.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HandoffMode, handoffFor("destination")),
          Layer.succeed(ServerSettings.ServerSettingsService, {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: {
                [destinationProject]: { defaultThreadEnvMode: "worktree" as const },
              },
            }),
          } as never),
          Layer.succeed(ServerConfig.ServerConfig, {
            worktreesDir: NodePath.join(base, "there-worktrees"),
          } as never),
          Layer.succeed(ProjectService.ProjectService, {
            getById: (id: ProjectId) =>
              Effect.succeed(
                id === destinationProject ? Option.some(destinationProjectRow) : Option.none(),
              ),
            snapshot: Effect.succeed({ projects: [destinationProjectRow] }),
          } as never),
          Layer.succeed(ProviderRegistry.ProviderRegistry, {
            getProviders: Effect.succeed([
              {
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
                enabled: true,
                installed: true,
                auth: { status: "authenticated" },
                models: [{ slug: "claude-opus-5-5" }],
              },
            ]),
          } as never),
          Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
            launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
              Effect.sync(() => {
                other.launches.push(input);
                // A continuation that resumes starts its first run with the takeover.
                if (input.initialMessage !== undefined) {
                  other.runs.push({ id: `there-run-${other.runs.length + 1}`, status: "running" });
                }
                return { threadId: input.threadId, projection: {}, resumed: false };
              }),
          } as never),
          orchestrator,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, {
            getThreadShell: () => Effect.succeed(null),
          } as never),
        ),
      ),
    );

    const asSource = { sourceEnvironmentId: here, grant: unscopedGrant(here) };
    const network = {
      dropTakeoverAnswer: false,
      dropTakeoverRequest: false,
      refuseTakeover: false,
      takeovers: 0,
    };
    const noAnswer = () =>
      new HandoffPeerError({ code: "unreachable", message: "M1 did not answer.", uncertain: true });
    const fromReceiver = <A>(effect: Effect.Effect<A, HandoffReceiver.HandoffRefusal>) =>
      effect.pipe(
        Effect.mapError(
          (refusal) =>
            new HandoffPeerError({
              code: refusal.code,
              message: refusal.message,
              check: refusal.check,
              uncertain: false,
            }),
        ),
      );
    const peers = {
      target: () => Effect.succeed({ machineId: "m1", environmentId: there, label: "M1" }),
      targets: Effect.succeed([{ machineId: "m1", environmentId: there, label: "M1" }]),
      negotiate: (_: unknown, request: never) =>
        fromReceiver(destinationReceiver.negotiate(asSource, request)),
      replicate: (_: unknown, meta: never, bundle: never) =>
        fromReceiver(destinationReceiver.replicate(asSource, meta, bundle)),
      preflight: (_: unknown, request: never) =>
        fromReceiver(destinationReceiver.preflight(asSource, request)),
      takeover: (_: unknown, request: never) => {
        network.takeovers += 1;
        if (network.refuseTakeover) {
          return Effect.fail(
            new HandoffPeerError({
              code: "busy",
              message: "M1 refused the takeover.",
              uncertain: false,
            }),
          );
        }
        if (network.dropTakeoverRequest) return Effect.fail(noAnswer());
        return fromReceiver(destinationReceiver.takeover(asSource, request)).pipe(
          Effect.flatMap((answer) =>
            network.dropTakeoverAnswer ? Effect.fail(noAnswer()) : Effect.succeed(answer),
          ),
        );
      },
      heartbeat: (_: unknown, request: never) =>
        fromReceiver(destinationReceiver.heartbeat(asSource, request)),
    } as unknown as HandoffPeers["Service"];

    // The launching thread's project is the one the worker runs in.
    world.local.current = {
      ...project(),
      id: sourceProject,
      workspaceRoot: sourceRoot,
    };
    const workerShell = () => ({
      id: worker,
      projectId: sourceProject,
      title: "Fix the build",
      worktreePath: null,
      activeRunId: null,
      latestRunId: null,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      lineage: { parentThreadId: null },
      createdBy: "agent",
      creationSource: "mcp",
      deletedAt: null,
    });
    const moves = yield* HandoffMoves.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HandoffMode, handoffFor("source")),
          Layer.succeed(HandoffPeers, peers),
          Layer.succeed(HandoffReceiver.HandoffReceiver, {} as never),
          Layer.succeed(HandoffConnectivity, { probe: Effect.succeed("online" as const) }),
          orchestrator,
          Layer.succeed(ProjectionStore.ProjectionStoreV2, {
            getThreadShell: (id: ThreadId) => Effect.succeed(id === worker ? workerShell() : null),
            getThread: () => Effect.succeed({ execution: null }),
            getThreadRecords: () =>
              Effect.succeed({
                messages: [
                  {
                    role: "user",
                    text: "Fix the build",
                    streaming: false,
                    createdBy: fixture.startedBy,
                    senderThreadId: fixture.startedBy === "agent" ? launcher : worker,
                    createdAt: DateTime.makeUnsafe(0),
                  },
                ],
              }),
          } as never),
        ),
      ),
    );
    documents.source = {
      ...documents.source,
      threads: {
        [worker]: {
          ...emptyThreadRecord(sourceProject),
          mode: "on",
          lease: {
            holderEnvironmentId: here,
            holderLabel: "M4",
            holderThreadId: worker,
            epoch: 1,
            renewedAt: "2026-10-20T14:00:00.000Z",
            state: "active",
          },
        },
      },
    };
    const handOff = moves.handOff({ threadId: worker, destinationEnvironmentId: there });
    return { moves, handOff, fixture, network, documents };
  });

/** Lets the follower poll the other machine at least twice more, so "no wake" is observed. */
const afterMorePolls = (other: OtherMachine) =>
  Effect.suspend(() => {
    const before = other.waits;
    return eventually(
      Effect.sync(() => other.waits),
      (waits) => waits >= before + 2,
    );
  });

const finish = (other: OtherMachine, status = "completed") =>
  Effect.sync(() => {
    const run = other.runs.at(-1);
    if (run !== undefined) run.status = status;
  });

const world = () => {
  const other = otherMachine();
  const kit = setup({ studio_thread_wait: other.wait });
  return { other, ...kit };
};

const LIVE = { timeout: 30_000 };

describe("a handed-off worker's result", () => {
  it.live(
    "wakes the thread that launched it once, however often the receipt is replayed",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { moves, handOff, documents } = yield* scenario(local, other);
        const moved = yield* handOff;
        expect(other.launches.map((launch) => launch.threadId)).toEqual([moved.threadId]);
        // The continuation is still working: nothing to report yet.
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        yield* finish(other);
        const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
        expect(row).toMatchObject({
          callerThreadId: launcher,
          remoteThreadId: moved.threadId,
          machineId: "m1",
          lastStatus: "completed",
          deliveredRunIds: ["there-run-1"],
        });
        expect(local.wakes.map((wake) => wake.commandId)).toEqual([
          `remote-worker-wake:${row?.id}:there-run-1`,
        ]);
        expect(local.wakes[0]?.text).toContain("finished: completed");
        expect(local.wakes[0]?.mode).toBe("queue");
        // The same handoff asked again, and later heartbeats, add nothing.
        expect((yield* handOff).threadId).toBe(moved.threadId);
        yield* moves.tick;
        yield* moves.tick;
        yield* afterMorePolls(other).pipe(Effect.timeoutOption("200 millis"));
        expect(local.wakes).toHaveLength(1);
        expect(yield* rows).toHaveLength(1);
        expect(documents.source.threads[worker]?.continuedOn?.threadId).toBe(moved.threadId);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "re-sends the same wake after a restart, never a second one",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { handOff } = yield* scenario(local, other);
        yield* handOff;
        yield* finish(other);
        yield* eventually(rows, (current) => current[0]?.state === "idle");
        const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
        yield* follower.resume;
        yield* eventually(
          Effect.sync(() => local.wakes.length),
          (count) => count >= 2,
        );
        // The orchestrator takes a command id once: the replay is the same wake.
        expect(new Set(local.wakes.map((wake) => wake.commandId)).size).toBe(1);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "keeps asking for a continuation that does not exist yet, then reports its run once",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { moves, handOff, network } = yield* scenario(local, other);
        network.dropTakeoverRequest = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("unreachable");
        expect(other.launches).toHaveLength(0);
        // The other machine answers "no such thread" for as long as the takeover is open.
        yield* afterMorePolls(other);
        yield* afterMorePolls(other);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        expect(local.wakes).toEqual([]);
        // The takeover gets through on the next heartbeat.
        network.dropTakeoverRequest = false;
        yield* moves.tick;
        expect(other.launches).toHaveLength(1);
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        yield* finish(other);
        const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
        expect(row?.remoteThreadId).toBe(other.launches[0]?.threadId);
        expect(local.wakes.map((wake) => wake.commandId)).toEqual([
          `remote-worker-wake:${row?.id}:there-run-1`,
        ]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports once when the takeover's answer was lost and a heartbeat fences the source later",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { moves, handOff, network, documents } = yield* scenario(local, other);
        network.dropTakeoverAnswer = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("unreachable");
        // The other machine did continue it, and finishes before this one learns that.
        expect(other.launches).toHaveLength(1);
        expect(documents.source.threads[worker]?.continuedOn).toBeNull();
        yield* finish(other);
        yield* eventually(rows, (current) => current[0]?.state === "idle");
        expect(local.wakes).toHaveLength(1);
        network.dropTakeoverAnswer = false;
        yield* moves.tick;
        yield* moves.tick;
        expect(documents.source.threads[worker]?.continuedOn?.threadId).toBe(
          other.launches[0]?.threadId,
        );
        yield* afterMorePolls(other).pipe(Effect.timeoutOption("200 millis"));
        expect(local.wakes).toHaveLength(1);
        expect(yield* rows).toMatchObject([{ state: "idle", deliveredRunIds: ["there-run-1"] }]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "stops following when the other machine refuses, and follows the handoff that goes through",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { handOff, network, documents } = yield* scenario(local, other);
        network.refuseTakeover = true;
        expect((yield* handOff.pipe(Effect.flip)).code).toBe("busy");
        expect(documents.source.threads[worker]?.lease?.state).toBe("active");
        expect(yield* rows).toMatchObject([{ state: "disposed", deliveredRunIds: [] }]);
        expect(local.wakes).toEqual([]);
        // The same thread is handed off again at the same epoch, and this time it is taken.
        network.refuseTakeover = false;
        const moved = yield* handOff;
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        yield* finish(other);
        const current = yield* eventually(rows, (all) => all[0]?.state === "idle");
        expect(current).toHaveLength(1);
        expect(current[0]?.remoteThreadId).toBe(moved.threadId);
        expect(local.wakes).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports nothing for a worker that arrives idle until a message there starts a run",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { handOff, fixture } = yield* scenario(local, other);
        // Its last run here completed, so the continuation waits for a message.
        fixture.runEnding = "completed";
        yield* handOff;
        expect(other.launches[0]?.initialMessage).toBeUndefined();
        expect(other.runs).toEqual([]);
        yield* afterMorePolls(other);
        yield* afterMorePolls(other);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        expect(local.wakes).toEqual([]);
        // Someone on the other machine sends it a message.
        other.runs.push({ id: "there-run-typed", status: "running" });
        yield* eventually(rows, (current) => current[0]?.followedRunId === "there-run-typed");
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        yield* finish(other);
        const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
        expect(local.wakes.map((wake) => wake.commandId)).toEqual([
          `remote-worker-wake:${row?.id}:there-run-typed`,
        ]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports once after the other machine could not be reached while the run finished",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { moves, handOff } = yield* scenario(local, other);
        yield* handOff;
        yield* afterMorePolls(other);
        // The two machines lose each other; the run ends meanwhile.
        other.unreachable = true;
        yield* finish(other);
        yield* afterMorePolls(other);
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        other.unreachable = false;
        yield* eventually(rows, (current) => current[0]?.state === "idle");
        yield* moves.tick;
        yield* afterMorePolls(other).pipe(Effect.timeoutOption("200 millis"));
        expect(local.wakes).toHaveLength(1);
        expect(local.wakes[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports nothing for a run stopped there, then the run that finishes",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { handOff } = yield* scenario(local, other);
        yield* handOff;
        yield* finish(other, "interrupted");
        yield* eventually(
          rows,
          (current) => current[0]?.handoff?.passedRunId === "there-run-1",
        );
        yield* afterMorePolls(other);
        expect(local.wakes).toEqual([]);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        other.runs.push({ id: "there-run-2", status: "running" });
        yield* eventually(rows, (current) => current[0]?.followedRunId === "there-run-2");
        yield* finish(other);
        const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
        expect(local.wakes.map((wake) => wake.commandId)).toEqual([
          `remote-worker-wake:${row?.id}:there-run-2`,
        ]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  for (const gone of ["deleted", "archived"] as const) {
    it.live(
      `never wakes a launcher that was ${gone} meanwhile`,
      () => {
        const { other, world: local, layer } = world();
        return Effect.gen(function* () {
          yield* allow();
          const { handOff } = yield* scenario(local, other);
          yield* handOff;
          local.caller[gone] = true;
          yield* finish(other);
          yield* eventually(rows, (current) => current[0]?.state === "disposed");
          yield* afterMorePolls(other).pipe(Effect.timeoutOption("200 millis"));
          expect(local.wakes).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
      LIVE,
    );
  }

  it.live(
    "follows nothing for a thread no agent's thread launched",
    () => {
      const { other, world: local, layer } = world();
      return Effect.gen(function* () {
        yield* allow();
        const { handOff, fixture } = yield* scenario(local, other);
        fixture.startedBy = "user";
        yield* handOff;
        yield* finish(other);
        expect(yield* rows).toEqual([]);
        expect(other.waits).toBe(0);
        expect(local.wakes).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );
});
