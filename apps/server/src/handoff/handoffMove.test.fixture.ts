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
import { afterEach } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  HANDOFF_LEASE_STALE_MS,
  type HandoffCheckpoint,
  type HandoffRunEnding,
  type ServerSettings as ServerSettingsValue,
  ProjectId,
  ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffConnectivity, type HandoffConnectivityState } from "./handoffConnectivity.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffMoves from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import { HANDOFF_PROTOCOL_VERSION } from "./handoffWire.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  findIncoming,
  type HandoffDocument,
} from "./handoffState.ts";

const temporary: Array<string> = [];

/** Removes temporary directories after every test; each suite file calls it once at top level. */
export function registerCleanup(): void {
  afterEach(() => {
    for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
  });
}

export const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
export const git = (cwd: string, ...args: Array<string>) =>
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

export function directory(): string {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-move-")),
  );
  temporary.push(base);
  return base;
}

export const m4 = EnvironmentId.make("env-m4");
export const minis = EnvironmentId.make("env-minis");
export const sourceProject = ProjectId.make("project-m4");
export const destinationProject = ProjectId.make("project-minis");
export const threadId = ThreadId.make("thread:fix-build");
export const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;

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

export const scenario = (
  options: {
    readonly linked?: boolean;
    readonly destinationSettings?: Partial<ServerSettingsValue>;
    /** The destination project's Use worktrees switch; on unless a case turns it off. */
    readonly destinationUsesWorktrees?: boolean;
    readonly destinationRepositoryName?: string;
    readonly signedIn?: boolean;
    readonly sourceMembers?: boolean;
    readonly sourcePersonal?: boolean;
    readonly children?: HandoffCheckpoint["children"];
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
    const destinationRoot = NodePath.join(base, options.destinationRepositoryName ?? "minis-repo");
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
      /** A turn that keeps running through an interrupt. */
      ignoreInterrupt: false,
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
              ...(options.children === undefined ? {} : { children: options.children }),
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
        target === source && options.sourcePersonal === true
          ? { kind: "personal" }
          : target === source && options.sourceMembers === true
            ? {
                logicalProject: {
                  members: [{ environmentId: minis, projectId: destinationProject }],
                },
              }
            : target === destination && options.linked !== false
              ? {
                  logicalProject: {
                    members: [
                      { environmentId: m4, projectId: sourceProject },
                      { environmentId: minis, projectId: destinationProject },
                    ],
                  },
                }
              : undefined,
    });

    const servicesFor = (target: Machine, roots: { project: ProjectId; root: string }) =>
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor(target)),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            ...options.destinationSettings,
            projectSettingsOverrides: {
              ...options.destinationSettings?.projectSettingsOverrides,
              [destinationProject]: {
                ...options.destinationSettings?.projectSettingsOverrides?.[destinationProject],
                ...(options.destinationUsesWorktrees === false
                  ? {}
                  : { defaultThreadEnvMode: "worktree" as const }),
              },
            },
          }),
        } as never),
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
              if (command.type === "run.interrupt" && !fixture.ignoreInterrupt) {
                fixture.activeRunId = null;
              }
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
    const network = {
      down: false,
      dropTakeoverAnswer: false,
      dropTakeoverRequest: false,
      refuseTakeover: null as "fenced" | "busy" | null,
      /** A takeover failure that never came from the destination. */
      failTakeover: null as HandoffPeerError | null,
      /** Checkpoint shipments started to the destination (each negotiates first). */
      shipments: 0,
      olderDestination: false,
      newerDestination: false,
      /** What a probe of this machine's own network (SpecWithCode Connect) answers. */
      connect: "online" as HandoffConnectivityState,
      connectProbes: 0,
    };
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
      negotiate: (_, request) => {
        network.shipments += 1;
        return viaNetwork(destinationReceiver.negotiate(asSource, request));
      },
      replicate: (_, meta, bundle) =>
        viaNetwork(destinationReceiver.replicate(asSource, meta, bundle)),
      preflight: (_, request) =>
        viaNetwork(destinationReceiver.preflight(asSource, request)).pipe(
          // A destination from before the version check sends no versions.
          Effect.map(({ protocolVersion: _p, appVersion: _a, ...answer }) =>
            network.olderDestination
              ? answer
              : network.newerDestination
                ? {
                    ...answer,
                    protocolVersion: HANDOFF_PROTOCOL_VERSION + 1,
                    appVersion: "9.0.0",
                    // What a newer destination's own check sends back.
                    results: answer.results.map((result) => ({
                      ...result,
                      failures: [
                        {
                          check: "version" as const,
                          message:
                            "The source machine runs SpecWithCode 1.0.0 and Minis runs 9.0.0; they cannot hand off between these versions. Update the source machine first.",
                        },
                        ...result.failures,
                      ],
                    })),
                  }
                : { ...answer, protocolVersion: _p, appVersion: _a },
          ),
        ),
      takeover: (_, request) =>
        (network.failTakeover !== null
          ? Effect.fail(network.failTakeover)
          : network.refuseTakeover !== null
            ? Effect.fail(
                new HandoffPeerError({
                  code: network.refuseTakeover,
                  message: `Minis refused the takeover (${network.refuseTakeover}).`,
                  uncertain: false,
                }),
              )
            : network.dropTakeoverRequest
              ? Effect.fail(
                  new HandoffPeerError({
                    code: "unreachable",
                    message: "Minis did not answer.",
                    uncertain: true,
                  }),
                )
              : viaNetwork(destinationReceiver.takeover(asSource, request))
        ).pipe(
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
      coordinatorLease: () => Effect.die("unused"),
      coordinatorReplica: () => Effect.die("unused"),
      memoryExport: () => Effect.die("unused"),
      memoryMerge: () => Effect.die("unused"),
      linkedDigest: () => Effect.die("unused"),
      linkedContent: () => Effect.die("unused"),
      linkedReplica: () => Effect.die("unused"),
      linkedSupersede: () => Effect.die("unused"),
      linkedMembers: () => Effect.die("unused"),
      reachable: () => Effect.die("unused"),
      planExport: () => Effect.die("unused"),
      planMerge: () => Effect.die("unused"),
      extrasNegotiate: () => Effect.die("unused"),
      extrasReplicate: () => Effect.die("unused"),
    });
    const moves = yield* Effect.gen(function* () {
      const receiver = yield* HandoffReceiver.make;
      return yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          sourceServices,
          Layer.succeed(HandoffPeers, peers),
          Layer.succeed(HandoffConnectivity, {
            probe: Effect.sync(() => {
              network.connectProbes += 1;
              return network.connect;
            }),
          }),
        ),
      ),
    );
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

