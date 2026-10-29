import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Known token subtotals. Input includes cache reads/writes; output includes reasoning. */
export const ProjectUsageTotals = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
  /** Null when any recorded turn lacks this category. Never treat null as zero. */
  cachedInputTokens: Schema.NullOr(NonNegativeInt),
  cacheCreationTokens: Schema.NullOr(NonNegativeInt),
  reasoningTokens: Schema.NullOr(NonNegativeInt),
  /** Known API-equivalent estimate subtotal, not subscription spend. Null if none are priced. */
  equivalentCostUsd: Schema.NullOr(Schema.Number),
});
export type ProjectUsageTotals = typeof ProjectUsageTotals.Type;

export const ProjectUsageCoverage = Schema.Struct({
  threads: NonNegativeInt,
  threadsWithUsage: NonNegativeInt,
  missingThreads: NonNegativeInt,
  completeTurns: NonNegativeInt,
  partialTurns: NonNegativeInt,
  missingTurns: NonNegativeInt,
  /** Turns that report additional subagents; their unreported usage is excluded. */
  subagentTurns: NonNegativeInt,
  cacheMissingTurns: NonNegativeInt,
  costEstimatedTurns: NonNegativeInt,
  costUnknownTurns: NonNegativeInt,
});
export type ProjectUsageCoverage = typeof ProjectUsageCoverage.Type;

/** One provider instance and model's share of a single thread. */
export const ProjectUsageThreadModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(TrimmedNonEmptyString),
  totals: ProjectUsageTotals,
});
export type ProjectUsageThreadModel = typeof ProjectUsageThreadModel.Type;

/** Tokens of one local calendar day (`YYYY-MM-DD` on the reading host). */
export const ProjectUsageDay = Schema.Struct({
  day: Schema.String,
  role: Schema.Literals(["coordinator", "worker"]),
  provider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(TrimmedNonEmptyString),
  totalTokens: NonNegativeInt,
});
export type ProjectUsageDay = typeof ProjectUsageDay.Type;

export const ProjectFolderUsageDay = Schema.Struct({
  day: Schema.String,
  provider: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  totalTokens: NonNegativeInt,
});
export type ProjectFolderUsageDay = typeof ProjectFolderUsageDay.Type;

export const ProjectUsageThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  role: Schema.Literals(["coordinator", "worker"]),
  archived: Schema.Boolean,
  totals: ProjectUsageTotals,
  /** Share of the measured project token subtotal, 0..1; null with no measured total. */
  share: Schema.NullOr(Schema.Number),
  /** Per provider instance and model, so filters can split a thread. */
  models: Schema.optional(Schema.Array(ProjectUsageThreadModel)),
});
export type ProjectUsageThread = typeof ProjectUsageThread.Type;

export const ProjectUsageModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  /** The model saved on the originating run, never inferred from a later thread preference. */
  model: Schema.NullOr(TrimmedNonEmptyString),
  modelAttribution: Schema.Literals(["run_selection", "unknown"]),
  totals: ProjectUsageTotals,
});
export type ProjectUsageModel = typeof ProjectUsageModel.Type;

/** One provider's native CLI sessions that ran inside the project folder. */
export const ProjectFolderUsageProvider = Schema.Struct({
  /** Native CLI: claude, codex, grok or copilot. */
  provider: TrimmedNonEmptyString,
  sessions: NonNegativeInt,
  totals: ProjectUsageTotals,
  /** Newest usage record seen, ISO time; null when none. */
  lastActiveAt: Schema.NullOr(Schema.String),
});
export type ProjectFolderUsageProvider = typeof ProjectFolderUsageProvider.Type;

export const ProjectFolderUsageModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  totals: ProjectUsageTotals,
});
export type ProjectFolderUsageModel = typeof ProjectFolderUsageModel.Type;

/**
 * Usage of CLI sessions run directly in the project's folders on this host
 * (Claude Code, Codex, Grok and Copilot logs), outside Studio threads.
 * Sessions a Studio thread owns are excluded, so nothing counts twice.
 */
export const ProjectFolderUsage = Schema.Struct({
  /** Host the logs were read on. */
  hostLabel: TrimmedNonEmptyString,
  /** Logs older than this many days are not read. */
  windowDays: NonNegativeInt,
  roots: Schema.Array(TrimmedNonEmptyString),
  sessions: NonNegativeInt,
  /** Folder sessions skipped because a Studio thread already records them. */
  studioOwnedSessions: NonNegativeInt,
  totals: ProjectUsageTotals,
  providers: Schema.Array(ProjectFolderUsageProvider),
  models: Schema.Array(ProjectFolderUsageModel),
  /** Tokens per local day, provider and model, for the trend. */
  daily: Schema.optional(Schema.Array(ProjectFolderUsageDay)),
});
export type ProjectFolderUsage = typeof ProjectFolderUsage.Type;

export const ProjectUsageReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectUsageReadInput = typeof ProjectUsageReadInput.Type;

export const ProjectUsageSummary = Schema.Struct({
  projectId: ProjectId,
  readAt: Schema.String,
  source: Schema.Literal("persisted_provider_turns"),
  scope: Schema.Literal("recorded_main_agents"),
  coordinatorThreadId: Schema.NullOr(ThreadId),
  totals: ProjectUsageTotals,
  threads: Schema.Array(ProjectUsageThread),
  models: Schema.Array(ProjectUsageModel),
  coverage: ProjectUsageCoverage,
  /** Input-weighted measured cache reads; null if any turn's input/read count is incomplete. */
  cacheReadRatio: Schema.optional(Schema.NullOr(Schema.Number)),
  /** CLI sessions in the project folders; null when the logs could not be read. */
  folderSessions: Schema.optional(Schema.NullOr(ProjectFolderUsage)),
  /** Thread turns per local day of completion (start when unfinished); undated turns are left out. */
  daily: Schema.optional(Schema.Array(ProjectUsageDay)),
});
export type ProjectUsageSummary = typeof ProjectUsageSummary.Type;

export class ProjectUsageReadError extends Schema.TaggedError<ProjectUsageReadError>()(
  "ProjectUsageReadError",
  {
    projectId: ProjectId,
    reason: Schema.Literals(["project_not_found", "read_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "project_not_found"
      ? "Project was not found."
      : "Project usage could not be read.";
  }
}
