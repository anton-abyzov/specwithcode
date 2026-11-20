/**
 * Rolling a skill out to other machines, adopting skills another tool put on
 * this machine, and the generated catalog note (increment 1399).
 *
 * "Keep updated on these machines" is one record per skill, kept only on the
 * machine that made the change. It never rolls anything out by itself: a
 * later Update offers the same machines again, ticked, behind the same review.
 *
 * Adopt records a skill folder in `~/.agents/vskill.lock` when it matches a
 * connected repo's skill. It never deletes or rewrites the folder.
 *
 * @module contracts/projectSkillRollout
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId } from "./baseSchemas.ts";
import { SKILL_REPO_SKILL_PATTERN, SkillRepoId } from "./projectSkillRepos.ts";
import { StudioFleetMachineId, StudioFleetSkillSource } from "./studioFleet.ts";

const SkillFolderName = Schema.String.check(Schema.isPattern(SKILL_REPO_SKILL_PATTERN));

/** One "Keep updated on these machines" record. */
export const ProjectSkillRolloutKeep = Schema.Struct({
  repo: SkillRepoId,
  skill: SkillFolderName,
  scope: Schema.Literals(["user", "project"]),
  machineIds: Schema.Array(StudioFleetMachineId).check(Schema.isMaxLength(32)),
  updatedAt: IsoDateTime,
});
export type ProjectSkillRolloutKeep = typeof ProjectSkillRolloutKeep.Type;

export const ProjectSkillsRolloutKeepInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, operation: Schema.Literal("read") }),
  Schema.Struct({
    projectId: ProjectId,
    operation: Schema.Literal("set"),
    repo: SkillRepoId,
    skill: SkillFolderName,
    scope: Schema.Literals(["user", "project"]),
    machineIds: Schema.Array(StudioFleetMachineId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
  }),
  Schema.Struct({
    projectId: ProjectId,
    operation: Schema.Literal("clear"),
    repo: SkillRepoId,
    skill: SkillFolderName,
    scope: Schema.Literals(["user", "project"]),
  }),
]);
export type ProjectSkillsRolloutKeepInput = typeof ProjectSkillsRolloutKeepInput.Type;

export const ProjectSkillsRolloutKeepResult = Schema.Struct({
  records: Schema.Array(ProjectSkillRolloutKeep),
});
export type ProjectSkillsRolloutKeepResult = typeof ProjectSkillsRolloutKeepResult.Type;

// ---------------------------------------------------------------------------
// Adopt
// ---------------------------------------------------------------------------

/** Who tracks a user skill folder today. */
export const ProjectSkillTracker = Schema.Literals(["npx-skills", "none"]);
export type ProjectSkillTracker = typeof ProjectSkillTracker.Type;

/** A connected repo's skill whose SKILL.md matches the folder under the normalized match. */
export const ProjectSkillAdoptMatch = Schema.Struct({
  repo: SkillRepoId,
  source: StudioFleetSkillSource,
  version: Schema.NullOr(Schema.String),
  contentHash: Schema.String,
  visibility: Schema.Literals(["public", "private"]),
});
export type ProjectSkillAdoptMatch = typeof ProjectSkillAdoptMatch.Type;

/** A user skill folder vskill does not track, and what Adopt can do with it. */
export const ProjectSkillAdoptCandidate = Schema.Struct({
  skill: SkillFolderName,
  tracker: ProjectSkillTracker,
  /** The npx skills lock's source for it (`owner/repo`), when that lock has one. */
  trackedSource: Schema.optional(Schema.String),
  match: Schema.NullOr(ProjectSkillAdoptMatch),
  /** Why there is no match, or why Adopt cannot run. */
  detail: Schema.optional(Schema.String),
});
export type ProjectSkillAdoptCandidate = typeof ProjectSkillAdoptCandidate.Type;

/** The files a pull request to a skill repo would add, for its confirmation. */
export const ProjectSkillProposal = Schema.Struct({
  repo: SkillRepoId,
  skill: SkillFolderName,
  /** Repo-relative paths, `skills/<skill>/...`. */
  files: Schema.Array(Schema.String),
  /** Left out: hidden files, links, binaries and anything too large. */
  skipped: Schema.Array(Schema.String),
  /** Ties the confirmation to these exact files. */
  fingerprint: Schema.String,
});
export type ProjectSkillProposal = typeof ProjectSkillProposal.Type;

export const ProjectSkillsAdoptInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, operation: Schema.Literal("check") }),
  Schema.Struct({
    projectId: ProjectId,
    operation: Schema.Literal("adopt"),
    skill: SkillFolderName,
  }),
  Schema.Struct({
    projectId: ProjectId,
    operation: Schema.Literal("propose-preview"),
    skill: SkillFolderName,
    repo: SkillRepoId,
  }),
  /** An outward GitHub write: asked for and confirmed each time, never merged here. */
  Schema.Struct({
    projectId: ProjectId,
    operation: Schema.Literal("propose"),
    skill: SkillFolderName,
    repo: SkillRepoId,
    fingerprint: Schema.String,
    confirmed: Schema.Literal(true),
  }),
]);
export type ProjectSkillsAdoptInput = typeof ProjectSkillsAdoptInput.Type;

export const ProjectSkillAdoptOutcome = Schema.Struct({
  skill: SkillFolderName,
  outcome: Schema.Literals(["adopted", "failed"]),
  /** The lock entry read back: version and short commit. */
  version: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  /** Whether the npx skills lock entry was removed after the read-back. */
  releasedFromNpxSkills: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
});
export type ProjectSkillAdoptOutcome = typeof ProjectSkillAdoptOutcome.Type;

export const ProjectSkillsAdoptResult = Schema.Struct({
  checkedAt: IsoDateTime,
  candidates: Schema.optional(Schema.Array(ProjectSkillAdoptCandidate)),
  outcome: Schema.optional(ProjectSkillAdoptOutcome),
  proposal: Schema.optional(ProjectSkillProposal),
  /** The pull request opened by `propose`. */
  pullRequestUrl: Schema.optional(Schema.String),
  /** Where the catalog note was written after the change, when this machine has a vault. */
  catalog: Schema.optional(
    Schema.Struct({ state: Schema.Literals(["written", "no-vault", "kept", "failed"]) }),
  ),
});
export type ProjectSkillsAdoptResult = typeof ProjectSkillsAdoptResult.Type;

/** The marker the generated catalog note carries; a note without it is never overwritten. */
export const SKILL_CATALOG_MARKER =
  "Generated by SpecWithCode. Do not edit: this note is generated, edit the source repo instead.";

/** Where the catalog note lives inside a vault. */
export const SKILL_CATALOG_NOTE_PATH = "003 Resources/AI Skills/Skills catalog.md";
