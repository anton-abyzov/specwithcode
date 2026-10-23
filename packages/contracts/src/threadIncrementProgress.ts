import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The SpecWeave increment each thread of a project works on, with its tasks
 * and acceptance criteria folded from `spec.md` and `ledger.jsonl`. Read-only:
 * Studio never runs the CLI for this and never writes derived state back.
 * See docs/studio/plan-progress.md.
 */
export const THREAD_INCREMENT_PROGRESS_MAX_THREADS = 100;

export const ThreadIncrementProgressInput = Schema.Struct({
  projectId: ProjectId,
  /** Threads of the project to resolve; others are ignored. Sorted keeps the query key stable. */
  threadIds: Schema.Array(ThreadId).check(
    Schema.isMaxLength(THREAD_INCREMENT_PROGRESS_MAX_THREADS),
  ),
});
export type ThreadIncrementProgressInput = typeof ThreadIncrementProgressInput.Type;

/** Task states as SpecWeave's ledger fold derives them; `planned` is never claimed. */
export const ThreadIncrementTaskStatus = Schema.Literals([
  "planned",
  "claimed",
  "stale",
  "done",
  "released",
  "skipped",
  "blocked",
]);
export type ThreadIncrementTaskStatus = typeof ThreadIncrementTaskStatus.Type;

export const ThreadIncrementTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  status: ThreadIncrementTaskStatus,
  /** AC ids the task cites. */
  criteria: Schema.Array(Schema.String),
  /** The block or skip reason the ledger gives. */
  note: Schema.NullOr(Schema.String),
  /** The card line the ledger gives (`--line`), as written; absent falls back to the title. */
  line: Schema.optional(Schema.String),
  /**
   * What the card links to: an https URL on github.com or claude.ai, or an
   * absolute path inside the increment folder. Anything else is dropped.
   */
  link: Schema.optional(Schema.String),
  /** The commit the done evidence names (`HEAD <sha>`), when it gives no link. */
  commit: Schema.optional(Schema.String),
  /**
   * When the ledger accepted its `done` (which requires evidence). Absent for
   * a task that is not done, or one only a legacy `**Status**: [x]` marks done.
   */
  doneAt: Schema.optional(Schema.String),
});
export type ThreadIncrementTask = typeof ThreadIncrementTask.Type;

/**
 * How far an acceptance criterion is proven, strongest first:
 * `verified` — every citing task is done with ledger evidence and the latest
 * `specweave verify` passed after the last of them; `evidenced` — done with
 * evidence, but verify is missing, failed or older; `declared` — only a tick
 * in the spec or a legacy task status says so; `skipped` — every citing task
 * was skipped; `open` — a citing task is unfinished; `uncovered` — no task
 * cites it; `unknown` — the ledger could not be read.
 */
export const ThreadIncrementCriterionState = Schema.Literals([
  "verified",
  "evidenced",
  "declared",
  "skipped",
  "open",
  "uncovered",
  "unknown",
]);
export type ThreadIncrementCriterionState = typeof ThreadIncrementCriterionState.Type;

export const ThreadIncrementCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  /** Every task citing it is done or skipped (and at least one cites it). Kept for older clients. */
  met: Schema.Boolean,
  state: Schema.optional(ThreadIncrementCriterionState),
  /** Ids of the tasks that cite it, in spec order. */
  tasks: Schema.optional(Schema.Array(Schema.String)),
  /** The user story it belongs to, such as `US-001`, when the spec names one. */
  story: Schema.optional(Schema.String),
});
export type ThreadIncrementCriterion = typeof ThreadIncrementCriterion.Type;

export const ThreadIncrementBinding = Schema.Literals([
  "manual",
  "claim",
  "branch",
  "checkpoint",
  "name",
]);
export type ThreadIncrementBinding = typeof ThreadIncrementBinding.Type;

