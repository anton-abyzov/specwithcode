// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * Two or three machines in one process for the transfer record tests. Every
 * machine runs the real receiver and the real moves over its own handoff
 * document, its own transfer records and its own clone of one repository; a
 * stub peer client carries each call to the machine it names.
 *
 * A machine "restarts" by being booted again: it gets a new receiver and new
 * moves over the same document and records, as a server does after a crash.
 * A test cuts a move at an exact point by answering a call or a command with
 * `hang`, which never returns, and then restarting the machine.
 *
 * A machine marked `previous` answers as the latest release does, from the
 * rules pinned in `previousRelease381.test.fixture.ts`.
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
  type ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
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
import {
  EMPTY_HANDOFF_TRANSFER_DOCUMENT,
  type HandoffTransferMemory,
  HandoffTransferStore,
  makeMemory,
} from "./HandoffTransferStore.ts";
import {
  PREVIOUS_PEER_PATHS,
  PREVIOUS_PROTOCOL_VERSION,
  PreviousHeartbeatRequest,
  PreviousPeerPreflightRequest,
  PreviousTakeoverRequest,
  encodePreviousHeartbeatResponse,
  encodePreviousPreflightResponse,
  encodePreviousTakeoverResponse,
  overTheWire,
  previousHeartbeatContinued,
  previousMarkContinued,
  previousTakeoverVerdict,
} from "./previousRelease381.test.fixture.ts";

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

export const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never;

export type PeerCallPath =
  | "negotiate"
  | "replicate"
  | "preflight"
  | "takeover"
  | "heartbeat"
  | "transfer-status"
  | "transfer-pull";

export interface PeerCall {
  readonly from: EnvironmentId;
  readonly to: EnvironmentId;
  readonly path: PeerCallPath;
  readonly request: unknown;
}

/**
 * What the network does with one call. `lose-request` never reaches the other
 * machine; `lose-answer` reaches it and loses what it said; `hang` never
 * returns (the caller's process is about to be restarted) and
 * `deliver-then-hang` does so after the other machine handled the call; `wait`
 * holds the call back until the effect ends, to reorder two calls.
 */
export type NetworkVerdict =
  | "pass"
  | "lose-request"
  | "lose-answer"
  | "hang"
  | "deliver-then-hang"
  | { readonly wait: Effect.Effect<void> };

export interface RigThread {
  readonly title: string;
  activeRunId: string | null;
  worktreePath: string | null;
}

export interface RigMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId;
  readonly root: string;
  /** Answers as the latest release does. */
  readonly previous: boolean;
  document: HandoffDocument;
  readonly transfers: HandoffTransferMemory;
  readonly threads: Map<string, RigThread>;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly dispatched: Array<{ readonly type: string } & Record<string, unknown>>;
  /** How a run that is not running ended, for the next checkpoint. */
  runEnding: HandoffRunEnding;
  /** A turn that keeps running through an interrupt. */
  ignoreInterrupt: boolean;
  /** Runs before a command is applied; `Effect.never` cuts the caller there. */
  onDispatch: ((command: { readonly type: string }) => Effect.Effect<void>) | null;
  /** Runs before a continuation is launched; a failure fails the launch. */
  onLaunch:
    | ((
        input: ThreadLaunchService.ThreadLaunchInput,
      ) => Effect.Effect<void, { readonly message: string }>)
    | null;
  /** Runs after each change to the handoff document, with the document as written. */
  onDocument: ((document: HandoffDocument) => Effect.Effect<void>) | null;
  /** How many times this machine was started. */
  boots: number;
  receiver: HandoffReceiver.HandoffReceiver["Service"];
  moves: Effect.Success<typeof HandoffMoves.make>;
}

