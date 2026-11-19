// @effect-diagnostics nodeBuiltinImport:off - batch ids and ref names come from node:crypto; folder checks read real paths.
/**
 * The hand off batch (1390): the one way work leaves this machine for
 * another, for a person's request and for the usage-limit rule alike.
 *
 * A batch names threads, each with what the destination does on arrival
 * (continue the interrupted run, or install the thread idle), and the project
 * folder work that goes along. It has no item for a coordinator, a routine or
 * project memory: it changes which machine runs a thread, and nothing else.
 * Coordinator conversations stay on their machines, routines keep their
 * runner, and project memory changes only through its own revision-checked
 * sync.
 *
 * The batch and every thread's transfer record are on disk before the first
 * thread is held, and this server runs the batch: a window that closes stops
 * waiting and stops nothing. Each thread is handed over at a named revision
 * of its context (its checkpoint's sequence and commit); the destination
 * takes exactly that revision or refuses.
 *
 * Disposition, revision and folder work in the working folder are this
 * feature's own wire additions, so they have their own capability. A
 * destination that does not name it takes no batch: every row reads "Needs
 * update" and nothing is held.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  type HandoffBatchInput,
  type HandoffBatchRow,
  type HandoffBatchRun,
  type HandoffBatchStoredRow,
  type HandoffCheckpoint,
  type HandoffContextRevision,
  type HandoffFolderWorkItem,
  type HandoffFolderWorkJournal,
  type HandOffInput,
  type HandoffMachineRun,
  type HandoffMachineThreadResult,
  type HandOffMachineInput,
  HandoffModeError,
  type HandoffModeErrorCode,
  type HandOffResult,
  type HandoffTransferBatch,
  type HandoffTransferDisposition,
  type HandoffTransferDocument,
  type HandoffTransferTrigger,
  isHandoffTransferFinished,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProjectSyncError,
  type ProjectSyncExtraItem,
  type ProjectSyncInventoryResult,
  type ProjectSyncSendExtrasResult,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { gitList, runGit } from "../fleet/folderTransfer/git.ts";
import { ProjectSync } from "../fleet/ProjectSync.ts";
import { ProjectSyncExtras } from "../fleet/ProjectSyncExtras.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BundleError, resolveRepositoryPath } from "./bundleGit.ts";
import { extrasProject } from "./ExtrasReceiver.ts";
import { HandoffMode } from "./HandoffMode.ts";
import type { HandoffPeerError } from "./handoffPeers.ts";
import { type HandoffPlan, outcomeLine } from "./handoffPlan.ts";
import { shouldResume } from "./handoffPreflight.ts";
import { HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import type { HandoffTransferStoreShape } from "./HandoffTransferStore.ts";
import {
  batchCapabilityFailure,
  type FolderWorkRequest,
  type FolderWorkResponse,
  HANDOFF_CAPABILITIES,
  type TakeoverReason,
  type TakeoverRequest,
  type TakeoverResponse,
} from "./handoffWire.ts";

const failed = (code: HandoffModeErrorCode, message: string) =>
  new HandoffModeError({ code, message });

const MANUAL: HandoffTransferTrigger = { kind: "manual" };

export const coordinatorStays = (label: string) =>
  `The coordinator conversation stays on ${label}. A hand off moves threads, never a coordinator.`;
export const PERSONAL_STAYS = "The personal assistant stays on this machine.";
const AUTOMATIC_NEEDS_RULE = "An automatic hand off names the rule that started it.";
const AUTOMATIC_NO_FOLDER_WORK =
  "Project folder work moves only when a person asks; an automatic hand off carries none.";
const SAME_MACHINE = "Pick another machine to hand this machine's threads to.";
const FOLDER_WORK_UNAVAILABLE =
  "This machine cannot read its project folder work now, so it stays here.";
const BRANCH_NEXT_STEP = "To use it there, check it out or merge it.";
export const PROJECT_NOT_READ =
  "This machine could not read the thread's project, so it cannot tell whose conversation it is. It stays here.";
const AUTOMATIC_WORKING =
  "It is working now. The usage-limit rule takes a thread that stopped, never one that works.";
const AUTOMATIC_NO_RULE =
  "This machine cannot read the usage-limit rule now, so nothing moves by it.";
const BATCH_STOPPED = "The server stopped before this thread was held. Nothing moved.";
const OUTSIDE_PROJECT = "The repository is not inside this project's folder.";
const NOT_A_PROJECT_REPOSITORY = "The repository is not one of this project's repositories.";

// What the plan asks for

/**
 * The batch a plan asks for: every ticked thread with the plan's disposition,
 * and the folder work of every ticked project. A row that stays is not in it.
 */
export function batchInputFromPlan(
  plan: HandoffPlan,
  trigger?: HandoffTransferTrigger,
): HandoffBatchInput {
  const threads: Array<HandoffBatchInput["threads"][number]> = [];
  const folderWork: Array<ProjectId> = [];
  for (const item of plan.items) {
    if (!item.ticked || item.disposition === "stays") continue;
    if (item.kind === "folder-work") folderWork.push(item.projectId);
    else threads.push({ threadId: item.id as ThreadId, disposition: item.disposition });
  }
  return {
    destinationEnvironmentId: plan.target.environmentId,
    start: plan.start,
    ...(trigger === undefined ? {} : { trigger }),
    threads,
    ...(folderWork.length === 0 ? {} : { folderWork }),
  };
}

// The destination: what a takeover of a batch does on arrival

