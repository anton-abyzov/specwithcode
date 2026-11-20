/**
 * Local skill management on one machine: the skill repos it has connected,
 * one search over installed skills, connected repos and notes, and updates
 * from each skill's recorded source. Nothing here writes to another machine.
 *
 * A private repo is read only through this machine's GitHub sign-in (`gh`).
 * Nothing about it is sent to a skill registry.
 *
 * @module contracts/projectSkillRepos
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProjectSkillName } from "./projectSkills.ts";

/** `owner/repo` on github.com. Never starts with a dash, so it cannot read as a flag. */
const SKILL_REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export const SkillRepoId = Schema.String.check(Schema.isPattern(SKILL_REPO_ID_PATTERN));
export type SkillRepoId = typeof SkillRepoId.Type;

/** A skill folder name inside a repo: one path segment. */
export const SKILL_REPO_SKILL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Repos offered before the person has connected any. */
export const SUGGESTED_SKILL_REPOS: ReadonlyArray<SkillRepoId> = [
  "anton-abyzov/vskill",
  "anton-abyzov/anton-personal-skills",
];

/**
 * `owner/repo` from what a person typed: `owner/repo`, a github.com URL (with
 * or without `.git`, a trailing slash or a deeper path) or `git@github.com:owner/repo`.
 * Anything on another host, or with other characters, is null.
 */
export function parseSkillRepoRef(input: string): SkillRepoId | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 300) return null;
  const url =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
      text,
    );
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text);
  const bare = /^([^/\s:@]+)\/([^/\s:@]+?)(?:\.git)?$/.exec(text);
  const match = url ?? scp ?? bare;
  if (!match) return null;
  const id = `${match[1]}/${match[2]}`;
  return SKILL_REPO_ID_PATTERN.test(id) ? id : null;
}

/**
 * Why a repo could not be read.
 * `needs-sign-in`: GitHub does not show it without a sign-in, and this machine has none.
 * `not-found`: the signed-in account cannot see it, or it does not exist.
 */
export const SkillRepoRefusalReason = Schema.Literals([
  "invalid",
  "needs-sign-in",
  "not-found",
  "rate-limited",
  "unreachable",
]);
export type SkillRepoRefusalReason = typeof SkillRepoRefusalReason.Type;

/** The sentence for a refusal, with the machine's name. */
export function skillRepoRefusalMessage(
  reason: SkillRepoRefusalReason,
  repo: string,
  machine: string,
): string {
  switch (reason) {
    case "invalid":
      return "Name the repo as owner/repo or paste its GitHub link.";
    case "needs-sign-in":
      return `Sign in to GitHub on ${machine} to read ${repo}`;
    case "not-found":
      return `GitHub has no ${repo} for the account signed in on ${machine}.`;
    case "rate-limited":
      return `GitHub is limiting reads from ${machine}. Sign in to GitHub there or try again later.`;
    case "unreachable":
      return `GitHub could not be reached from ${machine}.`;
  }
}

/** One skill a repo offers, read at the repo's head commit. */
export const ProjectSkillRepoSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** The SKILL.md inside the repo, such as `plugins/personal/skills/obsidian-brain/SKILL.md`. */
  path: TrimmedNonEmptyString,
  /** The plugin folder the skill sits in, for the `plugins/<plugin>/skills/<name>` layout. */
  plugin: Schema.NullOr(Schema.String),
  /** `metadata.version` (or a top-level `version`) from the SKILL.md. */
  version: Schema.NullOr(Schema.String),
  description: Schema.optional(Schema.String),
  /** The commit the file was read at. */
  commit: Schema.String,
  /** sha256 of the SKILL.md text, the value vskill records as `sha`. */
  contentHash: Schema.String,
});
export type ProjectSkillRepoSkill = typeof ProjectSkillRepoSkill.Type;

export const ProjectSkillRepo = Schema.Struct({
  repo: SkillRepoId,
  /** As GitHub reported it when the repo was last read. */
  visibility: Schema.Literals(["public", "private"]),
  connectedAt: IsoDateTime,
  /** `ok`, or why this read failed; the skills are then empty. */
  state: Schema.Union([Schema.Literal("ok"), SkillRepoRefusalReason]),
  /** Head commit of the default branch. */
  commit: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
  skills: Schema.Array(ProjectSkillRepoSkill),
  /** True when the repo holds more skills than one read lists. */
  truncated: Schema.optional(Schema.Boolean),
});
export type ProjectSkillRepo = typeof ProjectSkillRepo.Type;

