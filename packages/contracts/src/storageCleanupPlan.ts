import * as Schema from "effect/Schema";

/**
 * What the storage cleanup would do with one folder right now, and why.
 * Settings > Storage shows this list before anything is removed; the sweep
 * itself decides with the same code, so the two never disagree.
 */
export const StorageCleanupItemKind = Schema.Literals([
  /** A chat's worktree folder (one repository, or a folder holding several). */
  "worktree",
  /** `tmp_pack_*` and `tmp_obj_*` files a stopped Git download left in an app-owned copy. */
  "interrupted-downloads",
]);
export type StorageCleanupItemKind = typeof StorageCleanupItemKind.Type;

/** Why a folder would be removed. */
export const StorageCleanupRemoveReason = Schema.Literals([
  /** Its pull request merged and the folder holds nothing else. */
  "merged",
  /** Its pull request closed and every commit is on the remote. */
  "closed",
  /** Its chats are resolved or archived and everything is committed and pushed. */
  "resolved",
  /** Its chat was deleted. */
  "deleted",
  /** Its chats are resolved or archived and nothing happened for the configured days. */
  "inactive",
  /** Its chats are resolved or archived and the branch has no commits of its own. */
  "unchanged",
  /** Leftover files of a stopped download; no work is in them. */
  "interrupted-downloads",
]);
export type StorageCleanupRemoveReason = typeof StorageCleanupRemoveReason.Type;

/** Why a folder stays. The first reason found; a folder can have more. */
export const StorageCleanupKeepReason = Schema.Literals([
  /** A chat using it is running, queued or waiting for an answer. */
  "running",
  /** A chat using it is still open and its work is not merged or closed. */
  "open",
  /** Its work finished too recently; it goes after the quiet period. */
  "recent",
  /** Files changed and not committed. */
  "changes",
  /** New files Git does not track. */
  "untracked",
  /** Commits that are on no remote. */
  "unpushed",
  /** A stash entry made on its branch. */
  "stash",
  /** Ignored files that cannot be rebuilt and are not media (they may be secrets or data). */
  "ignored-files",
  /** More ignored media than is copied to evidence automatically. */
  "media",
  /** A terminal, an agent session or a process works in it. */
  "in-use",
  /** Its Git registration is missing or points at another folder; nothing in it is trusted. */
  "broken-registration",
  /** Another repository or hidden tracked changes sit inside it. */
  "nested-work",
  /** No cleanup rule that is switched on covers it. */
  "no-rule",
  /** It could not be checked (Git, the host or the file system gave no answer). */
  "unknown",
]);
export type StorageCleanupKeepReason = typeof StorageCleanupKeepReason.Type;

export const StorageCleanupPlanItem = Schema.Struct({
  kind: StorageCleanupItemKind,
  /** The folder, absolute. */
  path: Schema.String,
  action: Schema.Literals(["remove", "keep"]),
  reason: Schema.Union([StorageCleanupRemoveReason, StorageCleanupKeepReason]),
  /** One short fact behind the reason: a file name, a branch, a chat title. Never a secret. */
  detail: Schema.NullOr(Schema.String),
  /**
   * Bytes on disk outside dependency installs, or null when it was not
   * measured. Dependency installs are left out: a package manager shares their
   * files with its store, so removing them returns far less than their size.
   */
  bytes: Schema.NullOr(Schema.Number),
  /** The chat that owns the folder, when one does. */
  threadId: Schema.NullOr(Schema.String),
  threadTitle: Schema.NullOr(Schema.String),
  /** How many chats record the folder, sub-chats included. */
  threadCount: Schema.Number,
});
export type StorageCleanupPlanItem = typeof StorageCleanupPlanItem.Type;

export const StorageCleanupPlan = Schema.Struct({
  checkedAt: Schema.String,
  items: Schema.Array(StorageCleanupPlanItem),
  /** Sum of `bytes` over the items that would be removed; a lower bound. */
  removableBytes: Schema.Number,
  /** False when a list was cut short or a size is missing, so the totals are lower bounds. */
  complete: Schema.Boolean,
  /**
   * Why the check could not run, in a sentence a person reads; absent when it
   * ran (or null). With it, an empty list means "unknown", never "nothing to remove".
   */
  failed: Schema.optional(Schema.NullOr(Schema.String)),
});
export type StorageCleanupPlan = typeof StorageCleanupPlan.Type;

/** What one "Clean up now" run did. */
export const StorageCleanupRunResult = Schema.Struct({
  /** Folders and leftover files removed, absolute paths. */
  removed: Schema.Array(Schema.String),
  /** Bytes the removed items held outside dependency installs; a lower bound. */
  removedBytes: Schema.Number,
  /** The plan as it stands after the run. */
  plan: StorageCleanupPlan,
});
export type StorageCleanupRunResult = typeof StorageCleanupRunResult.Type;