/**
 * What the destination does with a takeover. A batch names the disposition and
 * the revision: "ready" installs the thread idle whatever its last run ended
 * on, "resume" continues it only when that run can be continued, and a copy at
 * another revision than the one handed over is refused. A takeover without the
 * batch's fields is decided by the checkpoint alone, as before batches.
 */
export function batchArrival(input: {
  readonly batch: TakeoverRequest["batch"];
  readonly sequence: number;
  readonly checkpoint: Pick<HandoffCheckpoint, "sequence" | "commit">;
  /** Whether the checkpoint's last run can be continued. */
  readonly resumable: boolean;
}): { readonly kind: "take"; readonly resume: boolean } | { readonly kind: "refuse" } {
  const batch = input.batch;
  if (batch === undefined) return { kind: "take", resume: input.resumable };
  if (
    batch.context.sequence !== input.sequence ||
    input.checkpoint.sequence !== batch.context.sequence ||
    input.checkpoint.commit !== batch.context.commit
  ) {
    return { kind: "refuse" };
  }
  return { kind: "take", resume: input.resumable && batch.disposition === "resume" };
}

/** `batchArrival` for a takeover as the receiver holds it: its checkpoint says whether a run can continue. */
export const takeoverArrival = (
  batch: TakeoverRequest["batch"],
  sequence: number,
  checkpoint: Pick<HandoffCheckpoint, "sequence" | "commit" | "runEnding">,
) => batchArrival({ batch, sequence, checkpoint, resumable: shouldResume(checkpoint.runEnding) });

export const REVISION_MISMATCH =
  "holds another revision of this thread than the one handed over, so it did not take it";

// The destination: folder work into the working folder

const markerRef = (operationId: string, branch: string) =>
  `refs/specwithcode/folder-work/${NodeCrypto.createHash("sha256")
    .update(`${operationId}\0${branch}`)
    .digest("hex")
    .slice(0, 40)}`;

const revParse = async (root: string, rev: string) => {
  const out = await runGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
    allowFailure: true,
  });
  return out.code === 0 ? out.stdout.trim() : null;
};

/**
 * Puts a snapshot that arrived as a branch into the working folder as
 * uncommitted files, exactly as they were on the source, when that is safe:
 * the repository is at the snapshot's parent commit and has no changes of its
 * own. Otherwise nothing changes and the files stay a branch, with the reason.
 * The same operation again gets the first answer and changes nothing.
 */
export async function applyFolderWork(input: {
  readonly root: string;
  readonly branch: string;
  readonly operationId: string;
}): Promise<{ readonly applied: boolean; readonly reason: string | null }> {
  const { root, branch } = input;
  const marker = markerRef(input.operationId, branch);
  const stays = (reason: string) => ({ applied: false, reason });
  const snapshot = await revParse(root, `refs/heads/${branch}`);
  if (snapshot === null) return stays(`the branch ${branch} is not here`);
  // Applied before under this operation: the folder now holds those files.
  if ((await revParse(root, marker)) === snapshot) return { applied: true, reason: null };
  const parents = (await runGit(root, ["rev-list", "--parents", "-n", "1", snapshot])).stdout
    .trim()
    .split(" ")
    .slice(1);
  if (parents.length !== 1) return stays("the snapshot is not one commit on top of the folder's");
  const head = await revParse(root, "HEAD");
  if (head !== parents[0]) {
    return stays("the folder is at another commit than the one these files were changed on");
  }
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout.trim() !== "") return stays("the folder has changes of its own");
  // A file Git ignores is not in that status. Where the snapshot brings a path
  // the commit does not track, anything already there is this folder's alone.
  const added = await gitList(root, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=A",
    "-z",
    head,
    snapshot,
  ]);
  for (const path of added) {
    if (await occupied(root, path)) {
      return stays(`this folder has its own ${path}, which Git does not list`);
    }
  }
  // A merge of the two trees, not a reset: Git checks every file it would
  // touch against the commit first and changes nothing when one differs.
  await runGit(root, ["update-index", "-q", "--refresh"], { allowFailure: true });
  const merged = await runGit(root, ["read-tree", "-m", "-u", head, snapshot], {
    allowFailure: true,
  });
  if (merged.code !== 0) return stays("a file here changed or is in the way");
  // The index goes back to the commit, so every change reads as uncommitted,
  // as it did on the source.
  await runGit(root, ["read-tree", head]);
  await runGit(root, ["update-ref", marker, snapshot]);
  return { applied: true, reason: null };
}

/** Whether something of this folder's own sits at `path` or where one of its folders must be. */
async function occupied(root: string, path: string): Promise<boolean> {
  const segments = path.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const stat = await NodeFSP.lstat(NodePath.join(root, ...segments.slice(0, depth))).catch(
      () => null,
    );
    if (stat === null) return false;
    // The path itself, or a parent that is a file or a link: the files would replace or pass through it.
    if (depth === segments.length || !stat.isDirectory()) return true;
  }
  return false;
}

/**
 * The repository folder work is applied in: one of the granted project's own
 * repositories, and really inside the project's folder. A path that climbs out
 * of the folder, a link that leads elsewhere, and a repository the project
 * does not list are refused. `eligible` null: only the project's own folder.
 */
