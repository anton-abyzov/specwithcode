import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ThreadIncrementCriterion,
  ThreadIncrementReview,
  ThreadIncrementTask,
} from "./threadIncrementProgress.ts";

/**
 * The project's SpecWeave increments as a board: one card per increment
 * folder, in the column its files put it in. Read-only and from disk
 * (`metadata.json`, `spec.md`, `ledger.jsonl`): no CLI, no network.
 */
export const PROJECT_BOARD_COLUMNS = ["planned", "active", "review", "done"] as const;
export const ProjectBoardColumn = Schema.Literals(PROJECT_BOARD_COLUMNS);
export type ProjectBoardColumn = typeof ProjectBoardColumn.Type;

/** Done cards returned when the client names no limit, and the most it may ask for. */
export const PROJECT_BOARD_DONE_DEFAULT = 30;
export const PROJECT_BOARD_DONE_MAX = 300;
export const PROJECT_BOARD_PULL_REQUESTS = 5;
/** Blockers a card carries; the increment view lists them all. */
export const PROJECT_BOARD_CARD_BLOCKERS = 3;
/** The Problem text the increment view gets, in characters. */
export const PROJECT_BOARD_PROBLEM_CHARS = 1_200;
/** Files of the increment's `reports/` folder the view can open. */
export const PROJECT_BOARD_REPORTS = 30;

export const ProjectBoardInput = Schema.Struct({
  projectId: ProjectId,
  /** Words that must all appear in the folder name or title. */
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** How many Done cards to return, newest first; the other columns are never cut. */
  doneLimit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(PROJECT_BOARD_DONE_MAX),
    ),
  ),
});
export type ProjectBoardInput = typeof ProjectBoardInput.Type;

/** One blocked task: what is stuck, why, and who said so. */
export const ProjectBoardBlocker = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  title: Schema.String,
  /** The reason the ledger's `block` event gives; null when it gave none. */
  note: Schema.NullOr(Schema.String),
  /** The ledger `by` of that event, such as `agent@host`. */
  by: Schema.NullOr(Schema.String),
  /** When it was blocked, as an ISO time. */
  at: Schema.NullOr(Schema.String),
  /** The block is younger than the two-hour lease, so its owner still holds the task. */
  leased: Schema.optional(Schema.Boolean),
});
export type ProjectBoardBlocker = typeof ProjectBoardBlocker.Type;

/**
 * Why a card sits in its column: `status` is what `metadata.json` says;
 * `tasks` means every task is done or skipped; `ledger` means the status file
 * still says planned but the ledger shows work (a task done or blocked, or a
 * claim inside its lease).
 */
export const ProjectBoardColumnReason = Schema.Literals(["status", "tasks", "ledger"]);
export type ProjectBoardColumnReason = typeof ProjectBoardColumnReason.Type;

export const ProjectBoardCard = Schema.Struct({
  incrementId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  /** `metadata.json` status, lower case; `unknown` when it has none. */
  status: Schema.String,
  column: ProjectBoardColumn,
  /** Tasks in the spec and how many are done or skipped; zeros when it names none. */
  tasks: Schema.Struct({
    total: Schema.Int,
    done: Schema.Int,
    /** Tasks claimed inside the two-hour lease; absent from older servers. */
    active: Schema.optional(Schema.Int),
    /** Tasks done, skipped ones left out; absent from older servers. */
    finished: Schema.optional(Schema.Int),
  }),
  /** A task is blocked, or the increment is paused. */
  blocked: Schema.Boolean,
  /** The increment is paused. Absent from older servers, like the fields below. */
  paused: Schema.optional(Schema.Boolean),
  /** `pausedReason` from `metadata.json`; null when it is not paused or gave none. */
  pausedReason: Schema.optional(Schema.NullOr(Schema.String)),
  /** How many tasks are blocked. */
  blockedTasks: Schema.optional(Schema.Int),
  /** The first blocked tasks, in spec order. */
  blockers: Schema.optional(
    Schema.Array(ProjectBoardBlocker).check(Schema.isMaxLength(PROJECT_BOARD_CARD_BLOCKERS)),
  ),
  columnReason: Schema.optional(ProjectBoardColumnReason),
  /** The last change SpecWeave recorded, as an ISO time. */
  updatedAt: Schema.NullOr(Schema.String),
  /** GitHub pull requests the ledger links, newest first. */
  pullRequests: Schema.Array(Schema.String).check(Schema.isMaxLength(PROJECT_BOARD_PULL_REQUESTS)),
  /** `spec.md` as an absolute path on the machine that answered; null when it has none. */
  specPath: Schema.NullOr(Schema.String),
});
export type ProjectBoardCard = typeof ProjectBoardCard.Type;

