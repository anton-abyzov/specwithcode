// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The world of the handoff follow tests: a worker a thread on the source
 * launched is handed off to the target, and its result must reach that
 * thread once.
 *
 * The source's moves talk to a real receiver over real Git repositories. The
 * target's thread tools answer as a released peer does (releasedPeer.testkit.ts)
 * for the threads that receiver launched. Everything either machine keeps
 * lives in the stage, outside any one server life: the source's folder with
 * its remote worker rows, both handoff documents, the target's threads and the
 * messages the launcher's thread keeps. `boot` is one life of the source over
 * them and `restartTarget` a new life of the target, so a test restarts either
 * machine by building it again.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
import { releasedPeer } from "../fleet/releasedPeer.testkit.ts";
import type * as RemoteWorkerFollower from "../fleet/RemoteWorkerFollower.ts";
import {
  type KeptMessage,
  makeSignal,
  project,
  ROLES,
  setup,
} from "../fleet/remoteWorkers.testkit.ts";
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
import type { TakeoverRequest } from "./handoffWire.ts";

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

export const source = EnvironmentId.make(ROLES.self);
export const target = ROLES.target;
export const sourceProject = ProjectId.make("project-on-source");
export const targetProject = ProjectId.make("project-on-target");
export const worker = ThreadId.make("thread:fix-build");
export const launcher = ThreadId.make("coordinator");
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;

const temporary: Array<string> = [];
/** Removes every stage's folders; call from `afterEach`. */
export const removeStages = () => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
};

