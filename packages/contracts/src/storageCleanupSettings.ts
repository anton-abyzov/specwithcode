import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Days a stored item is kept, or null to keep it forever. */
export const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);

/**
 * Scratch folders hold Scratch chat threads' folders as well as agents' probes,
 * so a week is the shortest retention: below it, a folder an agent is still
 * using could go (see `SCRATCH_PRUNE_MIN_AGE_MS` in the server).
 */
export const ScratchRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 3650 })),
);

/** Size of the app's home folder, in decimal gigabytes, past which the app warns. */
export const HomeSizeWarningGb = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
);
export const DEFAULT_HOME_SIZE_WARNING_GB = 50;

export const StorageCleanupSettings = Schema.Struct({
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Rotated logs are swept after two weeks by default: they are the one store
   * that grows on its own, and a full disk stalls the whole app. An explicit
   * null still keeps them forever.
   */
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(14))),
  /**
   * Folders in `<identity>/scratch` that nothing uses and nothing changed in
   * for this many days are deleted. Agents leave probes and run logs there and
   * nothing else ever removed them (10 GB on one Mac). Off (null) until the
   * user turns it on: the folder also holds Scratch chats' own folders, which
   * nothing can recreate, and removal copies nothing, so an upgrade never
   * starts deleting them on its own.
   */
  scratchAfterDays: ScratchRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * Warn when the app's home folder passes this many gigabytes. Null turns the
   * warning off; the size is still measured and shown in Storage settings.
   */
  homeSizeWarningGb: HomeSizeWarningGb.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HOME_SIZE_WARNING_GB)),
  ),
  /** Purge deleted threads' history this many days after deletion. Off (null) by default. */
  deletedThreadHistoryAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Drop archived threads' event log (their messages stay) after this many days. Off by default. */
  archivedThreadHistoryAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

export const StorageCleanupSettingsPatch = Schema.Struct({
  worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
  worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
  worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
  worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
  browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
  logsAfterDays: Schema.optionalKey(StorageRetentionDays),
  scratchAfterDays: Schema.optionalKey(ScratchRetentionDays),
  homeSizeWarningGb: Schema.optionalKey(HomeSizeWarningGb),
  deletedThreadHistoryAfterDays: Schema.optionalKey(StorageRetentionDays),
  archivedThreadHistoryAfterDays: Schema.optionalKey(StorageRetentionDays),
});
