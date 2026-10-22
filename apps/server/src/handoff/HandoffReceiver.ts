// @effect-diagnostics nodeBuiltinImport:off - the receiver writes bundles and worktrees with Git.
/**
 * The destination half of a handoff (0967). Another machine (or this one,
 * for a model change or "Continue here") replicates checkpoints here,
 * preflights threads, takes one over at a newer lease epoch, and heartbeats
 * the leases it holds. A takeover materializes the worktree (the base commit
 * plus the checkpoint tree), then starts the continuation thread: a fresh
 * provider session seeded from the checkpoint, never a migrated process.
 *
 * Every request names its source; a remote request arrives with the source's
 * work grant, and a project joins only through an explicit link (0948).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  appendThreadExecutionHistory,
  CommandId,
  type EnvironmentId,
  type HandoffModeErrorCode,
  type HandoffPreflightCheck,
  type HandoffPreflightFailure,
  type ModelSelection,
  type Project,
  type ProjectId,
  type ServerProvider,
  ThreadId,
  type ThreadExecutionReason,
  type ThreadExecutionRecord,
} from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { projectInGrant, type EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { runGit } from "../fleet/folderTransfer/git.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  applyBundle,
  applyCheckpointToWorktree,
  availableBranch,
  BundleError,
  copyRequiredFiles,
  incomingRef,
  knownCommits,
  missingFiles,
  pinCommit,
  refCommit,
  resolveRepositoryPath,
} from "./bundleGit.ts";
import { refComponent } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import {
  handoffSeed,
  type PreflightProvider,
  preflightFailures,
  shouldResume,
} from "./handoffPreflight.ts";
import {
  emptyThreadRecord,
  findIncoming,
  heartbeatContinued,
  incomingKey,
  linkedLocalProject,
  markContinued,
  takeoverVerdict,
  upsertIncoming,
} from "./handoffState.ts";
import type {
  HeartbeatRequest,
  HeartbeatResponse,
  NegotiateRequest,
  NegotiateResponse,
  PeerPreflightRequest,
  PeerPreflightResponse,
  ReplicateMeta,
  ReplicateResponse,
  TakeoverReason,
  TakeoverRequest,
  TakeoverResponse,
} from "./handoffWire.ts";
import { HANDOFF_APP_VERSION, HANDOFF_PROTOCOL_VERSION, versionFailure } from "./handoffWire.ts";

/** A refusal the source reports verbatim; nothing changed here. */
export class HandoffRefusal extends Data.TaggedError("HandoffRefusal")<{
  readonly status: number;
  readonly code: HandoffModeErrorCode;
  readonly message: string;
  readonly check?: HandoffPreflightCheck | undefined;
}> {}

/** Who is asking. `grant` is null for a request this machine makes of itself. */
export interface ReceiverCaller {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly grant: EffectiveWorkGrant | null;
}

const refuse = (
  status: number,
  code: HandoffModeErrorCode,
  message: string,
  check?: HandoffPreflightCheck,
) => new HandoffRefusal({ status, code, message, ...(check === undefined ? {} : { check }) });

const describe = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

const fromBundleError = (label: string, cause: unknown) => {
  if (cause instanceof BundleError) {
    const code: HandoffModeErrorCode =
      cause.code === "too_large" ? "too_large" : cause.code === "failed" ? "failed" : "invalid";
    return refuse(cause.code === "failed" ? 500 : 409, code, `${label}: ${cause.message}`);
  }
  return refuse(500, "failed", `${label}: ${describe(cause)}`);
};

const EXECUTION_REASON: Readonly<Record<TakeoverReason, ThreadExecutionReason>> = {
  handoff: "handoff",
  "machine-handoff": "machine-handoff",
  sleep: "sleep",
  "continue-here": "continue-here",
  "auto-takeover": "auto-takeover",
};