export const ProjectBoardResult = Schema.Struct({
  projectId: ProjectId,
  /** Planned, Active and In review in full; Done up to the limit. Newest change first. */
  cards: Schema.Array(ProjectBoardCard),
  /** Cards matching the query in each column, before the Done limit. */
  counts: Schema.Struct({
    planned: Schema.Int,
    active: Schema.Int,
    review: Schema.Int,
    done: Schema.Int,
  }),
  /** The server answers `projects.boardIncrement`; absent from older servers. */
  detail: Schema.optional(Schema.Boolean),
});
export type ProjectBoardResult = typeof ProjectBoardResult.Type;

/** One increment in full, for the board's increment view (`projects.boardIncrement`). */
export const ProjectBoardIncrementInput = Schema.Struct({
  projectId: ProjectId,
  /** The increment folder name; anything that is not one is refused. */
  incrementId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  /** Also return the done and skipped tasks; without it only their count. */
  includeDone: Schema.optional(Schema.Boolean),
});
export type ProjectBoardIncrementInput = typeof ProjectBoardIncrementInput.Type;

export const ProjectBoardReport = Schema.Struct({
  /** Absolute path on the machine that answered. */
  path: Schema.String,
  name: Schema.String,
});
export type ProjectBoardReport = typeof ProjectBoardReport.Type;

export const ProjectBoardIncrement = Schema.Struct({
  card: ProjectBoardCard,
  /** The spec's Problem section as plain text, cut to a bounded length; null when it has none. */
  problem: Schema.NullOr(Schema.String),
  /** False when the spec names no tasks or its ledger could not be read. */
  readable: Schema.Boolean,
  /** Tasks that are not done or skipped, in spec order; all of them with `includeDone`. */
  tasks: Schema.Array(ThreadIncrementTask),
  /** How many tasks are done or skipped, whether or not they were returned. */
  doneTasks: Schema.Int,
  /** Every blocked task, in spec order. */
  blockers: Schema.Array(ProjectBoardBlocker),
  criteria: Schema.Array(ThreadIncrementCriterion),
  /** The last `specweave verify` run. */
  verify: Schema.NullOr(Schema.Struct({ ok: Schema.Boolean, ranAt: Schema.String })),
  review: Schema.NullOr(ThreadIncrementReview),
  /** The increment was abandoned, cancelled or superseded: it is off the board. */
  abandoned: Schema.Boolean,
  abandonedReason: Schema.NullOr(Schema.String),
  /** When a completed or abandoned increment was closed, as an ISO time. */
  closedAt: Schema.NullOr(Schema.String),
  /** Files of its `reports/` folder, newest first. */
  reports: Schema.Array(ProjectBoardReport).check(Schema.isMaxLength(PROJECT_BOARD_REPORTS)),
});
export type ProjectBoardIncrement = typeof ProjectBoardIncrement.Type;

export const ProjectBoardIncrementResult = Schema.Struct({
  projectId: ProjectId,
  incrementId: TrimmedNonEmptyString,
  /** Null when the folder is no longer on disk. */
  increment: Schema.NullOr(ProjectBoardIncrement),
});
export type ProjectBoardIncrementResult = typeof ProjectBoardIncrementResult.Type;