export function stage(
  timings: Partial<RemoteWorkerFollower.RemoteWorkerFollowerTimingsShape> = {},
) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-follow-")),
  );
  temporary.push(base);
  const sourceRoot = NodePath.join(base, "source-repo");
  NodeFS.mkdirSync(sourceRoot);
  git(sourceRoot, "init", "-q", "-b", "feat/fix-build");
  NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 1;\n");
  git(sourceRoot, "add", "-A");
  git(sourceRoot, "commit", "-q", "-m", "base");
  const targetRoot = NodePath.join(base, "target-repo");
  git(base, "clone", "-q", sourceRoot, targetRoot);
  NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 2;\n");
  const sourceState = NodePath.join(base, "source-state");
  NodeFS.mkdirSync(sourceState);

  const fixture = {
    runEnding: "usage-limit" as HandoffRunEnding,
    sequence: 0,
    /** Who sent the worker's first message. */
    startedBy: "agent" as "agent" | "user",
    /** What the thread that sent it is to its own parent. */
    launcherIs: "top-level" as "top-level" | "subagent",
    /** The source cannot read the thread that launched the worker. */
    launcherLookupFails: false,
    /** What the handed-off thread is here: a launched worker, or itself a continuation. */
    workerIs: "launched" as "launched" | "continuation",
  };
  const documents: Record<"source" | "target", HandoffDocument> = {
    source: {
      ...EMPTY_HANDOFF_DOCUMENT,
      threads: {
        [worker]: {
          ...emptyThreadRecord(sourceProject),
          mode: "on",
          lease: {
            holderEnvironmentId: source,
            holderLabel: "Source",
            holderThreadId: worker,
            epoch: 1,
            renewedAt: "2026-10-20T14:00:00.000Z",
            state: "active",
          },
        },
      },
    },
    target: EMPTY_HANDOFF_DOCUMENT,
  };
  const peer = releasedPeer(target.environmentId);
  const kept: Array<KeptMessage> = [];
  const changed = makeSignal();
  const network = {
    dropTakeoverAnswer: false,
    dropTakeoverRequest: false,
    refuseTakeover: false,
    /** The source's fleet file cannot be read: it lists no machine. */
    fleetUnread: false,
    /** Machines the source lists but holds no work grant on. */
    ungranted: [] as Array<{ machineId: string; environmentId: EnvironmentId; label: string }>,
    /** Takeovers that left the source, whatever became of them. */
    takeovers: [] as Array<TakeoverRequest>,
  };
  /** Threads the target's receiver launched, in order. */
  const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];

  const handoffFor = (side: "source" | "target") =>
    ({
      environmentId: side === "source" ? source : target.environmentId,
      machineLabel: side === "source" ? "Source" : "Target",
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
              environmentId: source,
              machineLabel: "Source",
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
  const targetProjectRow = {
    id: targetProject,
    title: "App",
    workspaceRoot: targetRoot,
    workspaceSettings: {
      logicalProject: {
        members: [
          { environmentId: source, projectId: sourceProject },
          { environmentId: target.environmentId, projectId: targetProject },
        ],
      },
    },
  };
  /** One life of the target's receiver, over the document and repository it keeps. */
  const makeReceiver = HandoffReceiver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor("target")),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [targetProject]: { defaultThreadEnvMode: "worktree" as const },
            },
          }),
        } as never),
        Layer.succeed(ServerConfig.ServerConfig, {
          worktreesDir: NodePath.join(base, "target-worktrees"),
        } as never),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: ProjectId) =>
            Effect.succeed(id === targetProject ? Option.some(targetProjectRow) : Option.none()),
          snapshot: Effect.succeed({ projects: [targetProjectRow] }),
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
              launches.push(input);
              // The receiver names every continuation itself.
              const threadId = String(input.threadId);
              if (!peer.threads.has(threadId)) peer.create(threadId, targetProject);
              // A continuation that resumes starts its first run with the takeover.
              if (input.initialMessage !== undefined)
                peer.start(threadId, { creationSource: "server" });
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
  let receiver: HandoffReceiver.HandoffReceiver["Service"] | undefined;
  /** The target's server starts again: a new receiver over what the old one kept. */
  const restartTarget = Effect.map(makeReceiver, (built) => {
    receiver = built;
  });
  const receiverNow = Effect.suspend(() =>
    receiver === undefined
      ? Effect.andThen(
          restartTarget,
          Effect.sync(() => receiver as HandoffReceiver.HandoffReceiver["Service"]),
        )
      : Effect.succeed(receiver),
  );

  const asSource = { sourceEnvironmentId: source, grant: unscopedGrant(source) };
  const noAnswer = () =>
    new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: true });
  const fromReceiver = <A>(effect: Effect.Effect<A, HandoffReceiver.HandoffRefusal>) =>
    effect.pipe(
      Effect.mapError(
        (refusal) =>
          new HandoffPeerError({
            code: refusal.code,
            message: refusal.message,
            check: refusal.check,
            uncertain: refusal.uncertain === true,
          }),
      ),
    );
  const asked = <A>(
    call: (
      built: HandoffReceiver.HandoffReceiver["Service"],
    ) => Effect.Effect<A, HandoffReceiver.HandoffRefusal>,
  ) => fromReceiver(Effect.flatMap(receiverNow, call));
  const there = { machineId: target.id, environmentId: target.environmentId, label: "Target" };
  const peers = {
    target: () => Effect.succeed(there),
    targets: Effect.sync(() => (network.fleetUnread ? [] : [there, ...network.ungranted])),
    negotiate: (_: unknown, request: never) =>
      asked((built) => built.negotiate(asSource, request)),
    replicate: (_: unknown, meta: never, bundle: never) =>
      asked((built) => built.replicate(asSource, meta, bundle)),
    preflight: (environmentId: unknown, request: never) =>
      network.ungranted.some((machine) => machine.environmentId === environmentId)
        ? Effect.fail(
            new HandoffPeerError({
              code: "needs_grant",
              message: "This machine has no work grant there.",
              check: "grant",
              uncertain: false,
              local: true,
            }),
          )
        : asked((built) => built.preflight(asSource, request)),
    takeover: (_: unknown, request: TakeoverRequest) => {
      network.takeovers.push(request);
      if (network.refuseTakeover) {
        return Effect.fail(
          new HandoffPeerError({
            code: "busy",
            message: "The target refused the takeover.",
            uncertain: false,
          }),
        );
      }
      if (network.dropTakeoverRequest) return Effect.fail(noAnswer());
      return asked((built) => built.takeover(asSource, request)).pipe(
        Effect.filterOrFail(() => !network.dropTakeoverAnswer, noAnswer),
      );
    },
    heartbeat: (_: unknown, request: never) =>
      asked((built) => built.heartbeat(asSource, request)),
    transferStatus: (_: unknown, request: never) =>
      asked((built) => built.transferStatus(asSource, request)),
    transferPull: (_: unknown, request: never) =>
      asked((built) => built.transferPull(asSource, request)),
  } as unknown as HandoffPeers["Service"];

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
    // A continuation is a thread this machine's receiver made, not one an agent launched.
    createdBy: fixture.workerIs === "launched" ? "agent" : "system",
    creationSource: fixture.workerIs === "launched" ? "mcp" : "server",
    deletedAt: null,
  });
  const lookupFailed = () => Effect.fail({ _tag: "ProjectionStoreV2Error" } as never);
  /**
   * The source's moves, as one life of its server builds them. Run inside a
   * life's layer they follow launched workers; run alone they do not, as the
   * release before this change.
   */
  const makeMoves = HandoffMoves.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor("source")),
        Layer.succeed(HandoffPeers, peers),
        // The source's own receiver is asked for nothing here but to take the pull handler.
        Layer.succeed(HandoffReceiver.HandoffReceiver, {
          attachPull: () => Effect.void,
        } as never),
        Layer.succeed(HandoffConnectivity, { probe: Effect.succeed("online" as const) }),
        orchestrator,
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadShell: (id: ThreadId) =>
            id === launcher && fixture.launcherLookupFails
              ? lookupFailed()
              : Effect.succeed(
                  id === worker
                    ? workerShell()
                    : id === launcher
                      ? {
                          id: launcher,
                          deletedAt: null,
                          lineage: {
                            relationshipToParent:
                              fixture.launcherIs === "subagent" ? "subagent" : null,
                          },
                        }
                      : null,
                ),
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
  /**
   * The moves of a source that follows nothing, as the release before this
   * change builds them: no remote worker services in reach.
   */
  const makeMovesAlone = makeMoves.pipe(
    Effect.provideService(ProjectService.ProjectService, {
      getById: (id: ProjectId) =>
        Effect.succeed(
          id === sourceProject
            ? Option.some({ ...project(), id: sourceProject, workspaceRoot: sourceRoot })
            : Option.none(),
        ),
    } as never),
  );
  const handOffWith = (moves: Effect.Success<typeof makeMoves>) =>
    moves.handOff({ threadId: worker, destinationEnvironmentId: target.environmentId });

  /** One life of the source's server over the stage's folder. */
  const boot = () => {
    const life = setup(peer.tools, timings, {
      roles: ROLES,
      baseDir: sourceState,
      kept,
      changed,
    });
    // The launching thread's project is the one the worker runs in.
    life.world.local.current = { ...project(), id: sourceProject, workspaceRoot: sourceRoot };
    return {
      world: life.world,
      layer: life.layer,
      /** Builds this life's moves; run it inside `layer`. */
      start: Effect.map(makeMoves, (moves) => ({
        moves,
        handOff: handOffWith(moves),
        /** The same thread continued on this machine under another model. */
        handOffHere: moves.handOff({
          threadId: worker,
          destinationEnvironmentId: source,
          modelSelection: { ...(modelSelection as object), model: "another-model" } as never,
        }),
      })),
    };
  };

  /** The run the target's continuation started with, or the latest one there. */
  const lastRun = () => {
    const thread = [...peer.threads.values()].at(-1);
    const run = thread?.runs.at(-1);
    if (thread === undefined || run === undefined) throw new Error("The target has no run.");
    return { threadId: thread.threadId, run };
  };
  const finish = (status = "completed") =>
    Effect.sync(() => {
      const { threadId, run } = lastRun();
      peer.set(threadId, run.id, status);
      changed.fire();
    });

  return {
    peer,
    kept,
    changed,
    fixture,
    network,
    documents,
    launches,
    boot,
    makeMoves,
    makeMovesAlone,
    handOffWith,
    restartTarget,
    /** Sends a takeover the source already sent to the target's receiver once more. */
    replayTakeover: (request: TakeoverRequest) =>
      Effect.flatMap(receiverNow, (built) => built.takeover(asSource, request)),
    lastRun,
    finish,
  };
}

export type Stage = ReturnType<typeof stage>;
