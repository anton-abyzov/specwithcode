import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  StudioFleetMachineId,
  StudioFleetSkillName,
  StudioFleetUpdateVersion,
} from "./studioFleet.ts";

/**
 * One answer to "which skills will each agent load in this project folder,
 * and is each the version I think". Rows join the providers' own skill
 * discovery with vskill's lockfiles; everything is read locally.
 */
export const ProjectSkillsReadInput = Schema.Struct({
  projectId: ProjectId,
  /** Re-read lockfiles and file contents instead of a recent cached answer. */
  refresh: Schema.optional(Schema.Boolean),
  /**
   * The folder to read, such as a thread's worktree. Left out, the project's
   * workspace root. Only the root and the project's own thread worktrees are
   * accepted; any other path is refused with `cwd_not_allowed`.
   */
  cwd: Schema.optional(TrimmedNonEmptyString),
  /**
   * The thread whose folder `cwd` is. With it, only that thread's worktree is
   * looked up instead of every thread of the project.
   */
  threadId: Schema.optional(ThreadId),
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
  /** The key vskill files the entry under, the name `vskill pin` and `unpin` take. */
  name: Schema.optional(Schema.NullOr(Schema.String)),
  pinnedVersion: Schema.optional(Schema.NullOr(Schema.String)),
  sourceRepoUrl: Schema.optional(Schema.NullOr(Schema.String)),
  sourceSkillPath: Schema.optional(Schema.NullOr(Schema.String)),
  sourceBranch: Schema.optional(Schema.NullOr(Schema.String)),
  sourceCommitSha: Schema.optional(Schema.NullOr(Schema.String)),
  /** `owner/repo/name` on the registry, when the source names a GitHub repository. */
  skillId: Schema.optional(Schema.NullOr(Schema.String)),
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
    reason: Schema.Literals(["project_not_found", "read_failed", "cwd_not_allowed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "project_not_found"
      ? "Project was not found."
      : this.reason === "cwd_not_allowed"
        ? "That folder is not this project's folder or one of its thread worktrees."
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

// ---------------------------------------------------------------------------
// Skills control center: versions, switches, fleet push and the Studio link
// ---------------------------------------------------------------------------

/**
 * A skill, plugin or lock name as one argv element: letters, digits and
 * `._:@/-`, starting with a letter or digit, so it can never read as a flag.
 */
export const ProjectSkillName = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/),
);

const projectSkillTarget = {
  projectId: ProjectId,
  /** As in {@link ProjectSkillsReadInput}: the root or one of the project's thread worktrees. */
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  /** The row's name in the Skills view. */
  skill: ProjectSkillName,
};

export const ProjectSkillsVersionsInput = Schema.Struct(projectSkillTarget);
export type ProjectSkillsVersionsInput = typeof ProjectSkillsVersionsInput.Type;

export const ProjectSkillVersion = Schema.Struct({
  version: Schema.String,
  certTier: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  installed: Schema.Boolean,
});
export type ProjectSkillVersion = typeof ProjectSkillVersion.Type;

/** `vskill outdated --json` for this skill; null when it could not be read. */
export const ProjectSkillOutdated = Schema.Struct({
  latest: Schema.NullOr(Schema.String),
  updateAvailable: Schema.Boolean,
  pinned: Schema.Boolean,
  pinnedVersion: Schema.NullOr(Schema.String),
});
export type ProjectSkillOutdated = typeof ProjectSkillOutdated.Type;

export const ProjectSkillsVersions = Schema.Struct({
  skill: Schema.String,
  skillId: Schema.String,
  lockScope: Schema.Literals(["project", "user"]),
  /** Read from the lock, not from vskill's output. */
  installedVersion: Schema.NullOr(Schema.String),
  pinnedVersion: Schema.NullOr(Schema.String),
  /** Newest first. */
  versions: Schema.Array(ProjectSkillVersion),
  outdated: Schema.NullOr(ProjectSkillOutdated),
});
export type ProjectSkillsVersions = typeof ProjectSkillsVersions.Type;

/**
 * One change from the control center. Version kinds run vskill; toggles
 * switch a skill or a whole plugin for one agent.
 */
export const ProjectSkillsAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("install-version"),
    version: StudioFleetUpdateVersion,
    /** False: drop the pin vskill's install sets, so the skill ends up unpinned. Default true. */
    pin: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("pin"), version: StudioFleetUpdateVersion }),
  Schema.Struct({ kind: Schema.Literal("unpin") }),
  Schema.Struct({ kind: Schema.Literal("update-latest") }),
  Schema.Struct({
    kind: Schema.Literal("toggle-skill"),
    provider: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    enabled: Schema.Boolean,
    /** Claude: `~/.claude/settings.json` or the repository's `.claude/settings.local.json`. */
    scope: Schema.Literals(["user", "local"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("toggle-plugin"),
    provider: ProviderDriverKind,
    instanceId: ProviderInstanceId,
    /** Claude `plugin@marketplace`, Codex plugin id, Grok plugin name. */
    pluginId: ProjectSkillName,
    enabled: Schema.Boolean,
    scope: Schema.Literals(["user", "project", "local"]),
  }),
]);
export type ProjectSkillsAction = typeof ProjectSkillsAction.Type;
export type ProjectSkillsActionKind = ProjectSkillsAction["kind"];