export interface Rig {
  readonly machines: ReadonlyArray<RigMachine>;
  readonly network: {
    readonly calls: Array<PeerCall>;
    /** Decides each call; absent or undefined passes it. */
    rule: ((call: PeerCall) => NetworkVerdict | undefined) | null;
    /** Runs once the other machine has handled a call, before its answer travels back. */
    afterDelivery: ((call: PeerCall) => Effect.Effect<void>) | null;
  };
  /** Starts the machine again over the same document and records. */
  readonly restart: (machine: RigMachine) => Effect.Effect<void>;
  /** A thread this machine runs, with handoff on and the lease held at epoch 1. */
  readonly addThread: (
    machine: RigMachine,
    threadId: ThreadId,
    options?: { readonly running?: boolean },
  ) => void;
  readonly callsOf: (path: PeerCallPath, to?: RigMachine) => ReadonlyArray<PeerCall>;
}

const silent = (label: string) =>
  new HandoffPeerError({
    code: "unreachable",
    message: `${label} did not answer.`,
    uncertain: true,
  });

const refused = (refusal: HandoffReceiver.HandoffRefusal) =>
  new HandoffPeerError({
    code: refusal.code,
    message: refusal.message,
    check: refusal.check,
    uncertain: refusal.uncertain === true,
  });

/** What this build's peer client makes of the previous release's 404 for a path it does not know. */
const unknownPath = (label: string) =>
  new HandoffPeerError({
    code: "invalid",
    check: "version",
    message: `Needs update: ${label} runs a SpecWithCode from before handoff transfer records. Update SpecWithCode on ${label} first.`,
    uncertain: false,
    needsUpdate: true,
  });