export const handOff = (moves: Effect.Success<ReturnType<typeof scenario>>["moves"]) =>
  moves.handOff({ threadId, destinationEnvironmentId: minis });

/** How the source answers Minis's direct probe before Continue here. */
export const probedSource = (
  answer: "silent" | "awake" | "refuses" | "local",
  probes: Array<unknown> = [],
) =>
  ({
    negotiate: (_: unknown, request: unknown) => {
      probes.push(request);
      switch (answer) {
        case "awake":
          return Effect.succeed({ known: [] });
        case "refuses":
          return Effect.fail(
            new HandoffPeerError({
              code: "needs_grant",
              check: "grant",
              message: "M4: this machine's work grant there was revoked",
              uncertain: false,
            }),
          );
        case "local":
          return Effect.fail(
            new HandoffPeerError({
              code: "needs_grant",
              check: "grant",
              message: "M4: this machine has no work grant there",
              uncertain: false,
              local: true,
            }),
          );
        default:
          return Effect.fail(
            new HandoffPeerError({
              code: "unreachable",
              message: "M4 did not answer.",
              uncertain: true,
            }),
          );
      }
    },
  }) as unknown as HandoffPeers["Service"];

/** Minis, holding a replica of the M4 thread whose lease went stale, with moves of its own. */
export const staleReplicaOnMinis = (
  source: Parameters<typeof probedSource>[0],
  options: {
    /** What a probe of Minis's own network answers; unprovided, nothing can be shown. */
    readonly connect?: HandoffConnectivityState;
    readonly heartbeat?: HandoffPeers["Service"]["heartbeat"];
  } = {},
) =>
  Effect.gen(function* () {
    const setup = yield* scenario();
    const { moves, destinationReceiver, destination, destinationRoot, destinationServices } = setup;
    NodeFS.writeFileSync(NodePath.join(destinationRoot, ".env.local"), "TOKEN=minis\n");
    yield* moves.preflight({ destinationEnvironmentId: minis, threadIds: [threadId] });
    const renewedAt = Date.parse(findIncoming(destination.document, m4, threadId)!.lease.renewedAt);
    const probes: Array<unknown> = [];
    const connect = options.connect;
    const minisMoves = yield* HandoffMoves.make.pipe(
      Effect.provideService(HandoffReceiver.HandoffReceiver, destinationReceiver),
      Effect.provideService(HandoffPeers, {
        ...probedSource(source, probes),
        ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
      }),
      Effect.provide(destinationServices),
      connect === undefined
        ? (effect) => effect
        : Effect.provideService(HandoffConnectivity, { probe: Effect.succeed(connect) }),
    );
    yield* TestClock.setTime(renewedAt + HANDOFF_LEASE_STALE_MS + 1_000);
    const continueHere = minisMoves.continueHere({
      sourceEnvironmentId: m4,
      sourceThreadId: threadId,
    });
    return { ...setup, minisMoves, probes, continueHere };
  });