/** The continuation's id: the same for every attempt at one takeover, so a retry never forks. */
export function continuationThreadId(
  sourceEnvironmentId: string,
  sourceThreadId: string,
  epoch: number,
): ThreadId {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${sourceEnvironmentId}\u0000${sourceThreadId}\u0000${epoch}`)
    .digest("hex")
    .slice(0, 32);
  return ThreadId.make(`handoff:${digest}`);
}

function toPreflightProvider(provider: ServerProvider): PreflightProvider {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName,
    enabled: provider.enabled,
    installed: provider.installed,
    authStatus: provider.auth.status,
    models: provider.models.map((model) => ({
      slug: model.slug,
      ...(model.aliases === undefined ? {} : { aliases: model.aliases }),
    })),
  };
}

export class HandoffReceiver extends Context.Service<
  HandoffReceiver,
  {
    readonly negotiate: (
      caller: ReceiverCaller,
      request: NegotiateRequest,
    ) => Effect.Effect<NegotiateResponse, HandoffRefusal>;
    /** `bundle` null or empty: the checkpoint commit must already be here. */
    readonly replicate: (
      caller: ReceiverCaller,
      meta: ReplicateMeta,
      bundle: Uint8Array | null,
    ) => Effect.Effect<ReplicateResponse, HandoffRefusal>;
    readonly preflight: (
      caller: ReceiverCaller,
      request: PeerPreflightRequest,
    ) => Effect.Effect<PeerPreflightResponse, HandoffRefusal>;
    readonly takeover: (
      caller: ReceiverCaller,
      request: TakeoverRequest,
    ) => Effect.Effect<TakeoverResponse, HandoffRefusal>;
    readonly heartbeat: (
      caller: ReceiverCaller,
      request: HeartbeatRequest,
    ) => Effect.Effect<HeartbeatResponse, HandoffRefusal>;
  }
>()("specweave-studio/handoff/HandoffReceiver") {}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const config = yield* ServerConfig.ServerConfig;
  const locks = yield* KeyedLock.make<string>();
  const label = handoff.machineLabel;
  const at = (message: string) => `${label}: ${message}`;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const sameSource = (caller: ReceiverCaller, sourceEnvironmentId: string) =>
    caller.sourceEnvironmentId === sourceEnvironmentId
      ? Effect.void
      : Effect.fail(
          refuse(403, "invalid", at("the request names another machine than the one asking")),
        );

  const document = handoff.document.pipe(
    Effect.mapError((error) => refuse(500, "failed", at(error.message))),
  );
  const updateDocument = <A>(
    change: Parameters<typeof handoff.updateDocument<A>>[0],
  ): Effect.Effect<A, HandoffRefusal> =>
    handoff
      .updateDocument(change)
      .pipe(Effect.mapError((error) => refuse(500, "failed", at(error.message))));

  /** The local project for the source project: the same one on this machine, else an explicit link. */
  const localProject = (sourceEnvironmentId: string, sourceProjectId: ProjectId) =>
    projects.snapshot.pipe(
      Effect.mapError(() => refuse(500, "failed", at("could not read its projects"))),
      Effect.map((snapshot): Project | null => {
        if (sourceEnvironmentId === handoff.environmentId) {
          return snapshot.projects.find((project) => project.id === sourceProjectId) ?? null;
        }
        return linkedLocalProject(snapshot.projects, sourceEnvironmentId, sourceProjectId);
      }),
    );

  const inGrant = (caller: ReceiverCaller, project: Project) =>
    caller.grant === null ||
    projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project);

  const requireProject = (caller: ReceiverCaller, sourceProjectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* localProject(caller.sourceEnvironmentId, sourceProjectId);
      if (project === null) {
        return yield* refuse(409, "invalid", at("this project is not linked here"), "project-link");
      }
      if (!inGrant(caller, project)) {
        return yield* refuse(403, "needs_grant", at(`no work grant for ${project.title}`), "grant");
      }
      return project;
    });

  const repositoryRoot = (project: Project, repositoryPath: string) =>
    Effect.tryPromise({
      try: () => resolveRepositoryPath(project.workspaceRoot, repositoryPath),
      catch: (cause) => fromBundleError(label, cause),
    });

  const negotiate = (caller: ReceiverCaller, request: NegotiateRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
      const project = yield* requireProject(caller, request.sourceProjectId);
      const root = yield* repositoryRoot(project, request.repositoryPath);
      const known = yield* Effect.tryPromise({
        try: () => knownCommits(root, request.candidates),
        catch: (cause) => fromBundleError(label, cause),
      });
      return { known } satisfies NegotiateResponse;
    });

  const replicate = (caller: ReceiverCaller, meta: ReplicateMeta, bundle: Uint8Array | null) =>
    Effect.gen(function* () {
      yield* sameSource(caller, meta.sourceEnvironmentId);
      const project = yield* requireProject(caller, meta.sourceProjectId);
      const root = yield* repositoryRoot(project, meta.repositoryPath);
      const targetRef = incomingRef(meta.sourceEnvironmentId, meta.sourceThreadId);
      const commit = meta.checkpoint.commit;
      yield* Effect.tryPromise({
        try: async () => {
          if (bundle === null || bundle.byteLength === 0) {
            await pinCommit({ root, commit, targetRef });
            return;
          }
          const scratch = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "swc-handoff-incoming-"),
          );
          try {
            const bundlePath = NodePath.join(scratch, "checkpoint.bundle");
            await NodeFSP.writeFile(bundlePath, bundle, { mode: 0o600 });
            await applyBundle({ root, bundlePath, commit, targetRef });
          } finally {
            await NodeFSP.rm(scratch, { recursive: true, force: true });
          }
        },
        catch: (cause) => fromBundleError(label, cause),
      });
      const now = yield* nowIso;
      const verdict = yield* updateDocument((current) => {
        const result = upsertIncoming(current, {
          meta,
          projectId: project.id,
          machineLabel: label,
          now,
        });
        return [result, result.kind === "stored" ? result.document : current] as const;
      });
      if (verdict.kind === "refused") return yield* refuse(409, verdict.code, verdict.message);
      const stored = findIncoming(verdict.document, meta.sourceEnvironmentId, meta.sourceThreadId);
      return { sequence: stored?.checkpoint.sequence ?? meta.checkpoint.sequence };
    });

  const providerFor = (modelSelection: ModelSelection) =>
    providers.getProviders.pipe(
      Effect.map(
        (list) =>
          list.find((provider) => provider.instanceId === modelSelection.instanceId) ?? null,
      ),
      Effect.map((provider) => (provider === null ? null : toPreflightProvider(provider))),
    );

  /** Every failing check for one thread, worded for the user. */
  const threadFailures = (
    caller: ReceiverCaller,
    input: {
      readonly sourceThreadId: ThreadId;
      readonly sourceProjectId: ProjectId;
      readonly sequence: number;
      readonly modelSelection: ModelSelection | null;
    },
  ) =>
    Effect.gen(function* () {
      const current = yield* document;
      const replica = findIncoming(current, caller.sourceEnvironmentId, input.sourceThreadId);
      const detail = (current.incomingDetails ?? {})[
        incomingKey(caller.sourceEnvironmentId, input.sourceThreadId)
      ];
      const project = yield* localProject(caller.sourceEnvironmentId, input.sourceProjectId);
      const modelSelection = input.modelSelection ?? detail?.modelSelection ?? null;
      let missing: ReadonlyArray<string> = [];
      if (project !== null && replica !== undefined && detail !== undefined) {
        const required = replica.checkpoint.requiredSecretPaths ?? [];
        if (required.length > 0) {
          missing = yield* repositoryRoot(project, detail.repositoryPath).pipe(
            Effect.flatMap((root) => Effect.promise(() => missingFiles(root, required))),
            Effect.orElseSucceed(() => required),
          );
        }
      }
      const provider = modelSelection === null ? null : yield* providerFor(modelSelection);
      const holder = replica?.lease;
      const failures: Array<HandoffPreflightFailure> = preflightFailures({
        machineLabel: label,
        project:
          project === null ? null : { title: project.title, inGrant: inGrant(caller, project) },
        checkpointSequence: replica?.checkpoint.sequence ?? null,
        requiredSequence: input.sequence,
        missingFiles: missing,
        modelSelection: modelSelection ?? {
          instanceId: "unknown" as ModelSelection["instanceId"],
          model: "unknown",
        },
        provider,
        otherHolder:
          holder !== undefined &&
          holder.holderEnvironmentId !== caller.sourceEnvironmentId &&
          holder.holderEnvironmentId !== handoff.environmentId
            ? holder.holderLabel
            : null,
      });
      if (replica?.continuedThreadId != null) {
        failures.push({ check: "lease", message: at("already continues this thread") });
      }
      return failures;
    });

  const preflight = (caller: ReceiverCaller, request: PeerPreflightRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
      const mismatch = versionFailure({
        peerLabel: "The source machine",
        peerProtocolVersion: request.protocolVersion,
        peerAppVersion: request.appVersion,
        selfLabel: label,
      });
      // A source from before the version check cannot decode check "version";
      // it still reads the message under a check it knows.
      const version =
        mismatch === null
          ? null
          : request.protocolVersion === undefined
            ? { ...mismatch, check: "checkpoint" as const }
            : mismatch;
      const results = yield* Effect.forEach(request.threads, (thread) =>
        threadFailures(caller, thread).pipe(
          Effect.map((failures) => ({
            sourceThreadId: thread.sourceThreadId,
            failures: version === null ? failures : [version, ...failures],
          })),
        ),
      );
      return {
        machineLabel: label,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: HANDOFF_APP_VERSION,
        results,
      } satisfies PeerPreflightResponse;
    });

  /** A worktree at the checkpoint's base commit holding its files as uncommitted changes. */
  const materialize = (input: {
    readonly root: string;
    readonly projectTitle: string;
    readonly sourceLabel: string;
    readonly sourceThreadId: ThreadId;
    readonly epoch: number;
    readonly branch: string | null;
    readonly baseCommit: string;
    readonly commit: string;
    readonly requiredFiles: ReadonlyArray<string>;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const name = `${refComponent(input.projectTitle).slice(0, 32)}-handoff-${refComponent(
          input.sourceThreadId,
        ).slice(-16)}-e${input.epoch}`;
        const worktreePath = NodePath.join(config.worktreesDir, name);
        const existing = await NodeFSP.stat(worktreePath).catch(() => null);
        if (existing !== null) {
          // A retried takeover finds the worktree its first attempt made.
          const branch = (
            await runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], {
              allowFailure: true,
            })
          ).stdout.trim();
          if (branch.length === 0) {
            throw new BundleError("failed", `${worktreePath} exists and is not a worktree.`);
          }
          return { worktreePath, branch };
        }
        const branch = await availableBranch({
          root: input.root,
          branch: input.branch,
          sourceLabel: input.sourceLabel,
          sourceThreadId: input.sourceThreadId,
        });
        await NodeFSP.mkdir(config.worktreesDir, { recursive: true, mode: 0o700 });
        await runGit(input.root, [
          "worktree",
          "add",
          "-q",
          "-b",
          branch,
          worktreePath,
          input.baseCommit,
        ]);
        try {
          await applyCheckpointToWorktree({
            worktreePath,
            baseCommit: input.baseCommit,
            checkpointCommit: input.commit,
          });
          await copyRequiredFiles({
            fromRoot: input.root,
            toRoot: worktreePath,
            paths: input.requiredFiles,
          });
        } catch (error) {
          await runGit(input.root, ["worktree", "remove", "--force", worktreePath], {
            allowFailure: true,
          });
          await runGit(input.root, ["branch", "-D", branch], { allowFailure: true });
          throw error;
        }
        return { worktreePath, branch };
      },
      catch: (cause) => fromBundleError(label, cause),
    });

  const takeoverLocked = (caller: ReceiverCaller, request: TakeoverRequest) =>
    Effect.gen(function* () {
      const verdict = takeoverVerdict(yield* document, request, label);
      if (verdict.kind === "repeat") return verdict.response;
      if (verdict.kind === "refuse") {
        return yield* refuse(409, verdict.code, verdict.message, verdict.check);
      }
      const { replica, detail } = verdict;
      const failures = yield* threadFailures(caller, {
        sourceThreadId: request.sourceThreadId,
        sourceProjectId: detail.sourceProjectId,
        sequence: request.sequence,
        modelSelection: request.modelSelection,
      });
      if (failures.length > 0) {
        const first = failures[0]!;
        return yield* refuse(
          409,
          first.check === "grant" ? "needs_grant" : "invalid",
          failures.map((failure) => failure.message).join("; "),
          first.check,
        );
      }
      const project = yield* requireProject(caller, detail.sourceProjectId);
      const root = yield* repositoryRoot(project, detail.repositoryPath);
      const checkpoint = replica.checkpoint;
      const held = yield* Effect.promise(() =>
        refCommit(root, incomingRef(caller.sourceEnvironmentId, request.sourceThreadId)),
      );
      if (held !== checkpoint.commit) {
        return yield* refuse(409, "invalid", at("no checkpoint for this thread"), "checkpoint");
      }
      const { worktreePath, branch } = yield* materialize({
        root,
        projectTitle: project.title,
        sourceLabel: replica.sourceLabel,
        sourceThreadId: request.sourceThreadId,
        epoch: request.epoch,
        branch: checkpoint.branch,
        baseCommit: checkpoint.baseCommit,
        commit: checkpoint.commit,
        requiredFiles: checkpoint.requiredSecretPaths ?? [],
      });
      const threadId = continuationThreadId(
        caller.sourceEnvironmentId,
        request.sourceThreadId,
        request.epoch,
      );
      const now = yield* nowIso;
      const modelSelection = request.modelSelection ?? detail.modelSelection;
      const resume = shouldResume(checkpoint.runEnding);
      // The lease and journal land before the thread exists, so its first run
      // starts under the takeover epoch and never repeats the source's side effects.
      yield* updateDocument((current) => {
        const record = current.threads[threadId] ?? emptyThreadRecord(project.id);
        const next = {
          ...record,
          projectId: project.id,
          mode: "on" as const,
          lease: {
            holderEnvironmentId: handoff.environmentId,
            holderLabel: label,
            holderThreadId: threadId,
            epoch: request.epoch,
            renewedAt: now,
            state: "active" as const,
          },
          sideEffects: [...checkpoint.sideEffects],
          resumeTurnKey: checkpoint.turnKey,
        };
        return [next, { ...current, threads: { ...current.threads, [threadId]: next } }] as const;
      });
      yield* launches
        .launch({
          commandId: CommandId.make(`handoff-takeover:${threadId}`),
          threadId,
          projectId: project.id,
          title: replica.title,
          modelSelection,
          runtimeMode: detail.runtimeMode,
          interactionMode: detail.interactionMode,
          workspaceStrategy: { type: "existing_worktree", worktreePath, branch },
          ...(resume
            ? {
                initialMessage: {
                  text: handoffSeed({
                    sourceLabel: replica.sourceLabel,
                    reason: request.reason,
                    checkpoint,
                    lastMessages: detail.transcript,
                  }),
                  attachments: [],
                },
              }
            : {}),
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError((error) => refuse(500, "failed", at(error.message))));
      const previous = detail.execution;
      const execution: ThreadExecutionRecord = {
        ownerMachineId: previous?.ownerMachineId ?? caller.sourceEnvironmentId,
        ...(previous?.ownerMachineLabel === undefined
          ? previous === null
            ? { ownerMachineLabel: replica.sourceLabel }
            : {}
          : { ownerMachineLabel: previous.ownerMachineLabel }),
        executionMachineId: handoff.environmentId,
        executionMachineLabel: label,
        epoch: request.epoch,
        sourceRoot: {
          environmentId: caller.sourceEnvironmentId,
          machineLabel: replica.sourceLabel,
          projectId: detail.sourceProjectId,
          threadId: request.sourceThreadId,
          workspaceRoot: checkpoint.sourceRoot?.workspaceRoot ?? root,
          branch: checkpoint.branch,
        },
        history: appendThreadExecutionHistory(
          previous?.history.length
            ? previous.history
            : [
                {
                  machine: caller.sourceEnvironmentId,
                  machineLabel: replica.sourceLabel,
                  from: replica.receivedAt,
                  to: null,
                  reason: "created",
                  epoch: checkpoint.epoch,
                },
              ],
          {
            machine: handoff.environmentId,
            machineLabel: label,
            from: now,
            to: null,
            reason: EXECUTION_REASON[request.reason],
            epoch: request.epoch,
          },
        ),
      };
      yield* orchestrator
        .dispatch({
          type: "thread.execution.record",
          commandId: CommandId.make(`handoff-execution:${threadId}`),
          threadId,
          execution,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not record the continuation's execution", { cause }),
          ),
        );
      const response: TakeoverResponse = {
        threadId,
        projectId: project.id,
        machineLabel: label,
        modelSelection,
        resumed: resume,
        notice:
          checkpoint.skipped.length > 0
            ? `Not carried over: ${checkpoint.skipped
                .slice(0, 5)
                .map((file) => file.path)
                .join(", ")}`.slice(0, 500)
            : null,
      };
      yield* updateDocument((current) => {
        const next = markContinued(current, request, response, now);
        return [next, next] as const;
      });
      return response;
    });

  const takeover = (caller: ReceiverCaller, request: TakeoverRequest) =>
    sameSource(caller, request.sourceEnvironmentId).pipe(
      Effect.andThen(
        locks.withLock(
          incomingKey(request.sourceEnvironmentId, request.sourceThreadId),
          takeoverLocked(caller, request),
        ),
      ),
    );

  const heartbeat = (caller: ReceiverCaller, request: HeartbeatRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
      const now = yield* nowIso;
      const continued = yield* updateDocument((current) => {
        const [fenced, next] = heartbeatContinued(current, request, now);
        return [fenced, next] as const;
      });
      return { machineLabel: label, continued } satisfies HeartbeatResponse;
    });

  return HandoffReceiver.of({ negotiate, replicate, preflight, takeover, heartbeat });
});

export const layer = Layer.effect(HandoffReceiver, make);
