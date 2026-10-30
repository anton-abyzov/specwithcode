import * as Schema from "effect/Schema";

/** Where this machine creates future worktrees; existing checkouts never move. */
export const WorktreeLocationMode = Schema.Literals(["managed", "project", "custom"]);
export type WorktreeLocationMode = typeof WorktreeLocationMode.Type;

/** null disables archiving. This never controls checkout deletion. */
export const ArchiveInactiveThreadsAfterDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export type ArchiveInactiveThreadsAfterDays = typeof ArchiveInactiveThreadsAfterDays.Type;

/** Live threads a project keeps before the oldest finished ones are archived; null is no limit. */
export const KeepActiveThreadsPerProject = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 20, maximum: 5000 })),
);
export type KeepActiveThreadsPerProject = typeof KeepActiveThreadsPerProject.Type;
export const DEFAULT_KEEP_ACTIVE_THREADS_PER_PROJECT = 200;

export function resolveWorktreeLocationMode(settings: {
  readonly worktreeLocationMode?: WorktreeLocationMode | undefined;
  readonly worktreesDirectory: string;
}): WorktreeLocationMode {
  return (
    settings.worktreeLocationMode ?? (settings.worktreesDirectory.trim() ? "custom" : "managed")
  );
}