export const makeRig = (
  temporary: Array<string>,
  shape: ReadonlyArray<{ readonly name: string; readonly previous?: boolean }> = [
    { name: "a" },
    { name: "b" },
  ],
): Effect.Effect<Rig> =>
  Effect.gen(function* () {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-transfer-")),
    );
    temporary.push(base);
    const worktreesDir = NodePath.join(base, "worktrees");
    const sequences = new Map<string, number>();

    const machines: Array<RigMachine> = shape.map((entry, index) => {
      const root = NodePath.join(base, `${entry.name}-repo`);
      if (index === 0) {
        NodeFS.mkdirSync(root);
        git(root, "init", "-q", "-b", "main");
        NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 1;\n");
        git(root, "add", "-A");
        git(root, "commit", "-q", "-m", "base");
      } else {
        git(base, "clone", "-q", NodePath.join(base, `${shape[0]!.name}-repo`), root);
      }
      return {
        environmentId: EnvironmentId.make(`env-${entry.name}`),
        label: entry.name.toUpperCase(),
        projectId: ProjectId.make(`project-${entry.name}`),
        root,
        previous: entry.previous === true,
        document: EMPTY_HANDOFF_DOCUMENT,
        transfers: { document: EMPTY_HANDOFF_TRANSFER_DOCUMENT },
        threads: new Map(),
        launches: [],
        dispatched: [],
        runEnding: "usage-limit",
        ignoreInterrupt: false,
        onDispatch: null,
        onLaunch: null,
        onDocument: null,
        boots: 0,
        receiver: undefined as never,
        moves: undefined as never,
      };
    });
    const byId = new Map(machines.map((machine) => [machine.environmentId as string, machine]));
    const members = machines.map((machine) => ({
      environmentId: machine.environmentId,
      projectId: machine.projectId,
    }));
    const network: Rig["network"] = { calls: [], rule: null, afterDelivery: null };

    const handoffFor = (target: RigMachine) =>
      ({
        environmentId: target.environmentId,
        machineLabel: target.label,
        document: Effect.sync(() => target.document),
        updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
          Effect.suspend(() => {
            const [result, next] = change(target.document);
            target.document = next;
            return (target.onDocument?.(next) ?? Effect.void).pipe(Effect.as(result));
          }),
        snapshot: Effect.sync(() => ({}) as never),
        checkpoint: (threadId: ThreadId) =>
          Effect.promise(async () => {
            const thread = target.threads.get(threadId);
            const cwd = thread?.worktreePath ?? target.root;
            const written = await writeCheckpoint({ cwd, threadId });
            const key = `${target.environmentId}/${threadId}`;
            const sequence = (sequences.get(key) ?? 0) + 1;
            sequences.set(key, sequence);
            const record = target.document.threads[threadId] ?? emptyThreadRecord(target.projectId);
            const checkpoint: HandoffCheckpoint = {
              sequence,
              commit: written.commit,
              baseCommit: written.baseCommit,
              branch: written.branch,
              ref: written.ref,
              createdAt: "2026-11-19T14:00:00.000Z",
              reason: "handoff",
              skipped: [...written.skipped],
              excludedSecretCount: written.excludedSecretCount,
              requiredSecretPaths: [...written.requiredSecretPaths],
              transcriptMessageCount: 1,
              note: {
                done: "Fixed the types",
                next: "Run the build",
                openQuestions: "",
                createdAt: "2026-11-19T14:00:00.000Z",
              },
              pushedToOrigin: false,
              epoch: record.lease?.epoch ?? 0,
              latestRunId: null,
              turnKey: threadTurnKey(threadId, "run-1"),
              runEnding:
                record.fencedBy ?? (thread?.activeRunId == null ? target.runEnding : "active"),
              sideEffects: [],
              sourceRoot: {
                environmentId: target.environmentId,
                machineLabel: target.label,
                projectId: target.projectId,
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

    const projectOf = (target: RigMachine) => ({
      id: target.projectId,
      title: "App",
      workspaceRoot: target.root,
      workspaceSettings: { logicalProject: { members } },
    });

    const shellOf = (target: RigMachine, id: ThreadId) => {
      const thread = target.threads.get(id);
      return thread === undefined
        ? null
        : {
            id,
            projectId: target.projectId,
            title: thread.title,
            worktreePath: thread.worktreePath,
            activeRunId: thread.activeRunId,
            latestRunId: null,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            deletedAt: null,
          };
    };

    const servicesFor = (target: RigMachine) =>
      Layer.mergeAll(
        Layer.succeed(HandoffMode, handoffFor(target)),
        Layer.succeed(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            projectSettingsOverrides: {
              [target.projectId]: { defaultThreadEnvMode: "worktree" as const },
            },
          }),
        } as never),
        Layer.succeed(ServerConfig.ServerConfig, { worktreesDir } as never),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (id: ProjectId) =>
            Effect.succeed(id === target.projectId ? Option.some(projectOf(target)) : Option.none()),
          snapshot: Effect.succeed({ projects: [projectOf(target)] }),
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
            Effect.suspend(() => target.onLaunch?.(input) ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  target.launches.push(input);
                  const strategy = input.workspaceStrategy as
                    | { readonly type: string; readonly worktreePath?: string }
                    | undefined;
                  if (input.threadId !== undefined) {
                    target.threads.set(input.threadId, {
                      title: input.title ?? "Continued",
                      activeRunId: null,
                      worktreePath: strategy?.worktreePath ?? null,
                    });
                  }
                  return { threadId: input.threadId, projection: {}, resumed: false };
                }),
              ),
            ),
        } as never),
        Layer.succeed(Orchestrator.OrchestratorV2, {
          dispatch: (command: { type: string; threadId?: string }) =>
            Effect.suspend(() => target.onDispatch?.(command) ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  target.dispatched.push(command);
                  const thread =
                    command.threadId === undefined ? undefined : target.threads.get(command.threadId);
                  if (command.type === "run.interrupt" && !target.ignoreInterrupt && thread) {
                    thread.activeRunId = null;
                  }
                  return {};
                }),
              ),
            ),
        } as never),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadShell: (id: ThreadId) => Effect.sync(() => shellOf(target, id)),
          getThread: () => Effect.succeed({ execution: null }),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [{ role: "user", text: "Fix the build", streaming: false }],
            }),
        } as never),
      );

    /** The previous release's answer to one call, from its pinned rules. */
    const previousAnswer = (
      from: RigMachine,
      to: RigMachine,
      path: PeerCallPath,
      request: unknown,
    ): Effect.Effect<unknown, HandoffPeerError | HandoffReceiver.HandoffRefusal> =>
      Effect.gen(function* () {
        if (!PREVIOUS_PEER_PATHS.has(path)) {
          return yield* unknownPath(to.label);
        }
        const caller = { sourceEnvironmentId: from.environmentId, grant: unscopedGrant(from.environmentId) };
        // The route decodes a body with no parse options: fields it does not know are dropped.
        const json = overTheWire(request);
        const invalid = new HandoffReceiver.HandoffRefusal({
          status: 400,
          code: "invalid",
          message: "The request does not match this version.",
        });
        if (path === "negotiate") return yield* to.receiver.negotiate(caller, request as never);
        if (path === "preflight") {
          const decoded = Schema.decodeUnknownOption(PreviousPeerPreflightRequest)(json);
          if (Option.isNone(decoded)) return yield* invalid;
          return encodePreviousPreflightResponse({
            machineLabel: to.label,
            protocolVersion: PREVIOUS_PROTOCOL_VERSION,
            appVersion: "1.0.381",
            results: decoded.value.threads.map((thread) => ({
              sourceThreadId: thread.sourceThreadId,
              failures: [],
            })),
          });
        }
        if (path === "heartbeat") {
          const decoded = Schema.decodeUnknownOption(PreviousHeartbeatRequest)(json);
          if (Option.isNone(decoded)) return yield* invalid;
          const [continued, next] = previousHeartbeatContinued(
            to.document,
            decoded.value,
            "2026-11-19T14:00:00.000Z",
          );
          to.document = next;
          return encodePreviousHeartbeatResponse({ machineLabel: to.label, continued });
        }
        const decoded = Schema.decodeUnknownOption(PreviousTakeoverRequest)(json);
        if (Option.isNone(decoded)) return yield* invalid;
        const verdict = previousTakeoverVerdict(to.document, decoded.value, to.label);
        if (verdict.kind === "repeat") return verdict.response;
        if (verdict.kind === "refuse") {
          return yield* new HandoffReceiver.HandoffRefusal({
            status: 409,
            code: verdict.code,
            message: verdict.message,
            check: verdict.check,
          });
        }
        const response = encodePreviousTakeoverResponse({
          threadId: HandoffReceiver.continuationThreadId(
            decoded.value.sourceEnvironmentId,
            decoded.value.sourceThreadId,
            decoded.value.epoch,
          ),
          projectId: to.projectId,
          machineLabel: to.label,
          modelSelection: decoded.value.modelSelection,
          resumed: true,
          notice: null,
        });
        to.launches.push({ threadId: response.threadId } as never);
        to.document = previousMarkContinued(
          to.document,
          decoded.value,
          response as never,
          "2026-11-19T14:00:00.000Z",
        );
        return response;
      });
    const currentAnswer = (
      from: RigMachine,
      to: RigMachine,
      path: PeerCallPath,
      request: unknown,
      bundle: unknown,
    ): Effect.Effect<unknown, HandoffReceiver.HandoffRefusal> => {
      const caller = { sourceEnvironmentId: from.environmentId, grant: unscopedGrant(from.environmentId) };
      switch (path) {
        case "negotiate":
          return to.receiver.negotiate(caller, request as never);
        case "replicate":
          return to.receiver.replicate(caller, request as never, bundle as never);
        case "preflight":
          return to.receiver.preflight(caller, request as never);
        case "takeover":
          return to.receiver.takeover(caller, request as never);
        case "heartbeat":
          return to.receiver.heartbeat(caller, request as never);
        case "transfer-status":
          return to.receiver.transferStatus(caller, request as never);
        case "transfer-pull":
          return to.receiver.transferPull(caller, request as never);
      }
    };

    const send = (
      from: RigMachine,
      destination: EnvironmentId,
      path: PeerCallPath,
      request: unknown,
      bundle?: unknown,
    ): Effect.Effect<never, HandoffPeerError> =>
      Effect.suspend(() => {
        const to = byId.get(destination);
        if (to === undefined) return Effect.fail(silent(String(destination)));
        const call: PeerCall = { from: from.environmentId, to: to.environmentId, path, request };
        network.calls.push(call);
        const verdict = network.rule?.(call) ?? "pass";
        if (verdict === "lose-request") return Effect.fail(silent(to.label));
        if (verdict === "hang") return Effect.never;
        const answered = (
          to.previous && path !== "replicate"
            ? previousAnswer(from, to, path, request)
            : currentAnswer(from, to, path, request, bundle)
        ).pipe(
          Effect.mapError((error) => (error._tag === "HandoffRefusal" ? refused(error) : error)),
        );
        const handled = answered.pipe(
          Effect.onExit(() => network.afterDelivery?.(call) ?? Effect.void),
        );
        const timed =
          typeof verdict === "object" ? verdict.wait.pipe(Effect.andThen(handled)) : handled;
        if (verdict === "deliver-then-hang") {
          return timed.pipe(Effect.result, Effect.andThen(Effect.never));
        }
        return verdict === "lose-answer"
          ? timed.pipe(Effect.result, Effect.andThen(Effect.fail(silent(to.label))))
          : timed;
      }) as Effect.Effect<never, HandoffPeerError>;

    const peersFor = (self: RigMachine) => {
      const others = machines
        .filter((machine) => machine !== self)
        .map((machine) => ({
          machineId: machine.label.toLowerCase(),
          environmentId: machine.environmentId,
          label: machine.label,
        }));
      const unused = () => Effect.die("unused");
      return HandoffPeers.of({
        target: (environmentId) =>
          Effect.succeed(others.find((other) => other.environmentId === environmentId) ?? others[0]!),
        targets: Effect.succeed(others),
        negotiate: (to, request) => send(self, to, "negotiate", request),
        replicate: (to, meta, bundle) => send(self, to, "replicate", meta, bundle),
        preflight: (to, request) => send(self, to, "preflight", request),
        takeover: (to, request) => send(self, to, "takeover", request),
        heartbeat: (to, request) => send(self, to, "heartbeat", request),
        transferStatus: (to, request) => send(self, to, "transfer-status", request),
        transferPull: (to, request) => send(self, to, "transfer-pull", request),
        coordinatorLease: unused,
        coordinatorReplica: unused,
        memoryExport: unused,
        memoryMerge: unused,
        linkedDigest: unused,
        linkedContent: unused,
        linkedReplica: unused,
        linkedSupersede: unused,
        linkedMembers: unused,
        reachable: unused,
        planExport: unused,
        planMerge: unused,
        extrasNegotiate: unused,
        extrasReplicate: unused,
      });
    };

    const restart = (machine: RigMachine) =>
      Effect.gen(function* () {
        const store = yield* makeMemory(machine.transfers);
        const services = Layer.mergeAll(
          servicesFor(machine),
          Layer.succeed(HandoffTransferStore, store),
          Layer.succeed(HandoffPeers, peersFor(machine)),
          Layer.succeed(HandoffConnectivity, { probe: Effect.succeed("online" as const) }),
        );
        const receiver = yield* HandoffReceiver.make.pipe(Effect.provide(services));
        const moves = yield* HandoffMoves.make.pipe(
          Effect.provideService(HandoffReceiver.HandoffReceiver, receiver),
          Effect.provide(services),
        );
        machine.receiver = receiver;
        machine.moves = moves;
        machine.boots += 1;
      }).pipe(Effect.orDie);

    for (const machine of machines) yield* restart(machine);

    return {
      machines,
      network,
      restart,
      addThread: (machine, threadId, options) => {
        machine.threads.set(threadId, {
          title: `Thread ${threadId}`,
          activeRunId: options?.running === true ? `run:${threadId}` : null,
          worktreePath: null,
        });
        machine.document = {
          ...machine.document,
          threads: {
            ...machine.document.threads,
            [threadId]: {
              ...emptyThreadRecord(machine.projectId),
              mode: "on",
              lease: {
                holderEnvironmentId: machine.environmentId,
                holderLabel: machine.label,
                holderThreadId: threadId,
                epoch: 1,
                renewedAt: "2026-11-19T14:00:00.000Z",
                state: "active",
              },
            },
          },
        };
      },
      callsOf: (path, to) =>
        network.calls.filter(
          (call) => call.path === path && (to === undefined || call.to === to.environmentId),
        ),
    };
  });
