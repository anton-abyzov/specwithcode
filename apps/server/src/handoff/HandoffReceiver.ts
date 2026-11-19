// @effect-diagnostics nodeBuiltinImport:off - the receiver writes bundles and worktrees with Git.
/**
 * The destination half of a handoff (0967). Another machine (or this one,
 * for a model change or "Continue here") replicates checkpoints here,
 * preflights threads, takes one over at a newer lease epoch, and heartbeats
 * the leases it holds. A takeover puts the work where the project's Use
 * worktrees switch says: a new worktree (the base commit plus the checkpoint
 * tree) when it is on, the project folder when it is off and can take it
 * safely. Then it starts the continuation thread: a fresh provider session
 * seeded from the checkpoint, never a migrated process.
 *
 * Every request names its source; a remote request arrives with the source's
 * work grant, and a project joins only through an explicit link (0948).
 */
import {
  teamRulesArrivingCarried,
  teamRulesClampToCarried,
  teamRulesClampMode,
} from "@specweave-studio/shared/teamRules";
import { teamRulesForFolder } from "../teamRules/TeamRules.ts";
import { FLEET_ORIGIN_APP_LABEL } from "../mcp/threadOrigin.ts";
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
  type OrchestrationV2ThreadShell,
  type Project,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
  type ThreadExecutionReason,
  type ThreadExecutionRecord,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import { projectUsesWorktrees } from "../mcp/toolkits/project/launchWorkspace.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { resolveHandoffPlacement } from "./handoffPlacement.ts";
import { arrivedReview, sentAsReview } from "./handoffReviewLock.ts";
import * as ServerConfig from "../config.ts";
import { clampRuntimeMode } from "../fleet/remoteWorkerMatching.ts";
import {
  accountInGrant,
  projectInGrant,
  type EffectiveWorkGrant,
} from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { runGit } from "../fleet/folderTransfer/git.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  applyBundle,
  applyCheckpointInPlace,
  applyCheckpointToWorktree,
  availableBranch,
  BundleError,
  copyRequiredFiles,
  type InPlaceRefusal,
  incomingRef,
  knownCommits,
  missingFiles,
  pinCommit,
  refCommit,
  resolveRepositoryPath,
} from "./bundleGit.ts";
import { refComponent } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffTransferStore from "./HandoffTransferStore.ts";
import { makeSetReceiver } from "./HandoffSetReceiver.ts";
import {
  acceptedMessage,
  claimRefusal,
  dropUnstarted,
  makeTransferStatus,
  recordedRefusal,
} from "./handoffTransferStatus.ts";
import {
  HANDOFF_CONTINUE_TEXT,
  handoffSeed,
  HANDOFF_SEED_MAX_CHARS,
  NOT_LINKED_HERE,
  preflightFailures,
  shouldResume,
} from "./handoffPreflight.ts";
import {
  makeAccountRefusal,
  makePeerCheck,
  type PeerCheck,
  toPreflightProvider,
} from "./handoffPlanReceiver.ts";
import {
  CONTINUATION_ID_PREFIX,
  type ContinuationEvidence,
  emptyThreadRecord,
  type HandoffDocument,
  findIncoming,
  type HandoffIncomingDetail,
  heartbeatContinued,
  incomingKey,
  ambiguousLinkMessage,
  isRetiredReason,
  linkedLocalProject,
  markContinued,
  noteContinuation,
  preparedContinuations,
  RETIRED_START_REFUSAL,
  takeoverVerdict,
  upsertIncoming,
} from "./handoffState.ts";
import type {
  HeartbeatOperation,
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
  TransferPullRequest,
  TransferStatusRequest,
  TransferStatusResponse,
} from "./handoffWire.ts";
import { batchArrival, REVISION_MISMATCH } from "./HandoffBatch.ts";
import {
  capabilityFailure,
  HANDOFF_APP_VERSION,
  HANDOFF_PROTOCOL_VERSION,
  versionFailure,
} from "./handoffWire.ts";

/** Hands a thread this machine runs to the machine that asked for it ("Continue here" there). */
export type TransferPullHandler = (
  caller: ReceiverCaller,
  request: TransferPullRequest,
) => Effect.Effect<TakeoverResponse, HandoffRefusal>;

/**
 * A refusal the source reports verbatim; nothing changed here. One `inDoubt` is
 * no refusal: this machine cannot tell whether something began here for the
 * request, so the source must keep holding what it holds.
 */
export class HandoffRefusal extends Data.TaggedError("HandoffRefusal")<{
  readonly status: number;
  readonly code: HandoffModeErrorCode;
  readonly message: string;
  readonly check?: HandoffPreflightCheck | undefined;
  /**
   * This machine may have acted before it failed (a takeover it had already
   * accepted). The caller keeps its hold and asks again; it is never a "no".
   */
  readonly uncertain?: boolean | undefined;
  /** No answer at all: the route sends none of the refusal fields (1390 AC-36). */
  readonly inDoubt?: boolean | undefined;
}> {}

/**
 * What the route answers for a refusal. One in doubt is a 503 carrying none of the
 * refusal fields (`error`, `code`, `check`): every release's source reads that as no
 * answer and keeps its hold, on a first send as on a re-send.
 */
export const refusalAnswer = (
  error: HandoffRefusal,
): { readonly status: number; readonly body: Record<string, unknown> } =>
  error.inDoubt === true
    ? { status: 503, body: { pending: error.message } }
    : {
        status: error.status,
        body: {
          error: error.message,
          code: error.code,
          ...(error.check === undefined ? {} : { check: error.check }),
          ...(error.uncertain === true ? { uncertain: true } : {}),
        },
      };