export async function folderWorkRoot(input: {
  readonly projectRoot: string;
  readonly repositoryPath: string;
  readonly eligible: ReadonlyArray<string> | null;
}): Promise<string> {
  const segments = input.repositoryPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) throw new BundleError("invalid", OUTSIDE_PROJECT);
  const relative = segments.join("/");
  const listed = new Set(
    (input.eligible ?? [""]).map((path) =>
      path
        .split("/")
        .filter((segment) => segment.length > 0 && segment !== ".")
        .join("/"),
    ),
  );
  if (!listed.has(relative)) throw new BundleError("invalid", NOT_A_PROJECT_REPOSITORY);
  const root = await resolveRepositoryPath(input.projectRoot, relative);
  const [real, project] = await Promise.all([
    NodeFSP.realpath(root),
    NodeFSP.realpath(input.projectRoot),
  ]);
  if (real !== project && !real.startsWith(project + NodePath.sep)) {
    throw new BundleError("invalid", OUTSIDE_PROJECT);
  }
  return real;
}

export class FolderWorkReceiver extends Context.Service<
  FolderWorkReceiver,
  {
    readonly apply: (
      caller: ReceiverCaller,
      request: FolderWorkRequest,
    ) => Effect.Effect<FolderWorkResponse, HandoffRefusal>;
  }
>()("specweave-studio/handoff/HandoffBatch/FolderWorkReceiver") {}

/**
 * This machine's side of a batch's folder work. The grant is checked here,
 * when the files would be written: the project must be linked to the source's
 * and the work grant that machine holds here must cover it.
 */
export const makeFolderWorkReceiver = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const folder = yield* Effect.serviceOption(HandoffFolderWork);
  const locks = yield* KeyedLock.make<string>();
  const label = handoff.machineLabel;
  const at = (message: string) => `${label}: ${message}`;
  const fromGit = (cause: unknown) =>
    new HandoffRefusal({
      status: cause instanceof BundleError && cause.code !== "failed" ? 409 : 500,
      code: cause instanceof BundleError && cause.code !== "failed" ? "invalid" : "failed",
      message: at(cause instanceof BundleError ? cause.message : "Git did not finish"),
    });
  return FolderWorkReceiver.of({
    apply: (caller, request) =>
      Effect.gen(function* () {
        const snapshot = yield* projects.snapshot.pipe(
          Effect.mapError(
            () =>
              new HandoffRefusal({
                status: 500,
                code: "failed",
                message: at("could not read its projects"),
              }),
          ),
        );
        const found = extrasProject({
          projects: snapshot.projects,
          selfEnvironmentId: handoff.environmentId,
          caller,
          sourceEnvironmentId: request.sourceEnvironmentId,
          sourceProjectId: request.sourceProjectId,
        });
        if (found.kind === "refused") {
          return yield* new HandoffRefusal({
            status: found.status,
            code: found.code,
            message: at(found.message),
            ...(found.check === undefined ? {} : { check: found.check }),
          });
        }
        const eligible =
          folder._tag === "None"
            ? null
            : yield* folder.value.repositories(found.project.id).pipe(
                Effect.mapError(
                  () =>
                    new HandoffRefusal({
                      status: 500,
                      code: "failed",
                      message: at("could not read this project's repositories"),
                    }),
                ),
              );
        const root = yield* Effect.tryPromise({
          try: () =>
            folderWorkRoot({
              projectRoot: found.project.workspaceRoot,
              repositoryPath: request.repositoryPath,
              eligible,
            }),
          catch: fromGit,
        });
        const done = yield* locks.withLock(
          root,
          Effect.tryPromise({
            try: () =>
              applyFolderWork({
                root,
                branch: request.branch,
                operationId: request.operationId,
              }),
            catch: fromGit,
            // A caller that goes away does not leave the folder half written.
          }).pipe(Effect.uninterruptible),
        );
        return {
          machineLabel: label.slice(0, 120),
          capabilities: [...HANDOFF_CAPABILITIES],
          applied: done.applied,
          reason: done.reason === null ? null : done.reason.slice(0, 500),
        } satisfies FolderWorkResponse;
      }),
  });
});

// The source: folder work

export interface FolderWorkOutcome {
  /** `ready`: it is on the destination. `stayed`: nothing to move or it could not go. `failed`: sending broke. */
  readonly state: "ready" | "stayed" | "failed";
  readonly detail: string;
}

export interface FolderWorkSenderDeps {
  readonly selfEnvironmentId: EnvironmentId;
  readonly selfLabel: string;
  readonly inventory: (input: {
    readonly projectId: ProjectId;
  }) => Effect.Effect<ProjectSyncInventoryResult, ProjectSyncError>;
  readonly sendExtras: (input: {
    readonly projectId: ProjectId;
    readonly targetEnvironmentId: EnvironmentId;
    readonly operationId: string;
    readonly items: ReadonlyArray<ProjectSyncExtraItem>;
  }) => Effect.Effect<ProjectSyncSendExtrasResult, ProjectSyncError>;
  readonly apply: (
    destination: EnvironmentId,
    request: FolderWorkRequest,
  ) => Effect.Effect<FolderWorkResponse, HandoffPeerError | HandoffRefusal>;
}

/**
 * Sends one project's folder work: its branches that exist only here travel as
 * branches, and its uncommitted files travel as a snapshot branch that the
 * destination then puts into its working folder when that is safe. The source
 * keeps every file. The result names, per repository, where the work is on the
 * destination and the next step for what stayed a branch.
 */
