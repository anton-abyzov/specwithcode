import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * One answer to "which skills will each agent load in this project folder,
 * and is each the version I think". Rows join the providers' own skill
 * discovery with vskill's lockfiles; everything is read locally.
 */
export const ProjectSkillsReadInput = Schema.Struct({
  projectId: ProjectId,
  /** Re-read lockfiles and file contents instead of a recent cached answer. */
  refresh: Schema.optional(Schema.Boolean),
});
export type ProjectSkillsReadInput = typeof ProjectSkillsReadInput.Type;

/**
 * `drift`: the SKILL.md on disk no longer hashes to the locked sha.
 * `duplicate`: agents load different contents under this name.
 * `missing`: a lockfile lists the skill but no agent loads it (see
 * `ProjectSkillRow.staleLock` for entries with nothing on disk).
 * `disabled`: every agent that sees it has it switched off.
 */
export const ProjectSkillStatus = Schema.Literals([
  "ok",
  "drift",
  "duplicate",
  "missing",
  "disabled",
]);
export type ProjectSkillStatus = typeof ProjectSkillStatus.Type;

/**
 * `match` and `drift` compare the on-disk SKILL.md with the locked sha.
 * `unknown`: the lock has no usable sha, or its sha covers several files.
 * `unlocked`: no vskill lockfile lists the skill.
 */
export const ProjectSkillDrift = Schema.Literals(["match", "drift", "unknown", "unlocked"]);
export type ProjectSkillDrift = typeof ProjectSkillDrift.Type;

export const ProjectSkillPresence = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: TrimmedNonEmptyString,
  /** The SKILL.md this provider would load. */
  path: TrimmedNonEmptyString,
  scope: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /** The name this provider lists the skill under, when it differs from the row's. */
  name: Schema.optional(TrimmedNonEmptyString),
  /**
   * False when the provider keeps the skill out of its slash commands
   * (`user-invocable: false`); the agent can still load it, so it is not off.
   */
  userInvocable: Schema.optional(Schema.Boolean),
  /** `version` from this copy's SKILL.md frontmatter. */
  fileVersion: Schema.optional(Schema.NullOr(Schema.String)),
  /** For a plugin skill, the version in the plugin's manifest (`plugin.json`). */
  pluginVersion: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ProjectSkillPresence = typeof ProjectSkillPresence.Type;

export const ProjectSkillLock = Schema.Struct({
  lockPath: TrimmedNonEmptyString,
  lockScope: Schema.Literals(["project", "user"]),
  version: Schema.NullOr(Schema.String),
  tier: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  installedAt: Schema.NullOr(Schema.String),
});
export type ProjectSkillLock = typeof ProjectSkillLock.Type;

export const ProjectSkillRow = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Other names providers list the same SKILL.md under, such as `do` for `sw:do`. */
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  description: Schema.optional(TrimmedNonEmptyString),
  status: ProjectSkillStatus,
  /** True when the row has any problem, including ones only `vskill doctor` reports. */
  attention: Schema.Boolean,
  /** Plain-language reasons behind the status, most important first. */
  issues: Schema.Array(Schema.String),
  /** The SKILL.md most agents load, for copying; null when nothing loads it. */
  path: Schema.NullOr(TrimmedNonEmptyString),
  scopes: Schema.Array(TrimmedNonEmptyString),
  providers: Schema.Array(ProjectSkillPresence),
  lock: Schema.NullOr(ProjectSkillLock),
  drift: ProjectSkillDrift,
  /** Distinct files (after resolving links) the providers load. */
  copies: NonNegativeInt,
  /** Copies whose contents differ. */
  divergent: Schema.Boolean,
  /**
   * Findings `vskill doctor --json` reported for this skill about agents
   * or folders in this snapshot; findings about other agents are left out.
   */
  doctor: Schema.Array(Schema.String),
  /** A lock entry with nothing on disk: worth cleaning up, not a problem. */
  staleLock: Schema.optional(Schema.Boolean),
});
export type ProjectSkillRow = typeof ProjectSkillRow.Type;

export const ProjectSkillsProviderState = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: TrimmedNonEmptyString,
  /** `cached`: the last scan for this folder; a new one did not finish in time. */
  state: Schema.Literals(["ok", "cached", "timeout", "error", "unsupported"]),
  skills: NonNegativeInt,
  message: Schema.optional(Schema.String),
});
export type ProjectSkillsProviderState = typeof ProjectSkillsProviderState.Type;

export const ProjectSkillsLockSource = Schema.Struct({
  path: TrimmedNonEmptyString,
  scope: Schema.Literals(["project", "user"]),
  skills: NonNegativeInt,
});
export type ProjectSkillsLockSource = typeof ProjectSkillsLockSource.Type;

export const ProjectSkillsSnapshot = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  rows: Schema.Array(ProjectSkillRow),
  providers: Schema.Array(ProjectSkillsProviderState),
  locks: Schema.Array(ProjectSkillsLockSource),
  /** `unavailable`: the installed vskill has no `doctor --json`, so its columns are omitted. */
  doctor: Schema.Literals(["ok", "unavailable", "failed"]),
});
export type ProjectSkillsSnapshot = typeof ProjectSkillsSnapshot.Type;

export class ProjectSkillsReadError extends Schema.TaggedError<ProjectSkillsReadError>()(
  "ProjectSkillsReadError",
  {
    projectId: ProjectId,
    reason: Schema.Literals(["project_not_found", "read_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "project_not_found"
      ? "Project was not found."
      : "Project skills could not be read.";
  }
}

/** "41 skills, 3 need attention" */
export function summarizeProjectSkills(rows: ReadonlyArray<ProjectSkillRow>): string {
  const attention = rows.filter((row) => row.attention).length;
  const skills = `${rows.length} skill${rows.length === 1 ? "" : "s"}`;
  return attention === 0
    ? `${skills}, all ok`
    : `${skills}, ${attention} need${attention === 1 ? "s" : ""} attention`;
}