/** Who is asking. `grant` is null for a request this machine makes of itself. */
export interface ReceiverCaller {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly grant: EffectiveWorkGrant | null;
  /**
   * The most a continuation may run with here: the access the source's worker
   * credential signed in with. Absent or null for this machine asking itself.
   */
  readonly runtimeCeiling?: RuntimeMode | null;
}

const refuse = (
  status: number,
  code: HandoffModeErrorCode,
  message: string,
  check?: HandoffPreflightCheck,
) => new HandoffRefusal({ status, code, message, ...(check === undefined ? {} : { check }) });

/** No answer yet: whether something began here for the request cannot be read. */
const inDoubt = (message: string) =>
  new HandoffRefusal({ status: 503, code: "unreachable", message, inDoubt: true });
/** A failure after this machine may have acted: the source keeps its hold and asks again. */
const uncertainOf = (message: string) =>
  new HandoffRefusal({ status: 503, code: "failed", message, uncertain: true });

/**
 * The seed an idle continuation keeps for its first turn: the same note and
 * transcript, framed as context for the user's message rather than an order
 * to resume.
 */
export const idleSeed = (seed: string) =>
  `Context from the handoff (the user's message follows):${
    seed.startsWith(HANDOFF_CONTINUE_TEXT)
      ? seed.slice(HANDOFF_CONTINUE_TEXT.length)
      : `\n\n${seed}`
  }`;

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

const noticeOf = (parts: ReadonlyArray<string | null>) => {
  const notice = parts.filter((part): part is string => part !== null).join(" ");
  return notice.length === 0 ? null : notice.slice(0, 500);
};

/** Why a project with Use worktrees off still got a worktree for arriving work. */
const IN_PLACE_REFUSAL: Readonly<Record<InPlaceRefusal | "nested", string>> = {
  dirty: "has uncommitted changes",
  moved: "is at a different commit than the work started from",
  blocked: "has files in the way",
  midway: "is in the middle of a merge or rebase",
  nested: "is not the repository this work belongs to",
};

const EXECUTION_REASON: Readonly<Record<TakeoverReason, ThreadExecutionReason>> = {
  handoff: "handoff",
  "machine-handoff": "machine-handoff",
  sleep: "sleep",
  "continue-here": "continue-here",
  "auto-takeover": "auto-takeover",
};

/** How long a heartbeat waits on one takeover in progress before leaving it unanswered. */
const HEARTBEAT_SETTLE_WAIT = Duration.seconds(4);

/** ContinuationEvidence, with the epoch it continued at and what answers a repeat. */
type Evidence =
  | {
      readonly kind: "continued";
      readonly threadId: ThreadId;
      readonly epoch: number;
      readonly response: TakeoverResponse | null;
    }
  | { readonly kind: "none" }
  | { readonly kind: "unresolved" };

const publicEvidence = (found: Evidence): ContinuationEvidence =>
  found.kind === "continued" ? { kind: "continued", threadId: found.threadId } : found;

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
  return ThreadId.make(`${CONTINUATION_ID_PREFIX}${digest}`);
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
    readonly check: PeerCheck;
    readonly takeover: (
      caller: ReceiverCaller,
      request: TakeoverRequest,
    ) => Effect.Effect<TakeoverResponse, HandoffRefusal>;
    readonly heartbeat: (
      caller: ReceiverCaller,
      request: HeartbeatRequest,
    ) => Effect.Effect<HeartbeatResponse, HandoffRefusal>;
    /**
     * What became of a takeover the source has no answer for. "Not accepted"
     * is written before it is answered, so it is final for that lineage.
     */
    readonly transferStatus: (
      caller: ReceiverCaller,
      request: TransferStatusRequest,
    ) => Effect.Effect<TransferStatusResponse, HandoffRefusal>;
    /** Another machine asks for a thread this one runs; answered by the moves once attached. */
    readonly transferPull: TransferPullHandler;
    readonly attachPull: (handler: TransferPullHandler) => Effect.Effect<void>;
    /**
     * Whether a thread here continues the source's thread, read under the same lock
     * as its takeover. A continuation that launched but was never recorded is
     * recorded now, so later heartbeats fence the source. Never launches anything;
     * anything it cannot read is unresolved.
     */
    readonly continuation: (
      sourceEnvironmentId: EnvironmentId,
      sourceThreadId: string,
    ) => Effect.Effect<ContinuationEvidence>;
  }