export const ProjectSkillReposInput = Schema.Struct({
  projectId: ProjectId,
  /** `read` lists; `connect` and `disconnect` change this machine's list. */
  operation: Schema.Literals(["read", "connect", "disconnect"]),
  /** For connect: `owner/repo` or a GitHub URL. For disconnect: `owner/repo`. */
  repo: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  /** Read each repo again instead of a recent answer. */
  refresh: Schema.optional(Schema.Boolean),
});
export type ProjectSkillReposInput = typeof ProjectSkillReposInput.Type;

export const ProjectSkillReposResult = Schema.Struct({
  repos: Schema.Array(ProjectSkillRepo),
  /** Repos to offer that are not connected yet. */
  suggestions: Schema.Array(SkillRepoId),
  /** Set when a connect was refused; the list is then unchanged. */
  refusal: Schema.optional(Schema.Struct({ reason: SkillRepoRefusalReason, repo: Schema.String })),
});
export type ProjectSkillReposResult = typeof ProjectSkillReposResult.Type;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const skillsFolder = {
  projectId: ProjectId,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  userLevel: Schema.optional(Schema.Boolean),
};

export const ProjectSkillsSearchInput = Schema.Struct({
  ...skillsFolder,
  /** `search` reads only. `open-note` opens one found note in Obsidian on this machine. */
  operation: Schema.Literals(["search", "open-note"]),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** For open-note: a note path from a search result, relative to the vault. */
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
export type ProjectSkillsSearchInput = typeof ProjectSkillsSearchInput.Type;

export const ProjectSkillSearchInstalled = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** Labels of the agents that load it on this machine. */
  agents: Schema.Array(Schema.String),
});
export type ProjectSkillSearchInstalled = typeof ProjectSkillSearchInstalled.Type;

export const ProjectSkillSearchAvailable = Schema.Struct({
  repo: SkillRepoId,
  visibility: Schema.Literals(["public", "private"]),
  skill: ProjectSkillRepoSkill,
});
export type ProjectSkillSearchAvailable = typeof ProjectSkillSearchAvailable.Type;

export const ProjectSkillSearchNote = Schema.Struct({
  title: Schema.String,
  /** Relative to the vault; the vault's own location stays on the machine. */
  path: Schema.String,
  /** The vault's folder name. */
  vault: Schema.String,
  snippet: Schema.optional(Schema.String),
});
export type ProjectSkillSearchNote = typeof ProjectSkillSearchNote.Type;

export const ProjectSkillsSearchResult = Schema.Struct({
  query: Schema.String,
  installed: Schema.Array(ProjectSkillSearchInstalled),
  available: Schema.Array(ProjectSkillSearchAvailable),
  notes: Schema.Array(ProjectSkillSearchNote),
  /**
   * `none`: this machine has no Obsidian vault. `partial`: the search stopped
   * at its file or time limit, so more notes may match.
   */
  notesState: Schema.Literals(["ok", "partial", "none"]),
  /** For open-note: whether the note was handed to Obsidian. */
  opened: Schema.optional(Schema.Boolean),
});
export type ProjectSkillsSearchResult = typeof ProjectSkillsSearchResult.Type;

// ---------------------------------------------------------------------------
// Version, update and readiness
// ---------------------------------------------------------------------------

/** One copy of a skill: its `metadata.version`, source commit and SKILL.md hash. */
export const ProjectSkillSourceVersion = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  contentHash: Schema.NullOr(Schema.String),
});
export type ProjectSkillSourceVersion = typeof ProjectSkillSourceVersion.Type;

/**
 * `changed`: the source has other content under the same version.
 * `pinned`: the source moved on, but the skill is pinned and is left alone.
 * `unsupported`: the lock records a source this page cannot update from (a
 * plugin, a registry-only or a hosted entry).
 */
export const ProjectSkillUpdateState = Schema.Literals([
  "current",
  "update",
  "changed",
  "pinned",
  "unsupported",
  "needs-sign-in",
  "unknown",
]);
export type ProjectSkillUpdateState = typeof ProjectSkillUpdateState.Type;