export const makeFolderWorkSender =
  (deps: FolderWorkSenderDeps) =>
  (input: {
    readonly projectId: ProjectId;
    readonly destination: EnvironmentId;
    readonly destinationLabel: string;
    readonly operationId: string;
    /** What this operation's row already keeps: a server that stopped carries on from it. */
    readonly journal?: HandoffFolderWorkJournal | undefined;
    /**
     * Writes the journal to the row; false when it could not be written. Every
     * caller in the server passes it: without it nothing says what was sent.
     */
    readonly record: (journal: HandoffFolderWorkJournal) => Effect.Effect<boolean>;
  }): Effect.Effect<FolderWorkOutcome> =>
    Effect.gen(function* () {
      const label = input.destinationLabel;
      const record = input.record;
      const where = (path: string) => (path === "" || path === "." ? "" : `${path}: `);
      const named = (item: HandoffFolderWorkItem) =>
        `${where(item.path)}${item.kind === "branch" ? `branch ${item.branch}` : "uncommitted files"}`;
      let items = input.journal?.items;
      let receipt = input.journal?.receipt ?? null;
      if (items !== undefined && receipt === null) {
        // The send began and its answer never reached the row. The folder may
        // hold later work by now, so nothing is read or sent again for this batch.
        return {
          state: "failed",
          detail:
            `The server stopped while it was sending this to ${label}: ${items.map(named).join(", ")}. Nothing was sent again. What had arrived is on ${label} as a branch, and every file is still on ${deps.selfLabel}. Hand off again to send the folder as it is now.`.slice(
              0,
              1000,
            ),
        } satisfies FolderWorkOutcome;
      }
      if (items === undefined) {
        const inventory = yield* deps.inventory({ projectId: input.projectId });
        const found: Array<HandoffFolderWorkItem> = [];
        for (const repository of inventory.repositories) {
          for (const branch of repository.onlyHere) {
            found.push({ kind: "branch", path: repository.path, branch: branch.branch });
          }
          if (repository.changedFiles + repository.untrackedFiles > 0) {
            found.push({ kind: "uncommitted", path: repository.path, branch: null });
          }
        }
        if (found.length === 0) {
          return {
            state: "stayed",
            detail: `No project folder work on ${deps.selfLabel}.`,
          } satisfies FolderWorkOutcome;
        }
        // On file before anything leaves: a restart sends these or nothing.
        if (!(yield* record({ items: found, receipt: null }))) {
          return {
            state: "failed",
            detail: "Project folder work was not sent: the batch's record could not be written.",
          } satisfies FolderWorkOutcome;
        }
        items = found;
      }
      if (receipt === null) {
        const sent = yield* deps.sendExtras({
          projectId: input.projectId,
          targetEnvironmentId: input.destination,
          operationId: input.operationId,
          items: items.map((item): ProjectSyncExtraItem =>
            item.kind === "branch"
              ? { kind: "branch", path: item.path, branch: item.branch ?? "" }
              : { kind: "uncommitted", path: item.path, sendAnyway: [] },
          ),
        });
        receipt = sent.items.map((item) => {
          const arrived = item.status === "sent" && item.arrivedAs !== null;
          return {
            kind: item.kind,
            path: item.path,
            branch: item.branch,
            arrivedAs: arrived ? item.arrivedAs : null,
            note: arrived
              ? null
              : (item.detail === null
                  ? item.stays === null
                    ? ""
                    : ` (${item.stays})`
                  : `: ${item.detail}`
                ).slice(0, 600),
          };
        });
        // Where each piece is on the destination, by name: a restart reads this and sends nothing.
        yield* record({ items, receipt });
      }
      const lines: Array<string> = [];
      let arrived = 0;
      for (const item of receipt) {
        if (item.arrivedAs === null) {
          lines.push(`${named(item)} stayed on ${deps.selfLabel}${item.note ?? ""}.`);
          continue;
        }
        arrived += 1;
        const asBranch = `${where(item.path)}On ${label} as branch ${item.arrivedAs}.`;
        if (item.kind === "branch") {
          lines.push(`${asBranch} ${BRANCH_NEXT_STEP}`);
          continue;
        }
        const applied = yield* deps
          .apply(input.destination, {
            sourceEnvironmentId: deps.selfEnvironmentId,
            sourceLabel: deps.selfLabel.slice(0, 120),
            sourceProjectId: input.projectId,
            repositoryPath: item.path,
            operationId: input.operationId,
            branch: item.arrivedAs,
          })
          .pipe(Effect.result);
        if (applied._tag === "Success" && applied.success.applied) {
          lines.push(`${where(item.path)}The uncommitted files are in ${label}'s working folder.`);
        } else {
          const why =
            applied._tag === "Success"
              ? (applied.success.reason ?? "it was not safe to put them into the working folder")
              : applied.failure.message;
          lines.push(`${asBranch} Not put into the working folder: ${why}. ${BRANCH_NEXT_STEP}`);
        }
      }
      return {
        state: arrived > 0 ? "ready" : "stayed",
        detail: lines.join(" ").slice(0, 1000),
      } satisfies FolderWorkOutcome;
    }).pipe(
      Effect.catch((error: ProjectSyncError) =>
        Effect.succeed({
          state: "failed",
          detail: `Project folder work was not sent: ${error.reason}`.slice(0, 1000),
        } satisfies FolderWorkOutcome),
      ),
    );

/** The folder work a batch can send from this machine, where the server provides it. */
export class HandoffFolderWork extends Context.Service<
  HandoffFolderWork,
  {
    readonly inventory: FolderWorkSenderDeps["inventory"];
    readonly sendExtras: FolderWorkSenderDeps["sendExtras"];
    /** The paths of the project's own repositories, as Sync lists them ("" is the project's folder). */
    readonly repositories: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, ProjectSyncError>;
  }