>()("specweave-studio/handoff/HandoffReceiver") {}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const grants = yield* WorkGrants.WorkGrants;
  const sets = makeSetReceiver(config, handoff.document, (cause) => fromBundleError(label, cause));
  const locks = yield* KeyedLock.make<string>();
  const transfers = yield* HandoffTransferStore.fromContext;
  // Read where the server provides it; without it a thread's existence is unknown.
  const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  let pullHandler: TransferPullHandler | null = null;
  const label = handoff.machineLabel;
  const at = (message: string) => `${label}: ${message}`;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const sameSource = (caller: ReceiverCaller, sourceEnvironmentId: string) =>
    caller.sourceEnvironmentId === sourceEnvironmentId
      ? Effect.void
      : Effect.fail(
          refuse(403, "invalid", at("the request names another machine than the one asking")),
        );

  // A handoff file that does not read may hide a continuation, and one that does not
  // save may have dropped the record of one: neither is an answer.
  const document = handoff.document.pipe(Effect.mapError((error) => inDoubt(at(error.message))));
  const updateDocument = <A>(
    change: Parameters<typeof handoff.updateDocument<A>>[0],
  ): Effect.Effect<A, HandoffRefusal> =>
    handoff.updateDocument(change).pipe(Effect.mapError((error) => inDoubt(at(error.message))));

  const updateTransfers = <A>(
    change: Parameters<typeof transfers.update<A>>[0],
  ): Effect.Effect<A, HandoffRefusal> =>
    transfers
      .update(change)
      .pipe(Effect.mapError((error) => refuse(500, "failed", at(error.message))));

  /** The local project for the source project: the same one on this machine, else an explicit link. */
  const localProject = (sourceEnvironmentId: string, sourceProjectId: ProjectId) =>
    projects.snapshot.pipe(
      Effect.mapError(() => refuse(500, "failed", at("could not read its projects"))),
      Effect.flatMap((snapshot) => {
        if (sourceEnvironmentId === handoff.environmentId)
          return Effect.succeed(
            snapshot.projects.find((project) => project.id === sourceProjectId) ?? null,
          );
        const found = linkedLocalProject(
          snapshot.projects,
          handoff.environmentId,
          sourceEnvironmentId,
          sourceProjectId,
        );
        return found.kind === "ambiguous"
          ? Effect.fail(
              refuse(409, "invalid", at(ambiguousLinkMessage(found.projects)), "project-link"),
            )
          : Effect.succeed(found.kind === "linked" ? found.project : null);
      }),
    );

  const inGrant = (caller: ReceiverCaller, project: Project) =>
    caller.grant === null ||
    projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project);

  const accountRefusal = makeAccountRefusal(at);

  const requireProject = (caller: ReceiverCaller, sourceProjectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* localProject(caller.sourceEnvironmentId, sourceProjectId);
      if (project === null) {
        return yield* refuse(409, "invalid", at(NOT_LINKED_HERE), "project-link");
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

  const replicate = (caller: ReceiverCaller, sent: ReplicateMeta, bundle: Uint8Array | null) =>
    Effect.gen(function* () {
      yield* sameSource(caller, sent.sourceEnvironmentId);
      const linked = requireProject(caller, sent.sourceProjectId);
      const { meta, landed, project } = yield* sets.take(caller, linked, sent, bundle);
      if (meta === null) return { sequence: sent.checkpoint.sequence };
      const root = yield* repositoryRoot(project, meta.repositoryPath);
      const targetRef = incomingRef(meta.sourceEnvironmentId, meta.sourceThreadId);
      const commit = meta.checkpoint.commit;
      yield* Effect.tryPromise({
        try: async () => {
          if (landed) return;
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
    }).pipe(Effect.scoped);

  const providerFor = (modelSelection: ModelSelection) =>
    providers.getProviders.pipe(
      Effect.map(
        (list) =>
          list.find((provider) => provider.instanceId === modelSelection.instanceId) ?? null,
      ),
      Effect.map((provider) => (provider === null ? null : toPreflightProvider(provider))),
    );

  /** What an arriving thread continues on here: inside its reviewer lock when it has one. */
  const reviewOf = (
    caller: ReceiverCaller,
    replica: { readonly title: string; readonly sourceLabel: string } | undefined,
    detail: Pick<HandoffIncomingDetail, "reviewLock" | "modelSelection"> | undefined,
    requested: ModelSelection | null,
  ) =>
    Effect.gen(function* () {
      if (replica === undefined || detail === undefined) return { kind: "unlocked" } as const;
      return arrivedReview({
        carried: detail.reviewLock,
        title: replica.title,
        stored: detail.modelSelection,
        requested,
        providers: yield* providers.getProviders,
        allowed: (instanceId) =>
          caller.grant === null || accountInGrant(caller.grant.accounts, instanceId),
        machineLabel: label,
        sourceLabel: replica.sourceLabel,
        now: yield* nowIso,
      });
    });

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
      const review = yield* reviewOf(caller, replica, detail, input.modelSelection);
      // A check an older source reads; the message is the row it shows, so it stands alone.
      if (review.kind === "refused")
        return [{ check: "provider" as const, message: review.message }];
      const modelSelection =
        review.kind === "locked"
          ? review.modelSelection
          : (input.modelSelection ?? detail?.modelSelection ?? null);
      let missing: ReadonlyArray<string> = [];
      if (project !== null && replica !== undefined && detail !== undefined) {
        const required = replica.checkpoint.requiredSecretPaths ?? [];
        if (required.length > 0) {
          missing = yield* repositoryRoot(project, detail.repositoryPath).pipe(
            Effect.flatMap((root) => Effect.promise(() => missingFiles(root, required))),
            Effect.orElseSucceed(() => required),
          );
        }
        missing = [...missing, ...(yield* sets.missingSecrets(project.workspaceRoot, detail.set))];
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
      const account =
        modelSelection === null
          ? null
          : accountRefusal(
              caller,
              replica?.sourceLabel ?? "the source machine",
              modelSelection.instanceId,
            );
      if (account !== null) failures.push({ check: "grant", message: account });
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
      // A source that keeps no transfer records cannot be asked what it sent.
      const unfit =
        mismatch ??
        (caller.grant === null
          ? null
          : capabilityFailure({
              peerLabel: "The source machine",
              capabilities: request.capabilities,
            }));
      const capabilities = yield* sets.offer(request, unfit === null);
      const version =
        unfit === null
          ? null
          : request.protocolVersion === undefined
            ? { ...unfit, check: "checkpoint" as const }
            : unfit;
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
        capabilities,
        results,
      } satisfies PeerPreflightResponse;
    });

  const check = makePeerCheck({
    label,
    at,
    environmentId: handoff.environmentId,
    sameSource,
    document,
    localProject,
    inGrant,
    accountRefusal,
    getProviders: providers.getProviders,
    getSettings: serverSettings.getSettings,
    refuse,
  });

  /** A worktree at the checkpoint's base commit holding its files as uncommitted changes. */
  const materialize = (input: {
    readonly root: string;
    readonly placement: { readonly worktreePath: string; readonly existing: boolean };
    readonly sourceLabel: string;
    readonly sourceThreadId: ThreadId;
    readonly branch: string | null;
    readonly baseCommit: string;
    readonly commit: string;
    readonly requiredFiles: ReadonlyArray<string>;
  }) =>
    Effect.tryPromise({
      try: async () => {
        const { worktreePath, existing } = input.placement;
        if (existing) {
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
        await NodeFSP.mkdir(NodePath.dirname(worktreePath), { recursive: true, mode: 0o700 });
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

  /**
   * What continues one source thread here. The caller holds its takeover lock, so no
   * launch of it is in progress: a continuation id launches only inside a takeover
   * under that lock, after its lease is saved, and its thread is created by one
   * accepted command. Continued: the replica says so, a receipt records the launch,
   * or a saved lease has its thread (recorded now, receipt and all). None only with
   * proof: the replica is here and no lease of any epoch was ever saved for it (no
   * thread record is ever removed). A saved lease without its thread is unresolved,
   * since a thread read never sees a deleted thread, and so is a source thread with
   * neither replica nor receipt here: evicted cannot be told from never sent.
   */
  const evidenceLocked = (
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: ThreadId,
    /** Epochs the caller knows a takeover was asked at. */
    epochs: ReadonlyArray<number> = [],
  ): Effect.Effect<Evidence> =>
    Effect.gen(function* () {
      const current = yield* handoff.document;
      const key = incomingKey(sourceEnvironmentId, sourceThreadId);
      const replica = findIncoming(current, sourceEnvironmentId, sourceThreadId);
      const detail = (current.incomingDetails ?? {})[key];
      if (replica?.continuedThreadId != null) {
        return {
          kind: "continued",
          threadId: replica.continuedThreadId,
          epoch: detail?.takeoverEpoch ?? replica.lease.epoch,
          response: detail?.takeover ?? null,
        } satisfies Evidence;
      }
      const receipt = (current.continuationReceipts ?? {})[key];
      const responseOf = (shell: OrchestrationV2ThreadShell): TakeoverResponse => ({
        threadId: shell.id,
        projectId: shell.projectId,
        machineLabel: label,
        modelSelection: shell.modelSelection,
        resumed: replica === undefined ? false : shouldResume(replica.checkpoint.runEnding),
        notice: null,
      });
      /** Records a continuation its thread proves, so later heartbeats fence the source. */
      const record = (shell: OrchestrationV2ThreadShell, epoch: number) =>
        Effect.gen(function* () {
          const response = responseOf(shell);
          const now = yield* nowIso;
          const started: TakeoverRequest = {
            sourceEnvironmentId,
            sourceThreadId,
            epoch,
            sequence: replica?.checkpoint.sequence ?? 0,
            reason: "handoff",
            modelSelection: null,
          };
          yield* handoff.updateDocument(
            (latest) => [undefined, markContinued(latest, started, response, now)] as const,
          );
          yield* Effect.logWarning("Handoff recorded a continuation that launched unrecorded", {
            sourceThreadId,
            threadId: shell.id,
            epoch,
          });
          return { kind: "continued", threadId: shell.id, epoch, response } satisfies Evidence;
        });
      if (receipt?.launched === true) {
        const threadId = ThreadId.make(receipt.threadId);
        // The thread may be gone (deleted here) or unreadable; the receipt still proves it.
        const shell = yield* orchestrator
          .getThreadShell(threadId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (shell !== null && replica !== undefined) return yield* record(shell, receipt.epoch);
        return {
          kind: "continued",
          threadId,
          epoch: receipt.epoch,
          response: shell === null ? null : responseOf(shell),
        } satisfies Evidence;
      }
      const prepared = preparedContinuations(
        current,
        (epoch) => continuationThreadId(sourceEnvironmentId, sourceThreadId, epoch),
        receipt === undefined ? epochs : [...epochs, receipt.epoch],
      );
      for (const { threadId, epoch } of prepared.found) {
        const shell = yield* orchestrator.getThreadShell(ThreadId.make(threadId));
        if (shell !== null) return yield* record(shell, epoch);
      }
      const absent =
        prepared.complete &&
        prepared.found.length === 0 &&
        replica !== undefined &&
        receipt === undefined;
      return absent
        ? ({ kind: "none" } satisfies Evidence)
        : ({ kind: "unresolved" } satisfies Evidence);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff could not read whether a thread continues here", {
          sourceThreadId,
          cause,
        }).pipe(Effect.as({ kind: "unresolved" } satisfies Evidence)),
      ),
    );

  const evidence = (
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: string,
    epochs: ReadonlyArray<number> = [],
  ) =>
    locks.withLock(
      incomingKey(sourceEnvironmentId, sourceThreadId),
      evidenceLocked(sourceEnvironmentId, ThreadId.make(sourceThreadId), epochs),
    );

  /**
   * A takeover sleep or silence started, from a machine on an earlier release: nothing
   * launches for it. A start this machine made at that epoch answers with its thread.
   * Only with proof that nothing began here for the thread is it refused. Anything
   * else (a continuation at another epoch, a saved lease without its thread, an
   * outcome that cannot be read) is no answer: an earlier release keeps its hold on
   * that alone, on a first send as on a re-send, and its next heartbeat after this
   * machine records the continuation, or a person's Resume here, settles it.
   */
  const retiredTakeover = (caller: ReceiverCaller, request: TakeoverRequest) =>
    Effect.gen(function* () {
      const found = yield* evidenceLocked(caller.sourceEnvironmentId, request.sourceThreadId, [
        request.epoch,
      ]);
      if (found.kind === "continued" && found.epoch === request.epoch && found.response !== null) {
        return found.response;
      }
      if (found.kind === "none") {
        return yield* refuse(409, "invalid", at(RETIRED_START_REFUSAL), "lease");
      }
      return yield* inDoubt(
        at(
          found.kind === "continued"
            ? `already continued this thread at epoch ${found.epoch}; the thread stays paused there until this machine's answer reaches it`
            : "an earlier start of this thread here cannot be settled; nothing starts for it now, and the thread stays paused there until it is",
        ),
      );
    });

  const takeoverLocked = (caller: ReceiverCaller, request: TakeoverRequest) => {
    /**
     * Set once this machine's acceptance stands and a thread may exist for it.
     * A failure from then on is answered as in doubt, and the acceptance is
     * kept: the source's repeat of the operation finishes what was started.
     */
    let standing = false;
    return Effect.gen(function* () {
      if (isRetiredReason(request.reason)) return yield* retiredTakeover(caller, request);
      const lineage = {
        sourceEnvironmentId: caller.sourceEnvironmentId,
        sourceThreadId: request.sourceThreadId,
        epoch: request.epoch,
      };
      const operationId = request.operationId ?? null;
      const recorded = (yield* transfers.read.pipe(
        Effect.mapError((error) => refuse(500, "failed", at(error.message))),
      )).acceptances[HandoffTransferStore.acceptanceKey(lineage)];
      if (recorded !== undefined) {
        // The first verdict for a lineage is final, whatever arrives after it.
        const settled = recordedRefusal(recorded, operationId, request);
        if (settled !== null) return yield* refuse(409, settled.code, at(settled.message), "lease");
        if (recorded.launched && recorded.receipt !== null) return recorded.receipt;
        // Accepted, and the launch was cut: nothing below may turn that into a "no".
        standing = true;
      }
      // An accepted takeover is finished as it was first asked: a repeat that
      // lost the batch's fields never turns "Ready" into a resumed run.
      const batch = recorded === undefined ? request.batch : recorded.batch;
      const verdict = takeoverVerdict(yield* document, request, label);
      if (verdict.kind === "repeat") return verdict.response;
      if (verdict.kind === "refuse") {
        return yield* refuse(409, verdict.code, verdict.message, verdict.check);
      }
      if (caller.grant !== null && operationId === null) {
        // No transfer record on the source: it could not ask what became of this.
        const unfit = capabilityFailure({ peerLabel: "The source machine", capabilities: [] });
        return yield* refuse(409, "invalid", at(unfit?.message ?? "Needs update"), "version");
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
          first.check === "grant" ? 403 : 409,
          first.check === "grant" ? "needs_grant" : "invalid",
          failures.map((failure) => failure.message).join("; "),
          first.check,
        );
      }
      const project = yield* requireProject(caller, detail.sourceProjectId);
      const root = yield* repositoryRoot(project, detail.repositoryPath);
      const checkpoint = replica.checkpoint;
      if (checkpoint.children?.some((child) => child.disposition === "unknown")) {
        return yield* refuse(
          409,
          "invalid",
          at(
            "A child still has unknown execution ownership. Reconcile it on its owning host before takeover.",
          ),
          "checkpoint",
        );
      }
      const seed = handoffSeed({
        sourceLabel: replica.sourceLabel,
        reason: request.reason,
        checkpoint,
        lastMessages: detail.transcript,
      });
      if (seed.length > HANDOFF_SEED_MAX_CHARS) {
        return yield* refuse(
          409,
          "invalid",
          at(
            "The child context and irreversible-effect receipts exceed the handoff envelope. Keep the source paused and reduce optional context before retrying.",
          ),
          "checkpoint",
        );
      }
      const held = yield* Effect.promise(() =>
        refCommit(root, incomingRef(caller.sourceEnvironmentId, request.sourceThreadId)),
      );
      if (held !== checkpoint.commit) {
        return yield* refuse(409, "invalid", at("no checkpoint for this thread"), "checkpoint");
      }
      // A batch names what happens on arrival and the revision it hands over.
      // Compared here, before a file or a worktree is placed for it.
      const arrival = batchArrival({
        batch,
        sequence: request.sequence,
        checkpoint,
        resumable: shouldResume(checkpoint.runEnding),
      });
      if (arrival.kind === "refuse") {
        return yield* refuse(409, "invalid", at(REVISION_MISMATCH), "checkpoint");
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() =>
          refuse(500, "failed", at("could not read destination worktree settings")),
        ),
      );
      // Asked again before the workspace changes, so a reviewer gone since the checks leaves nothing here.
      const still = sentAsReview(
        request,
        yield* reviewOf(caller, replica, detail, request.modelSelection),
      );
      if (still.kind === "refused") return yield* refuse(409, "invalid", still.message, "provider");
      const name = `${refComponent(project.title).slice(0, 32)}-handoff-${refComponent(
        request.sourceThreadId,
      ).slice(-16)}-e${request.epoch}`;
      const placed = resolveHandoffPlacement({
        repository: root,
        name: sets.folderName(name, request, detail.set),
        defaultDirectory: config.worktreesDir,
        settings: resolveProjectSettings(settings, project.id).settings,
      }).pipe(
        Effect.mapError((cause) => refuse(409, "invalid", at(describe(cause)), "checkpoint")),
      );
      // With Use worktrees off the work belongs in the project folder, as every
      // other thread's does. A folder that cannot take it safely keeps the
      // worktree, and the answer says why.
      const usesWorktrees = projectUsesWorktrees(
        resolveProjectSettings(settings, project.id, project),
      );
      const placement = yield* Effect.exit(placed);
      // A worktree already made for this takeover wins: a retry never moves the work.
      const retriedInWorktree = Exit.isSuccess(placement) && placement.value.existing;
      // A thread started in the project folder runs git in the repository that
      // holds the folder. Work for a repository nested below it would sit where
      // the thread's own checkpoints never look, so that keeps its worktree.
      const nested = detail.repositoryPath
        .split("/")
        .some((segment) => segment.length > 0 && segment !== "." && segment !== "..");
      const inPlace =
        detail.set !== undefined || usesWorktrees || retriedInWorktree
          ? null
          : nested
            ? ({ applied: false, reason: "nested" } as const)
            : yield* Effect.tryPromise({
                try: () =>
                  applyCheckpointInPlace({
                    root,
                    baseCommit: checkpoint.baseCommit,
                    checkpointCommit: checkpoint.commit,
                  }),
                catch: (cause) => fromBundleError(label, cause),
              });
      const setWorkspace = yield* sets.folder(project, name, request, detail, placement, replica);
      const workspace =
        setWorkspace !== null || inPlace?.applied === true
          ? setWorkspace
          : yield* materialize({
              root,
              placement: yield* placement,
              sourceLabel: replica.sourceLabel,
              sourceThreadId: request.sourceThreadId,
              branch: checkpoint.branch,
              baseCommit: checkpoint.baseCommit,
              commit: checkpoint.commit,
              requiredFiles: checkpoint.requiredSecretPaths ?? [],
            });
      const workspaceNotice =
        inPlace === null
          ? null
          : inPlace.applied
            ? `Use worktrees is off for this project, so the work is in the project folder as uncommitted changes${
                checkpoint.branch === null || inPlace.branch === checkpoint.branch
                  ? "."
                  : `, on ${inPlace.branch ?? "no branch"} (it was on ${checkpoint.branch}).`
              }`
            : `Use worktrees is off for this project, but the project folder ${
                IN_PLACE_REFUSAL[inPlace.reason]
              }, so the work is in its own worktree at ${workspace?.worktreePath}.`;
      const threadId = continuationThreadId(
        caller.sourceEnvironmentId,
        request.sourceThreadId,
        request.epoch,
      );
      const now = yield* nowIso;
      // And once more now that the workspace is ready: this is the answer the launch runs on.
      const review = sentAsReview(
        request,
        yield* reviewOf(caller, replica, detail, request.modelSelection),
      );
      if (review.kind === "refused")
        return yield* refuse(409, "invalid", review.message, "provider");
      const modelSelection =
        review.kind === "locked"
          ? review.modelSelection
          : (request.modelSelection ?? detail.modelSelection);
      const resume = arrival.resume;
      const ceiling = caller.runtimeCeiling ?? null;
      const clamped =
        ceiling === null
          ? null
          : clampRuntimeMode({ started: detail.runtimeMode, requested: undefined, ceiling });
      const grantedMode = clamped?.ok === true ? clamped.mode : detail.runtimeMode;
      // The thread must exist here to be repaired, so this machine's ceiling
      // lowers it on arrival and records that it did.
      const carried = teamRulesArrivingCarried(detail.carried, handoff.environmentId);
      const runtimeMode = teamRulesClampToCarried(
        teamRulesClampMode(
          yield* teamRulesForFolder(workspace?.worktreePath ?? project.workspaceRoot),
          grantedMode,
        ),
        carried,
      );
      const loweredFrom =
        runtimeMode !== detail.runtimeMode
          ? detail.runtimeMode
          : clamped?.ok === true
            ? clamped.loweredFrom
            : undefined;
      if (caller.grant !== null) {
        // The route checked the grant before the move began; a revoke since then wins.
        const current = yield* grants
          .forCoordinator(caller.sourceEnvironmentId)
          .pipe(Effect.mapError(() => refuse(500, "failed", at("could not read its work grants"))));
        if (current.revoked) {
          return yield* refuse(
            403,
            "needs_grant",
            at(`this machine revoked ${replica.sourceLabel}'s work here`),
            "grant",
          );
        }
        // The continuation is the source's work: the revoke sweeper and its own
        // later calls see it under the source's grant, as delegated work is.
        yield* grants
          .recordOrigin(threadId, {
            coordinatorEnvironmentId: caller.sourceEnvironmentId,
            path: [caller.sourceEnvironmentId],
            hops: 1,
          })
          .pipe(
            Effect.mapError(() => refuse(500, "failed", at("could not record the work's origin"))),
          );
      } else {
        // A self continue is this machine's own work, even where an earlier failed
        // move of the same epoch recorded the source as its origin.
        yield* grants.forgetOrigin(threadId).pipe(Effect.ignore);
      }
      const offered: TakeoverResponse = {
        threadId,
        projectId: project.id,
        machineLabel: label,
        modelSelection,
        resumed: resume,
        notice: noticeOf([
          loweredFrom === undefined
            ? null
            : `Runs at ${runtimeMode} here (lowered from ${loweredFrom}) under this machine's limits for ${replica.sourceLabel}.`,
          workspaceNotice,
          review.kind === "locked" ? review.notice : null,
          checkpoint.skipped.length > 0
            ? `Not carried over: ${checkpoint.skipped
                .slice(0, 5)
                .map((file) => file.path)
                .join(", ")}`
            : null,
        ]),
      };
      // The acceptance is on disk before anything is launched. Of two requests
      // for one lineage exactly one claims it; a repeat of the same operation
      // gets the first receipt, and a different one is refused.
      const claim = yield* updateTransfers((current) =>
        HandoffTransferStore.claimAcceptance(current, {
          lineage,
          operationId,
          sequence: request.sequence,
          receipt: offered,
          trigger: request.trigger ?? null,
          reason: request.reason,
          modelSelection: request.modelSelection,
          ...(batch === undefined ? {} : { batch }),
          now,
        }),
      ).pipe(
        Effect.tapError(() =>
          caller.grant === null ? Effect.void : grants.forgetOrigin(threadId).pipe(Effect.ignore),
        ),
      );
      const lost = claimRefusal(claim);
      if (lost !== null) return yield* refuse(409, lost.code, at(lost.message), "lease");
      const response = claim.acceptance.receipt ?? offered;
      const receiptKey = incomingKey(caller.sourceEnvironmentId, request.sourceThreadId);
      const receipt = (launched: boolean) => ({
        threadId,
        epoch: request.epoch,
        launched,
        at: now,
      });
      yield* Effect.gen(function* () {
        // The lease and journal land before the thread exists, so its first run
        // starts under the takeover epoch and never repeats the source's side effects.
        // The receipt beside them names this start once the replica is gone.
        const hadRecord = (yield* document).threads[threadId] !== undefined;
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
            // An idle continuation starts no run; its first turn carries the note and transcript.
            pendingSeed: resume ? null : idleSeed(seed),
            // Who waits for the result, so a later move from here stays in its reach.
            ...(request.launcher === undefined ? {} : { launcher: request.launcher }),
          };
          const saved = { ...current, threads: { ...current.threads, [threadId]: next } };
          return [next, noteContinuation(saved, receiptKey, receipt(false))] as const;
        });
        // From here a thread may exist, whatever the launch answers.
        const cutBefore = standing;
        standing = true;
        yield* launches
          .launch({
            commandId: CommandId.make(`handoff-takeover:${threadId}`),
            threadId,
            projectId: project.id,
            title: replica.title,
            modelSelection,
            runtimeMode,
            interactionMode: detail.interactionMode,
            workspaceStrategy:
              workspace === null
                ? { type: "root" }
                : {
                    type: "existing_worktree",
                    worktreePath: workspace.worktreePath,
                    branch: workspace.branch,
                  },
            ...(resume ? { initialMessage: { text: seed, attachments: [] } } : {}),
            createdBy: "system",
            creationSource: "server",
            ...(review.kind === "locked" ? { routing: review.routing } : {}),
            ...(carried === undefined
              ? {}
              : {
                  origin: {
                    kind: "fleet_machine" as const,
                    label: FLEET_ORIGIN_APP_LABEL,
                    machineLabel: replica.sourceLabel,
                    environmentId: caller.sourceEnvironmentId,
                    carried,
                  },
                }),
          })
          .pipe(
            Effect.catch((error) => {
              // Refused before the thread was asked for (a paused or missing project, an
              // unknown repository): the launch service raises these, with no thread
              // id, before it creates anything. Nothing exists here, so this is a "no"
              // and the acceptance goes. Not after an earlier launch that was cut.
              const before =
                !cutBefore &&
                error.threadId === undefined &&
                (error.operation === "resolve-project" || error.operation === "resolve-repository");
              if (!before) return Effect.fail(refuse(500, "failed", at(error.message)));
              standing = false;
              // The lease and receipt written above are for a thread that was never created.
              return updateDocument(
                (current) =>
                  [
                    undefined,
                    hadRecord ? current : dropUnstarted(current, threadId, receiptKey),
                  ] as const,
              ).pipe(
                Effect.ignore,
                Effect.andThen(Effect.fail(refuse(409, "failed", at(error.message)))),
              );
            }),
          );
      }).pipe(
        // A failed move leaves no origin behind: the same id may later be continued
        // here by this machine's own user.
        Effect.onError(() =>
          caller.grant === null ? Effect.void : grants.forgetOrigin(threadId).pipe(Effect.ignore),
        ),
        // A failure before anything was launched is answered as a refusal, so
        // the acceptance must not stand: a repeat would start a thread the
        // source kept. Once the launch was asked for, the acceptance stays and
        // the answer is in doubt; so does it when this server stops here.
        Effect.tapError((error) =>
          standing
            ? Effect.void
            : transfers
                .update((current) => [
                  undefined,
                  HandoffTransferStore.revokeAcceptance(current, lineage, error.message),
                ])
                .pipe(
                  // The acceptance is still on file, so a repeat would launch: this is no "no".
                  Effect.catch(() =>
                    Effect.sync(() => {
                      standing = true;
                    }),
                  ),
                ),
        ),
      );
      // The thread exists: from here on its receipt names it, whatever is cut next.
      yield* updateDocument(
        (current) => [undefined, noteContinuation(current, receiptKey, receipt(true))] as const,
      );
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
      yield* updateDocument((current) => {
        const next = markContinued(current, request, response, now);
        return [next, next] as const;
      });
      yield* updateTransfers((current) => [
        undefined,
        HandoffTransferStore.markLaunched(current, lineage),
      ]);
      return response;
    }).pipe(
      Effect.mapError((error) =>
        // One already in doubt keeps its shape: it is no answer for any release's source.
        standing && error.uncertain !== true && error.inDoubt !== true
          ? uncertainOf(acceptedMessage(error.message, label))
          : error,
      ),
    );
  };

  const takeover = (caller: ReceiverCaller, request: TakeoverRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
    }).pipe(
      // Not read, so a sleep or silence start is not proven new: no answer (1390 AC-36).
      Effect.mapError((refused) =>
        isRetiredReason(request.reason) ? inDoubt(refused.message) : refused,
      ),
      Effect.andThen(
        locks.withLock(
          incomingKey(request.sourceEnvironmentId, request.sourceThreadId),
          takeoverLocked(caller, request),
        ),
      ),
    );

  /** A takeover of the source thread saved a lease or receipt here that is not recorded yet. */
  const startedUnrecorded = (
    current: HandoffDocument,
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: string,
  ) => {
    const replica = findIncoming(current, sourceEnvironmentId, sourceThreadId);
    if (replica?.continuedThreadId != null) return false;
    const receipt = (current.continuationReceipts ?? {})[
      incomingKey(sourceEnvironmentId, sourceThreadId)
    ];
    if (receipt !== undefined) return !receipt.launched;
    return (
      preparedContinuations(current, (epoch) =>
        continuationThreadId(sourceEnvironmentId, sourceThreadId, epoch),
      ).found.length > 0
    );
  };

  /** Evidence under the takeover's lock; one held longer than the wait reads unresolved. */
  const evidenceWithin = (
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: string,
    epochs: ReadonlyArray<number> = [],
  ) =>
    evidence(sourceEnvironmentId, sourceThreadId, epochs).pipe(
      Effect.timeoutOption(HEARTBEAT_SETTLE_WAIT),
      Effect.map((found) => Option.getOrElse(found, (): Evidence => ({ kind: "unresolved" }))),
    );

  const heartbeat = (caller: ReceiverCaller, request: HeartbeatRequest) =>
    Effect.gen(function* () {
      yield* sameSource(caller, request.sourceEnvironmentId);
      // A file that does not read answers nothing, not an empty answer: a source on any
      // release takes a heartbeat's answer as word from this machine, and none as silence.
      const current = yield* document;
      // Each operation the source asks about is read under its takeover's lock: one in
      // progress has finished, or never began, before it is answered. A takeover that
      // holds its lock longer than the wait leaves its operation unanswered, so the
      // source keeps that hold and still hears about every other thread.
      const source = request.sourceEnvironmentId;
      const settled = yield* Effect.forEach(
        request.settle ?? [],
        (operation) =>
          evidenceWithin(source, operation.sourceThreadId, [operation.epoch]).pipe(
            Effect.map((found) => ({ operation, found })),
          ),
        { concurrency: "unbounded" },
      );
      // A held thread with a start here that is not recorded yet (a source on an earlier
      // release never asks about it) is read the same way, so a continuation its thread
      // proves is recorded and answered before the source can take the answer as none.
      const asked = new Set((request.settle ?? []).map((operation) => operation.sourceThreadId));
      yield* Effect.forEach(
        request.leases.filter(
          (lease) =>
            !asked.has(lease.sourceThreadId) &&
            startedUnrecorded(current, source, lease.sourceThreadId),
        ),
        (lease) => evidenceWithin(source, lease.sourceThreadId),
        { concurrency: "unbounded", discard: true },
      );
      const now = yield* nowIso;
      const recorded = yield* updateDocument((latest) => {
        const [fenced, next] = heartbeatContinued(latest, request, now);
        return [fenced, next] as const;
      });
      // A continuation its thread proves fences the source even where no replica records it.
      const continued = [...recorded];
      for (const { operation, found } of settled) {
        if (found.kind !== "continued") continue;
        if (continued.some((entry) => entry.sourceThreadId === operation.sourceThreadId)) continue;
        continued.push({
          sourceThreadId: operation.sourceThreadId,
          epoch: found.epoch,
          threadId: found.threadId,
        });
      }
      const notStarted: Array<HeartbeatOperation> = settled
        .filter(({ found }) => found.kind === "none")
        .map(({ operation }) => operation);
      return {
        machineLabel: label,
        continued,
        ...(request.settle === undefined ? {} : { notStarted }),
      } satisfies HeartbeatResponse;
    });

  const transferStatusLocked = makeTransferStatus({
    label,
    at,
    nowIso,
    document,
    updateDocument,
    updateTransfers,
    continuationId: continuationThreadId,
    projections,
    takeover: (caller, request) => takeoverLocked(caller, request),
    uncertain: uncertainOf,
  });

  const transferStatus = (caller: ReceiverCaller, request: TransferStatusRequest) =>
    sameSource(caller, request.sourceEnvironmentId).pipe(
      Effect.andThen(
        locks.withLock(
          incomingKey(request.sourceEnvironmentId, request.sourceThreadId),
          transferStatusLocked(caller, request),
        ),
      ),
    );

  const transferPull: TransferPullHandler = (caller, request) =>
    sameSource(caller, request.sourceEnvironmentId).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          pullHandler === null
            ? Effect.fail(refuse(503, "busy", at("handoff is still starting; try again")))
            : pullHandler(caller, request),
        ),
      ),
    );

  const continuation = (sourceEnvironmentId: EnvironmentId, sourceThreadId: string) =>
    evidence(sourceEnvironmentId, sourceThreadId).pipe(Effect.map(publicEvidence));

  return HandoffReceiver.of({
    negotiate,
    replicate,
    preflight,
    check,
    takeover,
    heartbeat,
    transferStatus,
    transferPull,
    attachPull: (handler) => Effect.sync(() => void (pullHandler = handler)),
    continuation,
  });
});

export const layer = Layer.effect(HandoffReceiver, make);
