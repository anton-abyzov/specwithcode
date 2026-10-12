import * as Schema from "effect/Schema";

/**
 * Studio Mods: small workbench customizations a user drops into
 * `<stateDir>/mods/<name>/` on a Studio host. Every client of that host sees
 * the same set. A mod runs only after the user approves its exact contents
 * (pinned by hash) and its declared permissions.
 */

/** What a mod may ask the host for, beyond drawing its own UI and commands. */
export const MOD_PERMISSIONS = ["threads:read", "threads:open", "specweave:read"] as const;
export const ModPermission = Schema.Literals(MOD_PERMISSIONS);
export type ModPermission = typeof ModPermission.Type;

export const MOD_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const ModName = Schema.String.check(Schema.isPattern(MOD_NAME_PATTERN));

/** A single module file next to `mod.json`; mods in v1 are one file. */
export const MOD_MAIN_PATTERN = /^(?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*\.m?js$/u;

/** `<stateDir>/mods/<name>/mod.json` */
export const ModManifest = Schema.Struct({
  name: ModName,
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  main: Schema.String.check(Schema.isPattern(MOD_MAIN_PATTERN)),
  permissions: Schema.optionalKey(Schema.Array(ModPermission)),
});
export type ModManifest = typeof ModManifest.Type;

/**
 * - `pending`: never approved on this host.
 * - `approved`: approved at exactly these contents; the only status that runs.
 * - `changed`: approved once, but the files changed since; paused until approved again.
 * - `disabled`: turned off by the user.
 * - `invalid`: the folder cannot be loaded; `problems` says why.
 */
export const ModStatus = Schema.Literals(["pending", "approved", "changed", "disabled", "invalid"]);
export type ModStatus = typeof ModStatus.Type;

export const ModEntry = Schema.Struct({
  /** The folder name; equals the manifest name for a valid mod. */
  name: Schema.String,
  status: ModStatus,
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  permissions: Schema.Array(ModPermission),
  /** Hash of the manifest and module bytes, which an approval pins. */
  sha256: Schema.optionalKey(Schema.String),
  problems: Schema.Array(Schema.String),
  /** The module source, sent only for an approved mod. */
  source: Schema.optionalKey(Schema.String),
});
export type ModEntry = typeof ModEntry.Type;

export const ModsListResult = Schema.Struct({
  modsDir: Schema.String,
  mods: Schema.Array(ModEntry),
});
export type ModsListResult = typeof ModsListResult.Type;

export const ModsApproveInput = Schema.Struct({
  name: ModName,
  /** The hash the user saw; a mod changed since is not approved. */
  sha256: Schema.String,
});
export type ModsApproveInput = typeof ModsApproveInput.Type;

export const ModsDisableInput = Schema.Struct({ name: ModName });
export type ModsDisableInput = typeof ModsDisableInput.Type;

const ModText = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));

/** A task of a SpecWeave increment as a mod with `specweave:read` sees it. */
export const ModSpecweaveTask = Schema.Struct({
  id: ModText(40),
  title: ModText(200),
  status: Schema.Literals([
    "planned",
    "claimed",
    "stale",
    "done",
    "released",
    "skipped",
    "blocked",
  ]),
  /** AC ids the task's line cites. */
  criteria: Schema.Array(ModText(48)).check(Schema.isMaxLength(16)),
  /** When the ledger last changed this task. */
  changedAt: Schema.NullOr(Schema.String),
  /** The block or skip reason, bounded; null otherwise. */
  note: Schema.NullOr(ModText(200)),
});
export type ModSpecweaveTask = typeof ModSpecweaveTask.Type;

/**
 * One SpecWeave increment, read-only. Never paths, spec prose, ledger owners,
 * evidence or the commands a task or verify ran.
 */
export const ModSpecweaveIncrement = Schema.Struct({
  /** The Studio project's title. */
  project: ModText(80),
  id: ModText(160),
  title: Schema.NullOr(ModText(120)),
  /** `metadata.json` status, such as active, planned or completed. */
  status: ModText(32),
  updatedAt: Schema.NullOr(Schema.String),
  /** False when spec.md is missing or names no tasks. */
  readable: Schema.Boolean,
  criteria: Schema.Array(Schema.Struct({ id: ModText(48), text: ModText(300) })).check(
    Schema.isMaxLength(64),
  ),
  tasks: Schema.Array(ModSpecweaveTask).check(Schema.isMaxLength(200)),
  malformedLedgerLines: Schema.Number,
  /** The last `specweave verify` run, from reports/verify.json. */
  verify: Schema.NullOr(Schema.Struct({ ok: Schema.Boolean, ranAt: Schema.String })),
});
export type ModSpecweaveIncrement = typeof ModSpecweaveIncrement.Type;

/** Open increments of this host's projects, plus those closed in the last seven days. */
export const ModSpecweaveResult = Schema.Struct({
  increments: Schema.Array(ModSpecweaveIncrement).check(Schema.isMaxLength(60)),
  /** More increments existed than the summary holds. */
  truncated: Schema.Boolean,
});
export type ModSpecweaveResult = typeof ModSpecweaveResult.Type;

export class ModsError extends Schema.TaggedError<ModsError>()("ModsError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
