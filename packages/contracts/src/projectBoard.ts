import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const ProjectBoardCard = Schema.Struct({
  incrementId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  /** `metadata.json` status, lower case; `unknown` when it has none. */
  status: Schema.String,
  column: ProjectBoardColumn,
  /** Tasks in the spec and how many are done or skipped; zeros when it names none. */
  tasks: Schema.Struct({ total: Schema.Int, done: Schema.Int }),
  /** A task is blocked, or the increment is paused. */
  blocked: Schema.Boolean,
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
});
export type ProjectBoardResult = typeof ProjectBoardResult.Type;