export const ThreadIncrementProgress = Schema.Struct({
  threadId: ThreadId,
  /** The increment folder, such as `0920-studio-natural-voice`. */
  incrementId: TrimmedNonEmptyString,
  /**
   * How the thread is bound: `manual` — someone linked it in Studio; `claim` — the agent appended to this increment's
   * ledger from the thread (SpecWeave's per-thread binding file); `branch` —
   * its worktree branch is the increment's `inc/NNNN-*` branch, or a ledger
   * event's `by` names that branch; `checkpoint`
   * — SpecWeave's session checkpoint names it; `name` — its number or folder is
   * in the thread's title or branch.
   */
  binding: ThreadIncrementBinding,
  /** The task this thread's last ledger write touched, when bound by a claim. */
  boundTaskId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  /** `metadata.json` status, such as active, planned or completed. */
  status: Schema.String,
  /** Absolute folder the increment was read from: the thread's worktree when it has one. */
  incrementPath: TrimmedNonEmptyString,
  /** Absolute path of the spec, for "open spec". */
  specPath: Schema.NullOr(TrimmedNonEmptyString),
  /** False when the spec has no tasks or the ledger could not be read. */
  readable: Schema.Boolean,
  tasks: Schema.Array(ThreadIncrementTask),
  criteria: Schema.Array(ThreadIncrementCriterion),
  /** The last `specweave verify` run. */
  verify: Schema.NullOr(Schema.Struct({ ok: Schema.Boolean, ranAt: Schema.String })),
});
export type ThreadIncrementProgress = typeof ThreadIncrementProgress.Type;

export const ThreadIncrementProgressSnapshot = Schema.Struct({
  projectId: ProjectId,
  /** Only threads bound to an increment are listed. */
  threads: Schema.Array(ThreadIncrementProgress),
  /**
   * Listed threads that changed code with no increment, no small fix and no
   * "No increment needed" link; provider-native subagents are left out.
   * Absent from older servers and outside SpecWeave projects.
   */
  unplanned: Schema.optional(Schema.Array(ThreadId)),
  /** Whether the project plans with SpecWeave; absent from older servers. */
  specweave: Schema.optional(Schema.Boolean),
});
export type ThreadIncrementProgressSnapshot = typeof ThreadIncrementProgressSnapshot.Type;

/** Link a thread to an increment by hand, mark it as having none, or go back to automatic binding. */
export const ThreadIncrementLinkTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("increment"), incrementId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("auto") }),
]);
export type ThreadIncrementLinkTarget = typeof ThreadIncrementLinkTarget.Type;

export const ThreadIncrementLinkInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  link: ThreadIncrementLinkTarget,
});
export type ThreadIncrementLinkInput = typeof ThreadIncrementLinkInput.Type;

export const ThreadIncrementLinkResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  link: ThreadIncrementLinkTarget,
});
export type ThreadIncrementLinkResult = typeof ThreadIncrementLinkResult.Type;

/** The increments a thread can be linked to: those in its checkout, newest first. */
export const ProjectIncrementsListInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  /** Words that must all appear in the folder name or title. */
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** Only this metadata status, such as `active` or `completed`. */
  status: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** At most 300; an older client that sends none gets the first 300, as before. */
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(300)),
  ),
});
export type ProjectIncrementsListInput = typeof ProjectIncrementsListInput.Type;

export const ProjectIncrementSummary = Schema.Struct({
  incrementId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  status: Schema.String,
});
export type ProjectIncrementSummary = typeof ProjectIncrementSummary.Type;

export const ProjectIncrementsListResult = Schema.Struct({
  projectId: ProjectId,
  increments: Schema.Array(ProjectIncrementSummary),
  /** How many match the query and status, across every page. */
  total: Schema.optional(Schema.Int),
  /** Increments matching the query, by status, before the status filter. */
  statusCounts: Schema.optional(Schema.Record(Schema.String, Schema.Int)),
  /** The thread's current link, when it has one: absent is automatic. */
  link: Schema.optional(ThreadIncrementLinkTarget),
});
export type ProjectIncrementsListResult = typeof ProjectIncrementsListResult.Type;
