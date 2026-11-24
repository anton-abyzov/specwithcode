/**
 * What one machine's measured usage delivered (1456): API-equivalent cost per
 * SpecWeave increment, with the tasks done, merges and closures in the range,
 * and the cost that belongs to no increment (coordinators, other threads and
 * sessions run outside SpecWithCode).
 *
 * Costs use the Cost tab's basis: transcript records mapped from native session
 * to thread, plus the turns SpecWithCode recorded for drivers without
 * transcripts, priced with the same table and overrides. The parts add up to
 * `measured`. A thread counts toward one increment, resolved as of now.
 *
 * @module usageDelivered
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageDay, UsageProviderKind, UsageReadError } from "./usage.ts";

/** Bumped when {@link UsageDeliveredReport} changes incompatibly. */
export const USAGE_DELIVERED_REPORT_VERSION = 1 as const;

/** Longest range one request may ask for; the same cap as the machine report. */
export const USAGE_DELIVERED_MAX_DAYS = 92 as const;

/** Other threads named by title, largest first; the rest are only summed. */
export const USAGE_DELIVERED_OTHER_THREADS_NAMED = 20 as const;

/** Threads listed per increment, largest first; the rest are only summed. */
export const USAGE_DELIVERED_THREADS_PER_INCREMENT = 12 as const;

/**
 * How a thread was tied to its increment, strongest first. `parent`: the thread
 * itself names none, its parent thread's increment is used (subagents and
 * delegated workers). `checkpoint` and `name` are shown as "matched by title".
 */
export const UsageDeliveredBinding = Schema.Literals([
  "manual",
  "claim",
  "branch",
  "checkpoint",
  "name",
  "parent",
]);
export type UsageDeliveredBinding = typeof UsageDeliveredBinding.Type;

/**
 * The provider of measured usage. `provider` is set for transcript providers;
 * `driver` names the driver for recorded turns (Copilot, ACP registry agents),
 * so registry agents stay filterable.
 */
export const UsageDeliveredCost = Schema.Struct({
  costUsd: Schema.Number,
  tokens: NonNegativeInt,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
});
export type UsageDeliveredCost = typeof UsageDeliveredCost.Type;

export const UsageDeliveredModelCost = Schema.Struct({
  ...UsageDeliveredCost.fields,
  /** Driver kind, such as `claudeAgent`, `codex`, `copilot` or an ACP driver. */
  driver: TrimmedNonEmptyString,
  /** Set when the records came from a transcript provider. */
  provider: Schema.NullOr(UsageProviderKind),
  model: TrimmedNonEmptyString,
});
export type UsageDeliveredModelCost = typeof UsageDeliveredModelCost.Type;

export const UsageDeliveredThread = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  /** Null for threads that belong to no increment. */
  binding: Schema.NullOr(UsageDeliveredBinding),
  cost: UsageDeliveredCost,
  byModel: Schema.Array(UsageDeliveredModelCost),
});
export type UsageDeliveredThread = typeof UsageDeliveredThread.Type;

/** Closed: metadata says so. Merged: a merge is recorded in the range. Else in progress. */
export const UsageDeliveredState = Schema.Literals(["closed", "merged", "in_progress"]);
export type UsageDeliveredState = typeof UsageDeliveredState.Type;

export const UsageDeliveredIncrement = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  /** Folder name, such as `1357-usage-by-machine`. */
  incrementId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  /** `metadata.json` status, lower case; `unknown` when it has none. */
  status: Schema.String,
  state: UsageDeliveredState,
  /** When it closed (metadata `updated`), if it is closed. */
  closedAt: Schema.NullOr(IsoDateTime),
  /** The newest merge recorded inside the range. */
  mergedAt: Schema.NullOr(IsoDateTime),
  /** Pull request numbers the ledger or its threads name. */
  pullRequests: Schema.Array(NonNegativeInt),
  /** Created before the range began, so earlier spend is not in `cost`. */
  createdAt: Schema.NullOr(IsoDateTime),
  tasks: Schema.Struct({
    total: NonNegativeInt,
    done: NonNegativeInt,
    doneInRange: NonNegativeInt,
  }),
  cost: UsageDeliveredCost,
  byModel: Schema.Array(UsageDeliveredModelCost),
  /** Largest first, at most {@link USAGE_DELIVERED_THREADS_PER_INCREMENT}. */
  threads: Schema.Array(UsageDeliveredThread),
  threadCount: NonNegativeInt,
});
export type UsageDeliveredIncrement = typeof UsageDeliveredIncrement.Type;

/** A cost that belongs to no increment. */
export const UsageDeliveredGroup = Schema.Struct({
  cost: UsageDeliveredCost,
  byModel: Schema.Array(UsageDeliveredModelCost),
  threadCount: NonNegativeInt,
  /** Largest first; empty for use outside the app. */
  threads: Schema.Array(UsageDeliveredThread),
});
export type UsageDeliveredGroup = typeof UsageDeliveredGroup.Type;

export const UsageDeliveredProject = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  title: Schema.String,
  /** Whether the project plans with SpecWeave on this machine. */
  specweave: Schema.Boolean,
});
export type UsageDeliveredProject = typeof UsageDeliveredProject.Type;

export const UsageDeliveredReportInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA zone days are bucketed in. */
  timeZone: TrimmedNonEmptyString,
});
export type UsageDeliveredReportInput = typeof UsageDeliveredReportInput.Type;

export const UsageDeliveredReport = Schema.Struct({
  version: Schema.Number,
  readAt: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  projects: Schema.Array(UsageDeliveredProject),
  increments: Schema.Array(UsageDeliveredIncrement),
  coordinators: UsageDeliveredGroup,
  /** App threads tied to no increment. */
  otherThreads: UsageDeliveredGroup,
  /** Sessions on this machine that no thread owns. */
  outsideApp: UsageDeliveredGroup,
  /** Everything measured on this machine in the range; the parts above add up to it. */
  measured: UsageDeliveredCost,
  /** Source fingerprints already counted, so a shared home is not counted twice across machines. */
  sourceKeys: Schema.Array(Schema.String),
});
export type UsageDeliveredReport = typeof UsageDeliveredReport.Type;

export const USAGE_DELIVERED_RPC_METHODS = {
  usageDeliveredReport: "usage.deliveredReport",
} as const;

export const usageDeliveredRpcs = [
  Rpc.make(USAGE_DELIVERED_RPC_METHODS.usageDeliveredReport, {
    payload: UsageDeliveredReportInput,
    success: UsageDeliveredReport,
    error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
  }),
] as const;