/** What the preview saw, sent back with the apply so a change made in between is refused. */
export const ProjectSkillsActionExpected = Schema.Struct({
  /** sha256 of the vskill.lock text. */
  lockSha: Schema.optional(Schema.String),
  /** Exact registry version shown by the preview. Required when applying update-latest. */
  targetVersion: Schema.optional(StudioFleetUpdateVersion),
  /** sha256 of the settings file text, or `absent`. */
  fileHash: Schema.optional(Schema.String),
  /** Codex's version of the user config layer. */
  configVersion: Schema.optional(Schema.String),
});
export type ProjectSkillsActionExpected = typeof ProjectSkillsActionExpected.Type;

export const ProjectSkillsActionInput = Schema.Struct({
  ...projectSkillTarget,
  /** True: say what would change and write nothing. */
  preview: Schema.Boolean,
  expected: Schema.optional(ProjectSkillsActionExpected),
  action: ProjectSkillsAction,
});
export type ProjectSkillsActionInput = typeof ProjectSkillsActionInput.Type;

/** When the agent sees the change: now, its next session, or after `/plugins reload`. */
export const ProjectSkillsLiveness = Schema.Literals(["now", "next-session", "reload"]);
export type ProjectSkillsLiveness = typeof ProjectSkillsLiveness.Type;

export const ProjectSkillsActionPreview = Schema.Struct({
  /** The fixed command line, for kinds that run one. */
  argv: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.Array(Schema.String),
  summary: Schema.String,
  liveness: ProjectSkillsLiveness,
  warnings: Schema.optional(Schema.Array(Schema.String)),
  expected: ProjectSkillsActionExpected,
});
export type ProjectSkillsActionPreview = typeof ProjectSkillsActionPreview.Type;

