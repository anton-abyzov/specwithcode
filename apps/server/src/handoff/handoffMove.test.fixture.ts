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
import { afterEach, expect } from "@effect/vitest";
import {
  type AwayConfig,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
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
import * as Schema from "effect/Schema";

import type { AwayPeerPost } from "../away/awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore } from "../away/awaySleepRoute.ts";
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
import * as Peers from "./handoffPeers.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import * as HandoffTransferStore from "./HandoffTransferStore.ts";
import { HANDOFF_PROTOCOL_VERSION } from "./handoffWire.ts";
import { EMPTY_HANDOFF_DOCUMENT, emptyThreadRecord, type HandoffDocument } from "./handoffState.ts";

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

class LaunchRefusedError extends Schema.TaggedError<LaunchRefusedError>()("LaunchRefusedError", {
  message: Schema.String,
}) {}

/**
 * A destination's refusal as the source reads it over the network: the route's own
 * answer (status and JSON body) read back by the source's own classifier. Both are
 * read through their namespaces, so a suite run against sources that do not share
 * them yet maps a refusal as the destination named it.
 */
export function overTheWire(label: string, refusal: HandoffReceiver.HandoffRefusal) {
  const encode = HandoffReceiver.refusalAnswer as typeof HandoffReceiver.refusalAnswer | undefined;
  const classify = Peers.refusedAnswer as typeof Peers.refusedAnswer | undefined;
  if (encode === undefined || classify === undefined) {
    return new HandoffPeerError({
      code: refusal.code,
      message: refusal.message,
      check: refusal.check,
      uncertain: false,
    });
  }
  const answer = encode(refusal);
  return classify(label, answer.status, JSON.parse(JSON.stringify(answer.body)) as unknown);
}

/** The receiver calls a source machine makes over the network. */
type WireReceiver = Pick<
  HandoffReceiver.HandoffReceiver["Service"],
  "negotiate" | "replicate" | "preflight" | "takeover" | "heartbeat"
>;

/** A thread a launch on `target` created, as its thread store reads it. */
function launchedShell(target: Machine, id: ThreadId) {
  const launched = target.launches.find((launch) => launch.threadId === id);
  if (launched === undefined) return null;
  return {
    id,
    projectId: launched.projectId,
    title: launched.title,
    worktreePath: null,
    activeRunId: null,
    latestRunId: null,
    modelSelection: launched.modelSelection,
    runtimeMode: launched.runtimeMode,
    interactionMode: launched.interactionMode,
    deletedAt: null,
  };
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
      /** How a launch on the destination ends: before its thread exists, or after. */
      launch: "starts" as "starts" | "fails" | "fails-after-create",
      /** The destination's thread store cannot be read. */
      destinationShellsUnreadable: false,
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
            Effect.gen(function* () {
              if (fixture.launch === "fails") {
                return yield* Effect.fail(
                  new LaunchRefusedError({ message: "the provider did not start" }),
                );
              }
              target.launches.push(input);
              if (fixture.launch === "fails-after-create") {
                return yield* Effect.fail(
                  new LaunchRefusedError({ message: "the first message did not go" }),
                );
              }
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
          getThreadShell: (id: ThreadId) =>
            target === destination && fixture.destinationShellsUnreadable
              ? Effect.die("the thread store cannot be read")
              : Effect.sync(() => launchedShell(target, id)),
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
    /**
     * What answers for Minis on the network: its receiver, or one a case swaps in on
     * the same stores (an earlier release's, as before Minis updated).
     */
    const wire: { destination: WireReceiver } = { destination: destinationReceiver };
    const asSource = { sourceEnvironmentId: m4, grant: unscopedGrant(m4) };
    const network = {
      down: false,
      dropTakeoverAnswer: false,
      /** The destination refused the takeover, and that answer never came back. */
      dropTakeoverRefusal: false,
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
        : effect.pipe(Effect.mapError((refusal) => overTheWire("Minis", refusal)));
    const peers = HandoffPeers.of({
      target: () => Effect.succeed({ machineId: "minis", environmentId: minis, label: "Minis" }),
      targets: Effect.succeed([{ machineId: "minis", environmentId: minis, label: "Minis" }]),
      negotiate: (_, request) => {
        network.shipments += 1;
        return viaNetwork(wire.destination.negotiate(asSource, request));
      },
      replicate: (_, meta, bundle) =>
        viaNetwork(wire.destination.replicate(asSource, meta, bundle)),
      preflight: (_, request) =>
        viaNetwork(wire.destination.preflight(asSource, request)).pipe(
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
              : viaNetwork(wire.destination.takeover(asSource, request)).pipe(
                  Effect.mapError((error) =>
                    network.dropTakeoverRefusal
                      ? new HandoffPeerError({
                          code: "unreachable",
                          message: "Minis did not answer.",
                          uncertain: true,
                        })
                      : error,
                  ),
                )
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
      heartbeat: (_, request) => viaNetwork(wire.destination.heartbeat(asSource, request)),
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
      // A receiver from before transfer records has no such route.
      transferStatus: (_, request) =>
        wire.destination === destinationReceiver
          ? viaNetwork(destinationReceiver.transferStatus(asSource, request))
          : Effect.fail(
              new HandoffPeerError({
                code: "invalid",
                message: "Minis needs an update to answer for a handoff.",
                uncertain: false,
                needsUpdate: true,
              }),
            ),
      transferPull: () => Effect.die("unused"),
    });
    /** The source's transfer records; a case empties them to stand for an earlier release. */
    const transfers: HandoffTransferStore.HandoffTransferMemory = {
      document: HandoffTransferStore.EMPTY_HANDOFF_TRANSFER_DOCUMENT,
    };
    const moves = yield* Effect.gen(function* () {
      const receiver = yield* HandoffReceiver.make;
      return yield* HandoffMoves.make.pipe(
        Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          sourceServices,
          Layer.effect(
            HandoffTransferStore.HandoffTransferStore,
            HandoffTransferStore.makeMemory(transfers),
          ),
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
      sourceServices,
      peers,
      wire,
      asSource,
      transfers,
    };
  });

export const handOff = (moves: Effect.Success<ReturnType<typeof scenario>>["moves"]) =>
  moves.handOff({ threadId, destinationEnvironmentId: minis });

/** The lid closes on M4, on this release: the desktop's notice, then a window's ask. */
export const suspend = (moves: Effect.Success<ReturnType<typeof scenario>>["moves"]) =>
  Effect.gen(function* () {
    const posted: Array<string> = [];
    const post: AwayPeerPost = (_target, path) =>
      Effect.sync(() => {
        posted.push(path);
        return { status: 200, json: {} };
      });
    const config: AwayConfig = {
      target: minis,
      sleepTrigger: "always",
      graceMinutes: 2,
      bringBack: "prompt",
      coordinatorScope: "live",
    };
    const away = yield* makeAwaySleep({
      self: m4,
      store: memorySleepStore(),
      config: Effect.succeed(config),
      post,
    });
    const notice = yield* away.sleep({ onBattery: true });
    yield* notice.send;
    expect(notice.answer).toEqual({ outcome: "skipped" });
    expect(posted).toEqual([]);
    const refused = yield* moves
      .handOffMachine({ destinationEnvironmentId: minis, reason: "sleep" })
      .pipe(Effect.flip);
    expect(refused.code).toBe("invalid");
  });
