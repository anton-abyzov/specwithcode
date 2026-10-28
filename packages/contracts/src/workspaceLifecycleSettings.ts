import * as Schema from "effect/Schema";

/** Where this machine creates future worktrees; existing checkouts never move. */
export const WorktreeLocationMode = Schema.Literals(["managed", "project", "custom"]);
export type WorktreeLocationMode = typeof WorktreeLocationMode.Type;

/** null disables archiving. This never controls checkout deletion. */
export const ArchiveInactiveThreadsAfterDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
export type ArchiveInactiveThreadsAfterDays = typeof ArchiveInactiveThreadsAfterDays.Type;

export function resolveWorktreeLocationMode(settings: {
  readonly worktreeLocationMode?: WorktreeLocationMode | undefined;
  readonly worktreesDirectory: string;
}): WorktreeLocationMode {
  return (
    settings.worktreeLocationMode ?? (settings.worktreesDirectory.trim() ? "custom" : "managed")
  );
}