>()("specweave-studio/handoff/HandoffBatch/HandoffFolderWork") {}

/**
 * The usage-limit rule's own answer for a thread an automatic start names:
 * why the thread stays, or null when the rule takes it now. The server reads
 * it; a window's list of threads is a request, never the decision.
 */
export class HandoffBatchAdmission extends Context.Service<
  HandoffBatchAdmission,
  {
    readonly automatic: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly destination: EnvironmentId;
      readonly trigger: HandoffTransferTrigger;
    }) => Effect.Effect<string | null>;
  }
>()("specweave-studio/handoff/HandoffBatch/HandoffBatchAdmission") {}

/** This server's folder work, read and sent by Sync's own extras. */
export const folderWorkLayer = Layer.effect(
  HandoffFolderWork,
  Effect.gen(function* () {
    const extras = yield* ProjectSyncExtras;
    const sync = yield* ProjectSync;
    return HandoffFolderWork.of({
      inventory: extras.inventory,
      sendExtras: extras.sendExtras,
      repositories: (projectId) =>
        sync
          .repositories(projectId)
          .pipe(Effect.map((found) => found.repositories.map((repository) => repository.path))),
    });
  }),
);

/** The destination's side, with the project's own repositories read from Sync. */
export const folderWorkReceiverLayer = Layer.effect(
  FolderWorkReceiver,
  makeFolderWorkReceiver,
).pipe(Layer.provide(folderWorkLayer));

// The source: the batch

export interface BatchMove {
  readonly result: HandOffResult;
  /** The destination's own answer; null when the thread had already moved there. */
  readonly receipt: TakeoverResponse | null;
}

export interface HandoffBatchDeps {
  readonly self: EnvironmentId;
  readonly selfLabel: string;
  readonly store: HandoffTransferStoreShape;
  readonly nowIso: Effect.Effect<string>;
  readonly peerLabel: (destination: EnvironmentId) => Effect.Effect<string, HandoffModeError>;
  /** What the destination names; it fails when the machine does not answer. */
  readonly capabilities: (
    destination: EnvironmentId,
  ) => Effect.Effect<ReadonlyArray<string> | undefined, HandoffModeError>;
  /** The thread, and whether it is a coordinator conversation or a personal assistant's. */
  readonly thread: (threadId: ThreadId) => Effect.Effect<
    {
      readonly shell: OrchestrationV2ThreadShell;
      readonly coordinator: boolean;
      readonly personal: boolean;
    },
    HandoffModeError
  >;
  /** One record per thread, written before the first hold (the transfer runner's). */
  readonly planBatch: (
    threadIds: ReadonlyArray<ThreadId>,
    destination: EnvironmentId,
    reason: TakeoverReason,
    trigger: HandoffTransferTrigger,
    options: {
      readonly batchId: string;
      readonly dispositions: ReadonlyMap<ThreadId, HandoffTransferDisposition>;
      /** The batch with its rows, written in the same write as the records, each row linked to its own. */
      readonly entry: HandoffTransferBatch;
    },
  ) => Effect.Effect<ReadonlyMap<ThreadId, string>, HandoffModeError>;
  readonly endBatch: (planned: ReadonlyMap<ThreadId, string>) => Effect.Effect<void>;
  /** One thread's move under its record, with the batch's disposition and revision on the wire. */
  readonly move: (
    input: HandOffInput,
    reason: TakeoverReason,
    start: {
      readonly trigger: HandoffTransferTrigger;
      readonly operationId: string | undefined;
      readonly disposition: HandoffTransferDisposition | undefined;
      readonly batchId: string;
    },
  ) => Effect.Effect<BatchMove, HandoffModeError>;
  /** Null where this server cannot read folder work. */
  readonly folderWork: ReturnType<typeof makeFolderWorkSender> | null;
  /** The usage-limit rule's own answer for an automatic start; null where it cannot be read. */
  readonly admission: HandoffBatchAdmission["Service"] | null;
  readonly projectTitle: (projectId: ProjectId) => Effect.Effect<string>;
}

export interface BatchThreadOutcome {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly moved:
    | { readonly ok: true; readonly move: BatchMove; readonly carried: string | null }
    | { readonly ok: false; readonly error: HandoffModeError };
}

export interface BatchOptions {
  /** The takeover reason on the wire; a batch asked through its own call is a machine handoff. */
  readonly reason?: TakeoverReason;
  /**
   * Runs before a thread moves and returns what to do once it has: Away mode
   * reads the queued messages first and carries them after.
   */
  /** The asking window's name for the batch, so it finds its own records; a name taken is not reused. */
  readonly named?: string | undefined;
  readonly aroundMove?: (
    threadId: ThreadId,
  ) => Effect.Effect<(continued: ThreadId) => Effect.Effect<string | null>>;
}

const finishedRow = (state: HandoffBatchStoredRow["state"]) => isHandoffTransferFinished(state);

