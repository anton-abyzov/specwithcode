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
  type Project,
  type ProjectId,
  type RuntimeMode,
  type ServerProvider,
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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

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
import {
  HANDOFF_CONTINUE_TEXT,
  handoffSeed,
  HANDOFF_SEED_MAX_CHARS,
  type PreflightProvider,
  NOT_LINKED_HERE,
  preflightFailures,
  shouldResume,
} from "./handoffPreflight.ts";
import {
  emptyThreadRecord,
  findIncoming,
  type HandoffIncomingDetail,
  heartbeatContinued,
  incomingKey,
  ambiguousLinkMessage,
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
  TransferPullRequest,
  TransferStatusRequest,
  TransferStatusResponse,
} from "./handoffWire.ts";
import {
  capabilityFailure,
  HANDOFF_APP_VERSION,
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  versionFailure,
} from "./handoffWire.ts";

/** Hands a thread this machine runs to the machine that asked for it ("Continue here" there). */
export type TransferPullHandler = (
  caller: ReceiverCaller,
  request: TransferPullRequest,
) => Effect.Effect<TakeoverResponse, HandoffRefusal>;

/** A refusal the source reports verbatim; nothing changed here. */
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
}> {}

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
  const locks = yield* KeyedLock.make<string>();
  const transfers = yield* HandoffTransferStore.fromContext;
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

  const document = handoff.document.pipe(
    Effect.mapError((error) => refuse(500, "failed", at(error.message))),
  );
  const updateDocument = <A>(
    change: Parameters<typeof handoff.updateDocument<A>>[0],
  ): Effect.Effect<A, HandoffRefusal> =>
    handoff
      .updateDocument(change)
      .pipe(Effect.mapError((error) => refuse(500, "failed", at(error.message))));

  const updateTransfers = <A>(
    change: Parameters<typeof transfers.update<A>>[0],
  ): Effect.Effect<A, HandoffRefusal> =>
    transfers.update(change).pipe(Effect.mapError((error) => refuse(500, "failed", at(error.message))));

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

  /** Why the grant does not let the source run on this sign-in, or null when it does. */
  const accountRefusal = (
    caller: ReceiverCaller,
    sourceLabel: string,
    instanceId: ModelSelection["instanceId"],
  ) => {
    if (caller.grant === null || accountInGrant(caller.grant.accounts, instanceId)) return null;
    const allowed =
      caller.grant.accounts.kind === "listed" ? caller.grant.accounts.instanceIds : [];
    return at(
      allowed.length === 0
        ? `this machine lets ${sourceLabel} use none of its sign-ins, so it cannot continue work here. The user can allow sign-ins in Settings > Machines > Who can run work here.`
        : `this machine lets ${sourceLabel} use only these sign-ins: ${allowed.join(", ")}. The user can allow ${instanceId} in Settings > Machines > Who can run work here.`,
    );
  };

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
        capabilities: HANDOFF_CAPABILITIES,
        results,
      } satisfies PeerPreflightResponse;
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

  const takeoverLocked = (caller: ReceiverCaller, request: TakeoverRequest) => {
    /**
     * Set once this machine's acceptance stands and a thread may exist for it.
     * A failure from then on is answered as in doubt, and the acceptance is
     * kept: the source's repeat of the operation finishes what was started.
     */
    let standing = false;
    return Effect.gen(function* () {
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
        if (recorded.verdict === "not-accepted") {
          return yield* refuse(
            409,
            "invalid",
            at("this handoff was already answered as not accepted; start it again"),
            "lease",
          );
        }
        if (recorded.operationId !== operationId || recorded.sequence !== request.sequence) {
          return yield* refuse(
            409,
            "fenced",
            at(`another handoff already took this thread at epoch ${request.epoch}`),
            "lease",
          );
        }
        if (recorded.launched && recorded.receipt !== null) return recorded.receipt;
        // Accepted, and the launch was cut: nothing below may turn that into a "no".
        standing = true;
      }
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
        name,
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
        usesWorktrees || retriedInWorktree
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
      const workspace =
        inPlace?.applied === true
          ? null
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
      const resume = shouldResume(checkpoint.runEnding);
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
          now,
        }),
      ).pipe(
        Effect.tapError(() =>
          caller.grant === null ? Effect.void : grants.forgetOrigin(threadId).pipe(Effect.ignore),
        ),
      );
      if (claim.kind === "not-accepted") {
        return yield* refuse(
          409,
          "invalid",
          at("this handoff was already answered as not accepted; start it again"),
          "lease",
        );
      }
      if (claim.kind === "divergent" || claim.kind === "stale") {
        return yield* refuse(
          409,
          "fenced",
          at(`another handoff already took this thread at epoch ${claim.acceptance.lineage.epoch}`),
          "lease",
        );
      }
      const response = claim.acceptance.receipt ?? offered;
      yield* Effect.gen(function* () {
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
            // An idle continuation starts no run; its first turn carries the note and transcript.
            pendingSeed: resume ? null : idleSeed(seed),
            // Who waits for the result, so a later move from here stays in its reach.
            ...(request.launcher === undefined ? {} : { launcher: request.launcher }),
          };
          return [next, { ...current, threads: { ...current.threads, [threadId]: next } }] as const;
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
            Effect.mapError((error) => {
              // Refused before the thread was asked for (a paused or missing project, an
              // unknown repository): nothing exists here, so this is a "no" and the
              // acceptance goes. Not after an earlier launch that was cut.
              const before =
                error.threadId === undefined &&
                (error.operation === "resolve-project" || error.operation === "resolve-repository");
              if (before && !cutBefore) standing = false;
              return refuse(before && !cutBefore ? 409 : 500, "failed", at(error.message));
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
                .pipe(Effect.ignore),
        ),
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
        standing && error.uncertain !== true
          ? new HandoffRefusal({
              status: 503,
              code: "failed",
              message: `${error.message} ${label} had accepted this handoff, so it may run the thread; ask again.`.slice(
                0,
                1000,
              ),
              uncertain: true,
            })
          : error,
      ),
    );
  };

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

  const transferStatusLocked = (caller: ReceiverCaller, request: TransferStatusRequest) =>
    Effect.gen(function* () {
      const lineage = {
        sourceEnvironmentId: caller.sourceEnvironmentId,
        sourceThreadId: request.sourceThreadId,
        epoch: request.epoch,
      };
      const current = yield* document;
      const replica = findIncoming(current, caller.sourceEnvironmentId, request.sourceThreadId);
      const detail = (current.incomingDetails ?? {})[
        incomingKey(caller.sourceEnvironmentId, request.sourceThreadId)
      ];
      // A copy continued here before transfer records existed has no acceptance on record.
      if (replica?.continuedThreadId != null && detail?.takeover != null) {
        return {
          machineLabel: label,
          status: "accepted",
          receipt: detail.takeover,
        } satisfies TransferStatusResponse;
      }
      const now = yield* nowIso;
      const settled = yield* updateTransfers((document) =>
        HandoffTransferStore.settleLineage(document, {
          lineage,
          operationId: request.operationId,
          now,
        }),
      );
      if (settled.verdict === "accepted") {
        // A restart cut the launch after the acceptance: finish it as it was asked.
        const receipt = settled.launched
          ? settled.receipt
          : yield* takeoverLocked(caller, {
              sourceEnvironmentId: caller.sourceEnvironmentId,
              sourceThreadId: request.sourceThreadId,
              epoch: settled.lineage.epoch,
              sequence: settled.sequence ?? 0,
              reason: settled.reason as TakeoverReason,
              modelSelection: settled.modelSelection,
              ...(settled.operationId === null ? {} : { operationId: settled.operationId }),
              ...(settled.trigger === null ? {} : { trigger: settled.trigger }),
            });
        return { machineLabel: label, status: "accepted", receipt } satisfies TransferStatusResponse;
      }
      // The copy's lease moves up to the refused epoch, so a takeover from a
      // source that sends no operation id is refused as stale too.
      yield* updateDocument((document) => {
        const held = findIncoming(document, caller.sourceEnvironmentId, request.sourceThreadId);
        if (held === undefined || held.continuedThreadId !== null) return [undefined, document];
        if (held.lease.epoch >= request.epoch) return [undefined, document];
        return [
          undefined,
          {
            ...document,
            incoming: document.incoming.map((entry) =>
              entry === held
                ? { ...entry, lease: { ...entry.lease, epoch: request.epoch, renewedAt: now } }
                : entry,
            ),
          },
        ];
      });
      return {
        machineLabel: label,
        status: "not-accepted",
        receipt: null,
      } satisfies TransferStatusResponse;
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

  return HandoffReceiver.of({
    negotiate,
    replicate,
    preflight,
    takeover,
    heartbeat,
    transferStatus,
    transferPull,
    attachPull: (handler) => Effect.sync(() => void (pullHandler = handler)),
  });
});

export const layer = Layer.effect(HandoffReceiver, make);
