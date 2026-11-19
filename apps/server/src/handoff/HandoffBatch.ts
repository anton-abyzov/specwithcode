// @effect-diagnostics nodeBuiltinImport:off - batch ids and ref names come from node:crypto.
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

import {
  type EnvironmentId,
  type HandoffBatchInput,
  type HandoffBatchRow,
  type HandoffBatchRun,
  type HandoffBatchStoredRow,
  type HandoffCheckpoint,
  type HandoffContextRevision,
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

import { runGit } from "../fleet/folderTransfer/git.ts";
import { ProjectSyncExtras } from "../fleet/ProjectSyncExtras.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BundleError, resolveRepositoryPath } from "./bundleGit.ts";
import { extrasProject } from "./ExtrasReceiver.ts";
import { HandoffMode } from "./HandoffMode.ts";
import type { HandoffPeerError } from "./handoffPeers.ts";
import { type HandoffPlan, outcomeLine } from "./handoffPlan.ts";
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
  // The working folder takes the snapshot's files; the index goes back to the
  // commit, so every change reads as uncommitted, as it did on the source.
  await runGit(root, ["read-tree", "-u", "--reset", snapshot]);
  await runGit(root, ["read-tree", head]);
  await runGit(root, ["update-ref", marker, snapshot]);
  return { applied: true, reason: null };
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
        const root = yield* Effect.tryPromise({
          try: () => resolveRepositoryPath(found.project.workspaceRoot, request.repositoryPath),
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

export const folderWorkReceiverLayer = Layer.effect(FolderWorkReceiver, makeFolderWorkReceiver);

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
  }): Effect.Effect<FolderWorkOutcome> =>
    Effect.gen(function* () {
      const label = input.destinationLabel;
      const inventory = yield* deps.inventory({ projectId: input.projectId });
      const items: Array<ProjectSyncExtraItem> = [];
      for (const repository of inventory.repositories) {
        for (const branch of repository.onlyHere) {
          items.push({ kind: "branch", path: repository.path, branch: branch.branch });
        }
        if (repository.changedFiles + repository.untrackedFiles > 0) {
          items.push({ kind: "uncommitted", path: repository.path, sendAnyway: [] });
        }
      }
      if (items.length === 0) {
        return {
          state: "stayed",
          detail: `No project folder work on ${deps.selfLabel}.`,
        } satisfies FolderWorkOutcome;
      }
      const sent = yield* deps.sendExtras({
        projectId: input.projectId,
        targetEnvironmentId: input.destination,
        operationId: input.operationId,
        items,
      });
      const lines: Array<string> = [];
      let arrived = 0;
      for (const item of sent.items) {
        const where = item.path === "" || item.path === "." ? "" : `${item.path}: `;
        if (item.status !== "sent" || item.arrivedAs === null) {
          lines.push(
            `${where}${item.kind === "branch" ? `branch ${item.branch}` : "uncommitted files"} stayed on ${deps.selfLabel}${
              item.detail === null ? (item.stays === null ? "" : ` (${item.stays})`) : `: ${item.detail}`
            }.`,
          );
          continue;
        }
        arrived += 1;
        const asBranch = `${where}On ${label} as branch ${item.arrivedAs}.`;
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
          lines.push(`${where}The uncommitted files are in ${label}'s working folder.`);
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
  }
>()("specweave-studio/handoff/HandoffBatch/HandoffFolderWork") {}

/** This server's folder work, read and sent by Sync's own extras. */
export const folderWorkLayer = Layer.effect(
  HandoffFolderWork,
  Effect.gen(function* () {
    const extras = yield* ProjectSyncExtras;
    return HandoffFolderWork.of({ inventory: extras.inventory, sendExtras: extras.sendExtras });
  }),
);

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
  const rows = (batch.rows ?? []).map((row): HandoffBatchRow => {
    const record = row.operationId === null ? undefined : document.transfers[row.operationId];
    if (record === undefined) {
      return { ...row, context: null, continuedThreadId: null };
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

  const updateBatch = (batchId: string, change: (batch: HandoffTransferBatch) => HandoffTransferBatch) =>
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
      const batchId = NodeCrypto.randomUUID();

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
      for (const thread of input.threads) if (!wanted.has(thread.threadId)) wanted.set(thread.threadId, thread);

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
        const stay =
          found._tag === "Failure"
            ? found.failure
            : found.success.coordinator
              ? failed("invalid", coordinatorStays(selfLabel))
              : found.success.personal
                ? failed("invalid", PERSONAL_STAYS)
                : unfit;
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

      // The batch is on disk, then each thread's record, before the first hold.
      yield* store.update((document) => [
        undefined,
        {
          ...document,
          batches: {
            ...document.batches,
            [batchId]: {
              batchId,
              targetEnvironmentId: destination,
              trigger,
              operationIds: [],
              createdAt: startedAt,
              start: input.start,
              targetLabel: label,
              rows,
              finishedAt: null,
            },
          },
        },
      ]);
      const movable = [...wanted.keys()].filter((threadId) => !early.has(threadId));
      const dispositions = new Map<ThreadId, HandoffTransferDisposition>();
      for (const threadId of movable) {
        const disposition = wanted.get(threadId)?.disposition;
        if (disposition !== undefined) dispositions.set(threadId, disposition);
      }
      const planned =
        movable.length === 0
          ? new Map<ThreadId, string>()
          : yield* deps.planBatch(movable, destination, reason, trigger, { batchId, dispositions });
      yield* Effect.addFinalizer(() => deps.endBatch(planned));
      yield* updateBatch(batchId, (batch) => ({
        ...batch,
        rows: (batch.rows ?? []).map((row) =>
          row.kind === "thread" && planned.has(row.id as ThreadId)
            ? { ...row, operationId: planned.get(row.id as ThreadId) ?? null }
            : row,
        ),
      }));

      for (const row of rows) {
        if (row.kind !== "folder-work" || row.state !== "pending" || deps.folderWork === null) {
          continue;
        }
        const outcome = yield* deps.folderWork({
          projectId: row.id as ProjectId,
          destination,
          destinationLabel: label,
          operationId: batchId,
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
      { ...options, reason: input.reason === "sleep" ? "sleep" : "machine-handoff" },
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

  return { run, read, handOffMachine };
}

export type HandoffBatchService = ReturnType<typeof makeHandoffBatch>;