/** A batch as its rows read now: a thread row follows its transfer record. */
export function batchRunOf(
  document: HandoffTransferDocument,
  batch: HandoffTransferBatch,
): HandoffBatchRun {
  const label = batch.targetLabel ?? String(batch.targetEnvironmentId);
  const rows = (batch.rows ?? []).map(({ folderWork: _journal, ...row }): HandoffBatchRow => {
    const record = row.operationId === null ? undefined : document.transfers[row.operationId];
    if (record === undefined) {
      return { ...row, context: null, continuedThreadId: row.continuedThreadId ?? null };
    }
    const arrived = record.state === "resumed" || record.state === "ready";
    const line = arrived
      ? outcomeLine(record.state === "resumed" ? "resume" : "ready", label)
      : null;
    return {
      ...row,
      disposition: record.disposition,
      state: record.state,
      detail:
        line === null
          ? (record.detail ?? row.detail)
          : [line, record.receipt?.notice ?? null]
              .filter((part): part is string => part !== null && part !== "")
              .join(". ")
              .slice(0, 1000),
      context: (record.context as HandoffContextRevision | undefined) ?? null,
      continuedThreadId: record.receipt?.threadId ?? null,
    };
  });
  const open = rows.some((row) => !finishedRow(row.state));
  return {
    batchId: batch.batchId,
    start: batch.start ?? "manual",
    trigger: batch.trigger,
    destination: { environmentId: batch.targetEnvironmentId, label: label.slice(0, 120) },
    rows,
    startedAt: batch.createdAt,
    finishedAt: open ? null : (batch.finishedAt ?? batch.createdAt),
  };
}