export const ProjectSkillSourceStatus = Schema.Struct({
  skill: TrimmedNonEmptyString,
  repo: Schema.NullOr(Schema.String),
  lockScope: Schema.Literals(["project", "user"]),
  installed: ProjectSkillSourceVersion,
  /** Where the installed copy came from in `repo`, as the lock records it ("Also add on" sends it). */
  installedSource: Schema.optional(Schema.Struct({ path: Schema.String, branch: Schema.String })),
  /** The same skill at its source's head; null when the source could not be read. */
  latest: Schema.NullOr(ProjectSkillSourceVersion),
  state: ProjectSkillUpdateState,
  detail: Schema.optional(Schema.String),
});
export type ProjectSkillSourceStatus = typeof ProjectSkillSourceStatus.Type;

/**
 * When an agent has the skill, from that agent's own list, never assumed.
 * `loaded-now`: the agent's live skill list reports it.
 * `next-message`: the agent's skill folders hold it and it is known to rescan them per message.
 * `next-session`: the agent reads its skills when a session starts, or did not confirm.
 */
export const ProjectSkillReadiness = Schema.Literals([
  "loaded-now",
  "next-message",
  "next-session",
]);
export type ProjectSkillReadiness = typeof ProjectSkillReadiness.Type;

export const ProjectSkillAgentReadiness = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: Schema.String,
  readiness: ProjectSkillReadiness,
  /** What the readiness rests on. */
  detail: Schema.String,
});
export type ProjectSkillAgentReadiness = typeof ProjectSkillAgentReadiness.Type;

export const ProjectSkillUpdateOutcome = Schema.Struct({
  skill: Schema.String,
  outcome: Schema.Literals(["installed", "updated", "current", "skipped", "failed"]),
  /** Read from the lock before the run; null for a new install. */
  before: Schema.NullOr(ProjectSkillSourceVersion),
  /** Read back from the lock vskill wrote, not from its output. */
  after: Schema.NullOr(ProjectSkillSourceVersion),
  message: Schema.optional(Schema.String),
  readiness: Schema.Array(ProjectSkillAgentReadiness),
});
export type ProjectSkillUpdateOutcome = typeof ProjectSkillUpdateOutcome.Type;

export const ProjectSkillsUpdateInput = Schema.Struct({
  ...skillsFolder,
  /**
   * `status` reads only. `update` reinstalls the named skills (left out: every
   * outdated one) from their recorded sources. `install` adds one skill from a
   * connected repo.
   */
  operation: Schema.Literals(["status", "update", "install"]),
  skills: Schema.optional(Schema.Array(ProjectSkillName).check(Schema.isMaxLength(200))),
  install: Schema.optional(
    Schema.Struct({
      repo: SkillRepoId,
      skill: Schema.String.check(Schema.isPattern(SKILL_REPO_SKILL_PATTERN)),
    }),
  ),
  refresh: Schema.optional(Schema.Boolean),
});
export type ProjectSkillsUpdateInput = typeof ProjectSkillsUpdateInput.Type;

export const ProjectSkillsUpdateResult = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Every skill a vskill lock tracks in this folder, after any run. */
  statuses: Schema.Array(ProjectSkillSourceStatus),
  /** One per skill an update or install ran for. */
  outcomes: Schema.optional(Schema.Array(ProjectSkillUpdateOutcome)),
});
export type ProjectSkillsUpdateResult = typeof ProjectSkillsUpdateResult.Type;

/** `1.2.0 · 3f9c2ab`, or whichever part is known. */
export function formatSkillSourceVersion(
  value: Pick<ProjectSkillSourceVersion, "version" | "commit"> | null,
): string {
  if (value === null) return "";
  const commit = value.commit ? value.commit.slice(0, 7) : null;
  return [value.version, commit].filter((part) => part !== null && part !== "").join(" · ");
}

/**
 * How an installed copy stands against its source: the SKILL.md hash decides,
 * so the same version with other content is `changed`, and a source that only
 * gained unrelated commits is `current`.
 */
export function compareSkillSourceVersions(
  installed: ProjectSkillSourceVersion,
  latest: ProjectSkillSourceVersion | null,
): "current" | "update" | "changed" | "unknown" {
  if (latest === null) return "unknown";
  if (installed.contentHash !== null && latest.contentHash !== null) {
    if (installed.contentHash === latest.contentHash) return "current";
    return installed.version === latest.version ? "changed" : "update";
  }
  if (installed.version !== latest.version) return "update";
  return "unknown";
}
