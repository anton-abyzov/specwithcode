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
});
export type ThreadIncrementTask = typeof ThreadIncrementTask.Type;

export const ThreadIncrementCriterion = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  /** Every task citing it is done or skipped (and at least one cites it). */
  met: Schema.Boolean,
});
export type ThreadIncrementCriterion = typeof ThreadIncrementCriterion.Type;

export const ThreadIncrementBinding = Schema.Literals(["manual", "claim", "checkpoint", "name"]);
export type ThreadIncrementBinding = typeof ThreadIncrementBinding.Type;

export const ThreadIncrementProgress = Schema.Struct({
  threadId: ThreadId,
  /** The increment folder, such as `0920-studio-natural-voice`. */
  incrementId: TrimmedNonEmptyString,
  /**
   * How the thread is bound: `manual` — someone linked it in Studio; `claim` — the agent appended to this increment's
   * ledger from the thread (SpecWeave's per-thread binding file); `checkpoint`
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
  /** The thread's current link, when it has one: absent is automatic. */
  link: Schema.optional(ThreadIncrementLinkTarget),
});
export type ProjectIncrementsListResult = typeof ProjectIncrementsListResult.Type;