export function makeHandoffBatch(deps: HandoffBatchDeps) {
  const { self, selfLabel, store } = deps;
  /** The batches this process runs now: the rest on file belong to a server that stopped. */
  const running = new Set<string>();

  const updateBatch = (
    batchId: string,
    change: (batch: HandoffTransferBatch) => HandoffTransferBatch,
  ) =>
    store.update((document) => {
      const batch = document.batches[batchId];
      if (batch === undefined) return [undefined, document] as const;
      return [
        undefined,
        { ...document, batches: { ...document.batches, [batchId]: change(batch) } },
      ] as const;
    });

  const patchRow = (
    batchId: string,
    kind: HandoffBatchStoredRow["kind"],
    id: string,
    patch: Partial<HandoffBatchStoredRow>,
  ) =>
    updateBatch(batchId, (batch) => ({
      ...batch,
      rows: (batch.rows ?? []).map((row) =>
        row.kind === kind && row.id === id ? { ...row, ...patch } : row,
      ),
    })).pipe(Effect.ignore);

  /** Keeps a folder row's journal; false when it could not be written. */
  const journalOf =
    (batchId: string, projectId: string) => (folderWork: HandoffFolderWorkJournal) =>
      updateBatch(batchId, (batch) => ({
        ...batch,
        rows: (batch.rows ?? []).map((row) =>
          row.kind === "folder-work" && row.id === projectId ? { ...row, folderWork } : row,
        ),
      })).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

  const execute = (input: HandoffBatchInput, options: BatchOptions = {}) =>
    Effect.gen(function* () {
      const destination = input.destinationEnvironmentId;
      if (destination === self) return yield* failed("invalid", SAME_MACHINE);
      const trigger = input.trigger ?? MANUAL;
      const folderProjects = [...new Set(input.folderWork ?? [])];
      if (input.start === "automatic") {
        if (trigger.kind !== "automatic") return yield* failed("invalid", AUTOMATIC_NEEDS_RULE);
        if (folderProjects.length > 0) return yield* failed("invalid", AUTOMATIC_NO_FOLDER_WORK);
      }
      const reason = options.reason ?? "machine-handoff";
      const label = (yield* deps.peerLabel(destination)).slice(0, 120);
      const startedAt = yield* deps.nowIso;
      // The name is claimed in one write: of two requests that ask for it at
      // once, one holds it and the other gets a name of its own.
      const asked = options.named;
      const batchId = yield* store.update((document) => {
        const id =
          asked !== undefined && document.batches[asked] === undefined
            ? asked
            : NodeCrypto.randomUUID();
        return [
          id,
          {
            ...document,
            batches: {
              ...document.batches,
              [id]: {
                batchId: id,
                targetEnvironmentId: destination,
                trigger,
                operationIds: [],
                createdAt: startedAt,
              },
            },
          },
        ] as const;
      });

      // The destination must name the batch's capability before anything is held for it.
      const named = yield* deps.capabilities(destination).pipe(Effect.result);
      const unfit =
        named._tag === "Failure"
          ? named.failure
          : (() => {
              const failure = batchCapabilityFailure({
                peerLabel: label,
                capabilities: named.success,
              });
              return failure === null ? null : failed("invalid", failure.message);
            })();

      const wanted = new Map<ThreadId, HandoffBatchInput["threads"][number]>();
      for (const thread of input.threads)
        if (!wanted.has(thread.threadId)) wanted.set(thread.threadId, thread);

      const rows: Array<HandoffBatchStoredRow> = [];
      const early = new Map<ThreadId, HandoffModeError>();
      const titles = new Map<ThreadId, string>();
      // Folder work first: it is on the destination before any thread starts there.
      for (const projectId of folderProjects) {
        const stay = unfit?.message ?? (deps.folderWork === null ? FOLDER_WORK_UNAVAILABLE : null);
        rows.push({
          kind: "folder-work",
          id: projectId,
          title: (yield* deps.projectTitle(projectId)).slice(0, 500),
          projectId,
          operationId: null,
          disposition: "ready",
          state: stay === null ? "pending" : "stayed",
          detail: stay === null ? null : stay.slice(0, 1000),
        });
      }
      for (const threadId of wanted.keys()) {
        const found = yield* deps.thread(threadId).pipe(Effect.result);
        const title =
          found._tag === "Success" ? found.success.shell.title.slice(0, 500) : String(threadId);
        titles.set(threadId, title);
        let stay =
          found._tag === "Failure"
            ? found.failure
            : found.success.coordinator
              ? failed("invalid", coordinatorStays(selfLabel))
              : found.success.personal
                ? failed("invalid", PERSONAL_STAYS)
                : unfit;
        if (stay === null && found._tag === "Success" && input.start === "automatic") {
          // The window named this thread; the server decides whether the rule takes it now.
          const shell = found.success.shell;
          const why =
            shell.activeRunId !== null
              ? AUTOMATIC_WORKING
              : deps.admission === null
                ? AUTOMATIC_NO_RULE
                : yield* deps.admission.automatic({
                    threadId,
                    projectId: shell.projectId,
                    destination,
                    trigger,
                  });
          if (why !== null) stay = failed("invalid", why.slice(0, 1000));
        }
        if (stay !== null) early.set(threadId, stay);
        rows.push({
          kind: "thread",
          id: threadId,
          title,
          projectId: found._tag === "Success" ? found.success.shell.projectId : null,
          operationId: null,
          disposition: wanted.get(threadId)?.disposition ?? null,
          state: stay === null ? "pending" : "stayed",
          detail: stay === null ? null : stay.message.slice(0, 1000),
        });
      }

      // The batch and each thread's record go to disk in one write, before the
      // first hold: no row waits on file without the record that will end it.
      running.add(batchId);
      yield* Effect.addFinalizer(() => Effect.sync(() => running.delete(batchId)));
      const entry: HandoffTransferBatch = {
        batchId,
        targetEnvironmentId: destination,
        trigger,
        operationIds: [],
        createdAt: startedAt,
        start: input.start,
        targetLabel: label,
        rows,
        finishedAt: null,
      };
      const movable = [...wanted.keys()].filter((threadId) => !early.has(threadId));
      const dispositions = new Map<ThreadId, HandoffTransferDisposition>();
      for (const threadId of movable) {
        const disposition = wanted.get(threadId)?.disposition;
        if (disposition !== undefined) dispositions.set(threadId, disposition);
      }
      const planned = yield* deps.planBatch(movable, destination, reason, trigger, {
        batchId,
        dispositions,
        entry,
      });
      yield* Effect.addFinalizer(() => deps.endBatch(planned));

      for (const row of rows) {
        if (row.kind !== "folder-work" || row.state !== "pending" || deps.folderWork === null) {
          continue;
        }
        const outcome = yield* deps.folderWork({
          projectId: row.id as ProjectId,
          destination,
          destinationLabel: label,
          operationId: batchId,
          record: journalOf(batchId, row.id),
        });
        yield* patchRow(batchId, "folder-work", row.id, {
          state: outcome.state,
          detail: outcome.detail,
        });
      }

      const outcomes: Array<BatchThreadOutcome> = [];
      for (const threadId of wanted.keys()) {
        const title = titles.get(threadId) ?? String(threadId);
        const stayed = early.get(threadId);
        if (stayed !== undefined) {
          outcomes.push({ threadId, title, moved: { ok: false, error: stayed } });
          continue;
        }
        const after = options.aroundMove === undefined ? null : yield* options.aroundMove(threadId);
        const asked = wanted.get(threadId);
        const moved = yield* deps
          .move(
            {
              threadId,
              destinationEnvironmentId: destination,
              ...(asked?.modelSelection === undefined
                ? {}
                : { modelSelection: asked.modelSelection as ModelSelection }),
            },
            reason,
            {
              trigger,
              operationId: planned.get(threadId),
              disposition: asked?.disposition,
              batchId,
            },
          )
          .pipe(Effect.result);
        if (moved._tag === "Success") {
          const carried = after === null ? null : yield* after(moved.success.result.threadId);
          if (!planned.has(threadId)) {
            // No record of this batch (the thread had already moved there): the row keeps the answer.
            yield* patchRow(batchId, "thread", threadId, {
              state: moved.success.receipt?.resumed === true ? "resumed" : "ready",
              detail: moved.success.result.notice,
              continuedThreadId: moved.success.result.threadId,
            });
          }
          outcomes.push({ threadId, title, moved: { ok: true, move: moved.success, carried } });
        } else {
          const detail = (
            moved.failure.code === "needs_grant"
              ? `Not moved: ${moved.failure.message}`
              : moved.failure.message
          ).slice(0, 1000);
          // A row with a record reads its state there (stayed, failed, or still waiting).
          yield* patchRow(
            batchId,
            "thread",
            threadId,
            planned.has(threadId) ? { detail } : { state: "stayed", detail },
          );
          outcomes.push({ threadId, title, moved: { ok: false, error: moved.failure } });
        }
      }
      const finishedAt = yield* deps.nowIso;
      yield* updateBatch(batchId, (batch) => ({ ...batch, finishedAt })).pipe(Effect.ignore);
      const document = yield* store.read;
      const batch = document.batches[batchId];
      if (batch === undefined) return yield* failed("failed", "The batch's record is gone.");
      return { run: batchRunOf(document, batch), outcomes, label, startedAt, finishedAt };
    }).pipe(Effect.scoped);

  /** The batch runs in a fiber of this server: a window that closes stops waiting, not the moves. */
  const owned = (input: HandoffBatchInput, options?: BatchOptions) =>
    execute(input, options).pipe(Effect.forkDetach, Effect.flatMap(Fiber.join));

  const run = (input: HandoffBatchInput): Effect.Effect<HandoffBatchRun, HandoffModeError> =>
    owned(input).pipe(Effect.map((done) => done.run));

  const read = (input: { readonly batchId?: string | undefined }) =>
    store.read.pipe(
      Effect.map((document) =>
        Object.values(document.batches)
          .filter((batch) => batch.rows !== undefined)
          .filter((batch) => input.batchId === undefined || batch.batchId === input.batchId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((batch) => batchRunOf(document, batch)),
      ),
    );

  /**
   * The machine handoff older callers ask for (the menu's dialog, sleep, Away
   * mode): the same batch, answered in the shape they read.
   */
  const handOffMachine = (
    input: HandOffMachineInput & { readonly threadIds: ReadonlyArray<ThreadId> },
    options: Pick<BatchOptions, "aroundMove"> = {},
  ): Effect.Effect<HandoffMachineRun, HandoffModeError> =>
    owned(
      {
        destinationEnvironmentId: input.destinationEnvironmentId,
        start: "manual",
        threads: input.threadIds.map((threadId) => ({ threadId })),
      },
      {
        ...options,
        named: input.batchId,
        reason: input.reason === "sleep" ? "sleep" : "machine-handoff",
      },
    ).pipe(
      Effect.map((done) => ({
        destinationEnvironmentId: input.destinationEnvironmentId,
        destinationLabel: done.label,
        // The saved run keeps the reasons older servers read; Away keeps its own session.
        reason: input.reason === "sleep" ? ("sleep" as const) : ("manual" as const),
        startedAt: done.startedAt,
        finishedAt: done.finishedAt,
        results: done.outcomes.map((outcome): HandoffMachineThreadResult => {
          if (outcome.moved.ok) {
            const { move, carried } = outcome.moved;
            return {
              threadId: outcome.threadId,
              title: outcome.title,
              outcome: "moved",
              detail:
                [move.result.notice, carried]
                  .filter((part): part is string => part !== null && part !== "")
                  .join(" ")
                  .slice(0, 500) || null,
              continuedThreadId: move.result.threadId,
              // What the destination did, not what ran here before the move.
              resumed: move.receipt?.resumed === true,
            };
          }
          const error = outcome.moved.error;
          return {
            threadId: outcome.threadId,
            title: outcome.title,
            outcome: error.code === "fenced" ? "skipped" : "stayed",
            detail: (error.code === "needs_grant"
              ? `Not moved: ${error.message}`
              : error.message
            ).slice(0, 500),
            continuedThreadId: null,
            resumed: false,
          };
        }),
      })),
    );

  /**
   * Ends what a stopped server left open. A thread row with no record never
   * held its thread, so it reads Stayed (or is linked to the record its move
   * wrote). Folder work carries on from its row's journal under the batch's
   * own operation id: what arrived is put in place again by name, what was
   * never begun is sent, and a send that was cut is never repeated. The
   * destination is asked for the batch capability first, as a new batch asks,
   * and while it does not answer the row waits. Rows with a record are ended by
   * the transfer runner.
   */
  const reconcile = Effect.gen(function* () {
    const document = yield* store.read;
    for (const batch of Object.values(document.batches)) {
      if (batch.rows === undefined || running.has(batch.batchId)) continue;
      const open = batch.rows.filter((row) => row.operationId === null && !finishedRow(row.state));
      if (open.length === 0) continue;
      const batchId = batch.batchId;
      running.add(batchId);
      yield* Effect.gen(function* () {
        const label = batch.targetLabel ?? String(batch.targetEnvironmentId);
        const folders = open.some((row) => row.kind === "folder-work");
        const named = folders
          ? yield* deps.capabilities(batch.targetEnvironmentId).pipe(Effect.result)
          : null;
        // No answer: nothing is sent on a guess, and the row is looked at again next time.
        const waits = named?._tag === "Failure";
        const unfit =
          named?._tag === "Success"
            ? batchCapabilityFailure({ peerLabel: label, capabilities: named.success })
            : null;
        for (const row of open) {
          if (row.kind === "thread") {
            const record = Object.values(document.transfers).find(
              (entry) => entry.batchId === batchId && entry.lineage.sourceThreadId === row.id,
            );
            yield* patchRow(
              batchId,
              "thread",
              row.id,
              record === undefined
                ? { state: "stayed", detail: BATCH_STOPPED }
                : { operationId: record.operationId },
            );
            continue;
          }
          if (waits) continue;
          // A machine from before batches is sent no extras. Where a send had
          // already begun, the journal alone says what became of it.
          const outcome: FolderWorkOutcome =
            deps.folderWork === null
              ? { state: "stayed", detail: FOLDER_WORK_UNAVAILABLE }
              : unfit !== null && row.folderWork === undefined
                ? { state: "stayed", detail: unfit.message.slice(0, 1000) }
                : yield* deps.folderWork({
                    projectId: row.id as ProjectId,
                    destination: batch.targetEnvironmentId,
                    destinationLabel: label,
                    operationId: batchId,
                    journal: row.folderWork,
                    record: journalOf(batchId, row.id),
                  });
          yield* patchRow(batchId, "folder-work", row.id, {
            state: outcome.state,
            detail: outcome.detail,
          });
        }
        if (waits) return;
        const finishedAt = yield* deps.nowIso;
        yield* updateBatch(batchId, (current) => ({
          ...current,
          finishedAt: current.finishedAt ?? finishedAt,
        })).pipe(Effect.ignore);
      }).pipe(Effect.ensuring(Effect.sync(() => running.delete(batchId))));
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Handoff could not reconcile its batches", { cause }),
    ),
  );

  return { run, read, handOffMachine, reconcile };
}

export type HandoffBatchService = ReturnType<typeof makeHandoffBatch>;
