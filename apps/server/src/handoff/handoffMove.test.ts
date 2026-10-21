// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * A handoff between two machines in one process: the source's moves talk to
 * the destination's receiver through a stub peer client, over real Git
 * repositories (a source checkout and a destination clone).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HANDOFF_LEASE_STALE_MS,
  type HandoffCheckpoint,
  type HandoffRunEnding,
  ProjectId,
  ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { incomingRef } from "./bundleGit.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffMoves from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  guardSideEffect,
  findIncoming,
  type HandoffDocument,
} from "./handoffState.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

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

function directory(): string {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-move-")),
  );
  temporary.push(base);
  return base;
}

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const sourceProject = ProjectId.make("project-m4");
const destinationProject = ProjectId.make("project-minis");
const threadId = ThreadId.make("thread:fix-build");
const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;

interface Machine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  document: HandoffDocument;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly dispatched: Array<{ readonly type: string } & Record<string, unknown>>;
}

function machine(environmentId: EnvironmentId, label: string): Machine {
  return { environmentId, label, document: EMPTY_HANDOFF_DOCUMENT, launches: [], dispatched: [] };
}

const scenario = (
  options: {
    readonly linked?: boolean;
    readonly signedIn?: boolean;
    readonly sourceMembers?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const base = directory();
    const sourceRoot = NodePath.join(base, "m4-repo");
    NodeFS.mkdirSync(sourceRoot);
    git(sourceRoot, "init", "-q", "-b", "feat/fix-build");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, ".gitignore"), ".env.local\n");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 1;\n");
    git(sourceRoot, "add", "-A");
    git(sourceRoot, "commit", "-q", "-m", "base");
    const destinationRoot = NodePath.join(base, "minis-repo");
    git(base, "clone", "-q", sourceRoot, destinationRoot);
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "app.ts"), "export const a = 2;\n");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, "notes.md"), "half done\n");
    NodeFS.writeFileSync(NodePath.join(sourceRoot, ".env.local"), "TOKEN=source\n");
    const worktreesDir = NodePath.join(base, "minis-worktrees");

    const source = machine(m4, "M4");
    const destination = machine(minis, "Minis");
    const fixture = {
      activeRunId: null as string | null,
      runEnding: "usage-limit" as HandoffRunEnding,
      sequence: 0,
    };

    const handoffFor = (target: Machine) =>
      ({
        environmentId: target.environmentId,
        machineLabel: target.label,
        document: Effect.sync(() => target.document),
        updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
          Effect.sync(() => {
            const [result, next] = change(target.document);
            target.document = next;
            return result;
          }),
        snapshot: Effect.sync(() => ({}) as never),
        checkpoint: () =>
          Effect.promise(async () => {
            const written = await writeCheckpoint({ cwd: sourceRoot, threadId });
            fixture.sequence += 1;
            const record = target.document.threads[threadId] ?? emptyThreadRecord(sourceProject);
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
              turnKey: threadTurnKey(threadId, "run-1"),
              runEnding:
                record.fencedBy ?? (fixture.activeRunId === null ? fixture.runEnding : "active"),
              sideEffects: [
                {
                  turnKey: threadTurnKey(threadId, "run-1"),
                  kind: "pr-create",
                  target: "anton-abyzov/app#12",
                  epoch: 1,
                  environmentId: m4,
                  at: "2026-10-20T13:59:00.000Z",
                  result: "https://github.com/anton-abyzov/app/pull/12",
                },
              ],
              sourceRoot: {
                environmentId: m4,
                machineLabel: "M4",
                projectId: sourceProject,
                threadId,
                workspaceRoot: written.root,
                branch: written.branch,
              },
            };
            target.document = {
              ...target.document,
              threads: { ...target.document.threads, [threadId]: { ...record, checkpoint } },
            };
            return checkpoint;
          }),
      }) as unknown as HandoffMode["Service"];

    const sourceShell = () => ({
      id: threadId,
      projectId: sourceProject,
      title: "Fix the build",
      worktreePath: null,
      activeRunId: fixture.activeRunId,
      latestRunId: null,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      deletedAt: null,
    });

    const projectOf = (target: Machine, roots: { project: ProjectId; root: string }) => ({
      id: roots.project,
      title: "App",
      workspaceRoot: roots.root,
      workspaceSettings:
        target === source && options.sourceMembers === true
          ? {
              logicalProject: {
                members: [{ environmentId: minis, projectId: destinationProject }],
              },
            }
          : target === destination && options.linked !== false
            ? { logicalProject: { members: [{ environmentId: m4, projectId: sourceProject }] } }
            : undefined,
    });

    const servicesFor = (target: Machine, roots: { project: ProjectId; root: string }) =>
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor(target)),
        Layer.succeed(ServerConfig.ServerConfig, { worktreesDir } as never),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: ProjectId) =>
            Effect.succeed(
              id === roots.project ? Option.some(projectOf(target, roots)) : Option.none(),
            ),
          snapshot: Effect.succeed({ projects: [projectOf(target, roots)] }),
        } as never),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
              enabled: true,
              installed: true,
              auth: { status: options.signedIn === false ? "unauthenticated" : "authenticated" },
              models: [{ slug: "claude-opus-5-5" }],
            },
          ]),
        } as never),
        Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
          launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
            Effect.sync(() => {
              target.launches.push(input);
              return { threadId: input.threadId, projection: {}, resumed: false };
            }),
        } as never),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: (command: { type: string }) =>
            Effect.sync(() => {
              target.dispatched.push(command);
              if (command.type === "run.interrupt") fixture.activeRunId = null;
              return {};
            }),
        } as never),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadShell: (id: ThreadId) => Effect.succeed(id === threadId ? sourceShell() : null),
          getThread: () => Effect.succeed({ execution: null }),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [{ role: "user", text: "Fix the build", streaming: false }],
            }),
        } as never),
      );

    const destinationServices = servicesFor(destination, {
      project: destinationProject,
      root: destinationRoot,
    });
    const sourceServices = servicesFor(source, { project: sourceProject, root: sourceRoot });
    const destinationReceiver = yield* HandoffReceiver.make.pipe(
      Effect.provide(destinationServices),
    );
    const asSource = { sourceEnvironmentId: m4, grant: unscopedGrant(m4) };
    const network = { down: false, dropTakeoverAnswer: false };
    const viaNetwork = <A>(effect: Effect.Effect<A, HandoffReceiver.HandoffRefusal>) =>
      network.down
        ? Effect.fail(
            new HandoffPeerError({
              code: "unreachable",
              message: "Minis did not answer.",
              uncertain: true,
            }),
          )
        : effect.pipe(
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
    const peers = HandoffPeers.of({
      target: () => Effect.succeed({ machineId: "minis", environmentId: minis, label: "Minis" }),
      targets: Effect.succeed([{ machineId: "minis", environmentId: minis, label: "Minis" }]),
      negotiate: (_, request) => viaNetwork(destinationReceiver.negotiate(asSource, request)),
      replicate: (_, meta, bundle) =>
        viaNetwork(destinationReceiver.replicate(asSource, meta, bundle)),
      preflight: (_, request) => viaNetwork(destinationReceiver.preflight(asSource, request)),
      takeover: (_, request) =>
        viaNetwork(destinationReceiver.takeover(asSource, request)).pipe(
          Effect.flatMap((answer) =>
            network.dropTakeoverAnswer
              ? Effect.fail(
                  new HandoffPeerError({
                    code: "unreachable",
                    message: "Minis did not answer.",
                    uncertain: true,
                  }),
                )
              : Effect.succeed(answer),
          ),
        ),
      heartbeat: (_, request) => viaNetwork(destinationReceiver.heartbeat(asSource, request)),
    });
    const moves = yield* Effect.gen(function* () {
      const receiver = yield* HandoffReceiver.make;
      return yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
      );
    }).pipe(Effect.provide(Layer.merge(sourceServices, Layer.succeed(HandoffPeers, peers))));
    // The source holds the lease and handoff mode is on for the thread.
    source.document = {
      ...source.document,
      threads: {
        [threadId]: {
          ...emptyThreadRecord(sourceProject),
          mode: "on",
          lease: {
            holderEnvironmentId: m4,
            holderLabel: "M4",
            holderThreadId: threadId,
            epoch: 1,
            renewedAt: "2026-10-20T14:00:00.000Z",
            state: "active",
          },
        },
      },
    };
    return {
      source,
      destination,
      moves,
      fixture,
      network,
      sourceRoot,
      destinationRoot,
      destinationReceiver,
      destinationServices,
      asSource,
    };
  });