export const ProjectSkillsActionApplied = Schema.Struct({
  applied: Schema.Literal(true),
  summary: Schema.String,
  liveness: ProjectSkillsLiveness,
  /** For toggles: whether the agent now loads it, read back after the write. */
  effectiveEnabled: Schema.optional(Schema.Boolean),
  /** For version kinds: read back from the lock. */
  installedVersion: Schema.optional(Schema.NullOr(Schema.String)),
  pinnedVersion: Schema.optional(Schema.NullOr(Schema.String)),
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type ProjectSkillsActionApplied = typeof ProjectSkillsActionApplied.Type;

export const ProjectSkillsActionResult = Schema.Union([
  Schema.Struct({ preview: ProjectSkillsActionPreview }),
  ProjectSkillsActionApplied,
]);
export type ProjectSkillsActionResult = typeof ProjectSkillsActionResult.Type;

export const ProjectSkillsFleetTarget = Schema.Union([
  Schema.Struct({ machineId: StudioFleetMachineId, scope: Schema.Literal("user") }),
  /** `projectId` is the project's id on the target machine. */
  Schema.Struct({
    machineId: StudioFleetMachineId,
    scope: Schema.Literal("project"),
    projectId: ProjectId.check(Schema.isMaxLength(128)),
  }),
]);
export type ProjectSkillsFleetTarget = typeof ProjectSkillsFleetTarget.Type;

export const ProjectSkillsFleetPushInput = Schema.Struct({
  projectId: ProjectId,
  skillId: StudioFleetSkillName,
  version: StudioFleetUpdateVersion,
  pin: Schema.Boolean,
  targets: Schema.Array(ProjectSkillsFleetTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
});
export type ProjectSkillsFleetPushInput = typeof ProjectSkillsFleetPushInput.Type;

export const ProjectSkillsFleetPushResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      machineId: Schema.String,
      label: Schema.optional(Schema.String),
      ok: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      installedVersion: Schema.optional(Schema.NullOr(Schema.String)),
      pinnedVersion: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type ProjectSkillsFleetPushResult = typeof ProjectSkillsFleetPushResult.Type;

export const ProjectSkillsStudioLinkInput = Schema.Struct({
  projectId: ProjectId,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  /** Skill Studio's source: the project's skills, the user's, or a plugin's. */
  source: Schema.Literals(["project", "personal", "plugin"]),
  /**
   * Studio's group for the skill: the plugin, or the agent folder a skills
   * folder sits in, such as `.claude`. Only a URL segment, never an argv
   * element, so one leading dot is allowed.
   */
  plugin: Schema.String.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,198}$/),
  ),
  skill: ProjectSkillName,
});
export type ProjectSkillsStudioLinkInput = typeof ProjectSkillsStudioLinkInput.Type;

export const ProjectSkillsStudioLink = Schema.Struct({
  url: Schema.String,
  /** True when no Studio was running and this request started one. */
  started: Schema.Boolean,
});
export type ProjectSkillsStudioLink = typeof ProjectSkillsStudioLink.Type;

export const ProjectSkillsActionErrorReason = Schema.Literals([
  "project_not_found",
  "read_failed",
  "cwd_not_allowed",
  "skill_not_found",
  "not_registry_skill",
  "version_invalid",
  "version_not_found",
  "stale",
  "managed_override",
  "overrides_invalid",
  "scope_unsupported",
  "agent_unavailable",
  "cli_failed",
  "overridden",
  "fleet_unconfigured",
  "machine_unknown",
  "studio_unavailable",
]);
export type ProjectSkillsActionErrorReason = typeof ProjectSkillsActionErrorReason.Type;

const ACTION_ERROR_MESSAGES: Readonly<Record<ProjectSkillsActionErrorReason, string>> = {
  project_not_found: "Project was not found.",
  read_failed: "Project skills could not be read.",
  cwd_not_allowed: "That folder is not this project's folder or one of its thread worktrees.",
  skill_not_found: "That skill or agent is not in this folder's skills.",
  not_registry_skill: "This skill is local; it has no registry versions.",
  version_invalid: "Name the version as X.Y.Z.",
  version_not_found: "The registry lists no such version of this skill.",
  stale: "The file changed since the preview. Review the change again.",
  managed_override: "Managed settings decide this skill on this machine.",
  overrides_invalid:
    "skillOverrides in that settings file is already invalid, so Claude ignores it. Fix the file first.",
  scope_unsupported: "That change is not available for this agent or lock.",
  agent_unavailable: "The agent's CLI or app server is not available.",
  cli_failed: "The command failed.",
  overridden: "The agent kept another setting from a higher config layer.",
  fleet_unconfigured: "No other machines are configured.",
  machine_unknown: "That machine is not in this machine's fleet.",
  studio_unavailable: "Skill Studio could not be opened for this skill.",
};

export class ProjectSkillsActionError extends Schema.TaggedError<ProjectSkillsActionError>()(
  "ProjectSkillsActionError",
  {
    projectId: ProjectId,
    reason: ProjectSkillsActionErrorReason,
    /** A plain sentence about this case, shown instead of the generic message. */
    detail: Schema.optional(Schema.String),
    /** For `cli_failed`. */
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    stderrTail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? ACTION_ERROR_MESSAGES[this.reason];
  }
}