const handOff = (moves: Effect.Success<ReturnType<typeof scenario>>["moves"]) =>
  moves.handOff({ threadId, destinationEnvironmentId: minis });

describe("handoff between two machines", () => {
  it.effect("moves a thread stopped by its usage limit and resumes it on the destination", () =>
    Effect.gen(function* () {
      const { source, destination, moves, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      const result = yield* handOff(moves);
      expect(result.machineLabel).toBe("Minis");

      // The destination holds the checkpoint and continued at epoch 2.
      const replica = findIncoming(destination.document, m4, threadId);
      expect(replica?.continuedThreadId).toBe(result.threadId);
      expect(git(destinationRoot, "rev-parse", incomingRef(m4, threadId))).toBe(
        source.document.threads[threadId]!.checkpoint!.commit,
      );
      expect(destination.document.threads[result.threadId]?.lease).toMatchObject({
        holderEnvironmentId: minis,
        epoch: 2,
        state: "active",
      });
      expect(destination.document.threads[result.threadId]?.sideEffects).toHaveLength(1);

      // The worktree sits at the base commit with the source's work as changes.
      const launch = destination.launches[0]!;
      expect(launch.workspaceStrategy.type).toBe("existing_worktree");
      const worktree = (launch.workspaceStrategy as { worktreePath: string }).worktreePath;
      expect(NodeFS.readFileSync(NodePath.join(worktree, "app.ts"), "utf8")).toBe(
        "export const a = 2;\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(worktree, "notes.md"), "utf8")).toBe("half done\n");
      expect(NodeFS.readFileSync(NodePath.join(worktree, ".env.local"), "utf8")).toBe(
        "TOKEN=minis\n",
      );
      expect(git(worktree, "rev-parse", "HEAD")).toBe(git(destinationRoot, "rev-parse", "HEAD"));
      expect(launch.initialMessage?.text).toContain("after its usage limit was reached");
      expect(launch.initialMessage?.text).toContain("pr-create anton-abyzov/app#12");

      // The source is fenced, linked and records where the thread runs now.
      expect(source.document.threads[threadId]?.continuedOn).toMatchObject({
        environmentId: minis,
        threadId: result.threadId,
      });
      expect(source.document.threads[threadId]?.lease).toMatchObject({ epoch: 2, state: "fenced" });
      const types = source.dispatched.map((command) => command.type);
      expect(types).toContain("thread.project-move.record");
      expect(
        source.dispatched.find((command) => command.type === "thread.project-move.record"),
      ).toMatchObject({
        link: { projectId: destinationProject, kind: "handoff", environmentId: minis },
      });
      expect(types).toContain("thread.execution.record");
      expect(destination.dispatched.map((command) => command.type)).toContain(
        "thread.execution.record",
      );

      // A retry returns the first result; it never makes a second thread.
      const again = yield* handOff(moves);
      expect(again.threadId).toBe(result.threadId);
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("leaves the source untouched when a preflight check fails", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture } = yield* scenario({ signedIn: false });
      fixture.activeRunId = "run-1";
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("invalid");
      expect(failure.message).toContain("Minis: no .env.local");
      expect(failure.message).toContain("Minis: Claude not signed in");
      expect(source.document.threads[threadId]?.lease).toMatchObject({ epoch: 1, state: "active" });
      expect(source.document.threads[threadId]?.continuedOn).toBeNull();
      expect(source.dispatched).toHaveLength(0);
      expect(fixture.activeRunId).toBe("run-1");
      expect(destination.launches).toHaveLength(0);
    }),
  );

  it.effect("never joins projects that are not explicitly linked", () =>
    Effect.gen(function* () {
      const { moves, destination } = yield* scenario({ linked: false });
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.message).toBe("Minis: this project is not linked here");
      expect(destination.document.incoming).toHaveLength(0);
    }),
  );

  it.effect("interrupts a running turn before the destination takes over", () =>
    Effect.gen(function* () {
      const { source, destination, moves, fixture, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      fixture.activeRunId = "run-1";
      const result = yield* handOff(moves);
      expect(source.dispatched[0]).toMatchObject({ type: "run.interrupt", cause: "agent" });
      expect(source.document.threads[threadId]?.fencedBy).toBe("handoff");
      // The second checkpoint, written after the stop, is the one handed over.
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.sequence).toBe(2);
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.runEnding).toBe(
        "handoff",
      );
      expect(destination.launches[0]?.initialMessage).toBeDefined();
      expect(result.threadId).toBe(destination.launches[0]?.threadId);
    }),
  );

  it.effect("stays paused when the takeover answer is lost, then a heartbeat fences it", () =>
    Effect.gen(function* () {
      const { source, destination, moves, network, destinationRoot } = yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      network.dropTakeoverAnswer = true;
      const failure = yield* handOff(moves).pipe(Effect.flip);
      expect(failure.code).toBe("unreachable");
      // The destination did continue; the source must not run the thread again.
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.lease?.state).toBe("handing-off");
      const retry = yield* handOff(moves).pipe(Effect.flip);
      expect(retry.code).toBe("busy");
      network.dropTakeoverAnswer = false;
      yield* moves.tick;
      expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(
        destination.launches[0]?.threadId,
      );
      expect(destination.launches).toHaveLength(1);
    }),
  );

  it.effect("refuses a delayed takeover at a stale epoch", () =>
    Effect.gen(function* () {
      const { source, moves, destinationRoot, destination, destinationReceiver, asSource } =
        yield* scenario();
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      // A newer epoch reached the destination first, so this takeover is stale.
      yield* handOff(moves).pipe(Effect.ignore);
      const stale = yield* destinationReceiver
        .takeover(asSource, {
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
          epoch: 1,
          sequence: 1,
          reason: "handoff",
          modelSelection: null,
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ code: "fenced", check: "lease" });
      expect(destination.launches).toHaveLength(1);
      expect(source.document.threads[threadId]?.lease?.state).toBe("fenced");
    }),
  );

  it.effect(
    "continues a silent source here after its lease went stale; the source fences on rejoin",
    () =>
      Effect.gen(function* () {
        const {
          moves,
          destinationReceiver,
          destination,
          source,
          destinationRoot,
          destinationServices,
        } = yield* scenario();
        NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
        // A turn end replicated checkpoint 1 to Minis; then M4 dropped off the network.
        yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
        const renewedAt = Date.parse(
          findIncoming(destination.document, m4, threadId)!.lease.renewedAt,
        );
        const minisMoves = yield* HandoffMoves.make.pipe(
          Effect.provideService(HandoffReceiver.HandoffReceiver, destinationReceiver),
          Effect.provideService(HandoffPeers, {} as never),
          Effect.provide(destinationServices),
        );
        yield* TestClock.setTime(renewedAt + 30_000);
        const early = yield* minisMoves
          .continueHere({ sourceEnvironmentId: m4, sourceThreadId: threadId })
          .pipe(Effect.flip);
        expect(early.code).toBe("busy");
        expect(destination.launches).toHaveLength(0);

        yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 1_000);
        const continued = yield* minisMoves.continueHere({
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
        });
        expect(destination.launches).toHaveLength(1);
        expect(destination.document.threads[continued.threadId]?.lease?.epoch).toBe(2);
        // The pull request the source opened is reused, never opened again.
        expect(
          guardSideEffect({
            record: destination.document.threads[continued.threadId],
            environmentId: minis,
            turnKey: threadTurnKey(continued.threadId, "run-9"),
            kind: "pr-create",
            target: "anton-abyzov/app#12",
          }).kind,
        ).toBe("reuse");
        // A repeat is the same continuation.
        const again = yield* minisMoves.continueHere({
          sourceEnvironmentId: m4,
          sourceThreadId: threadId,
        });
        expect(again.threadId).toBe(continued.threadId);
        expect(destination.launches).toHaveLength(1);

        // M4 comes back at the old epoch: its first heartbeat fences its copy.
        yield* moves.tick;
        expect(source.document.threads[threadId]?.continuedOn?.threadId).toBe(continued.threadId);
        expect(source.document.threads[threadId]?.lease?.state).toBe("fenced");
        // A late handoff from M4 answers with the continuation; it never starts another.
        const late = yield* handOff(moves);
        expect(late.threadId).toBe(continued.threadId);
        expect(destination.launches).toHaveLength(1);
      }),
  );

  it.effect("fences a running copy whose replica machines went silent past a stale lease", () =>
    Effect.gen(function* () {
      const { source, moves, fixture, network } = yield* scenario();
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      fixture.activeRunId = "run-1";
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      network.down = true;
      yield* TestClock.adjust("60 seconds");
      yield* moves.tick;
      expect(source.dispatched).toHaveLength(0);
      yield* TestClock.adjust("60 seconds");
      yield* moves.tick;
      expect(source.dispatched[0]).toMatchObject({ type: "run.interrupt", threadId });
      expect(source.document.pausedSince).not.toBeNull();
      // The peer answers again: the pause lifts and nothing is continued twice.
      network.down = false;
      yield* moves.tick;
      expect(source.document.pausedSince).toBeNull();
      expect(source.document.threads[threadId]?.continuedOn).toBeNull();
    }),
  );

  it.effect("replicates each checkpoint to the paired machines of the logical project", () =>
    Effect.gen(function* () {
      const { moves, destination, source, destinationRoot } = yield* scenario({
        sourceMembers: true,
      });
      NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
      yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
      const first = findIncoming(destination.document, m4, threadId)?.checkpoint.sequence;
      expect(first).toBe(1);
      // A turn end writes checkpoint 2; the next tick ships it without a handoff.
      yield* moves
        .preflight({ destinationEnvironmentId: m4, threadIds: [threadId] })
        .pipe(Effect.ignore);
      expect(source.document.threads[threadId]?.checkpoint?.sequence).toBe(2);
      yield* moves.tick;
      expect(findIncoming(destination.document, m4, threadId)?.checkpoint.sequence).toBe(2);
      expect(
        source.document.threads[threadId]?.replicas.find(
          (replica) => replica.environmentId === minis,
        ),
      ).toMatchObject({ state: "current", sequence: 2 });
    }),
  );
});
