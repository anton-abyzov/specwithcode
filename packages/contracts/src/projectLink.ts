import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId } from "./baseSchemas.ts";
import {
  LogicalProject,
  LogicalProjectMember,
  ProjectCoordinatorBinding,
} from "./logicalProject.ts";
import { MACHINE_HANDOFF_MAX_BYTES } from "./machineHandoff.ts";
import {
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_MEMORY_FILE_BYTES,
  ProjectMemoryName,
} from "./projectWorkspace.ts";

/**
 * Linking makes two existing copies of one project, on two machines, one shared
 * project without moving files or the coordinator. The client drives both machines
 * like a handoff: prepare on the kept copy, preview and accept on the joining copy,
 * commit on the kept copy. Every step is idempotent for one operation id.
 */
export const PROJECT_LINK_MAX_BYTES = MACHINE_HANDOFF_MAX_BYTES;
export const ProjectLinkOperationId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** One repository inside a project folder: where it sits and which origin it tracks. */
export const RepositoryFingerprintEntry = Schema.Struct({
  /** Forward-slash path relative to the folder; "" is the folder itself. */
  path: bounded(1024),
  /** Canonical origin (`github.com/team/repo`); null without a usable origin. */
  originKey: Schema.NullOr(bounded(512)),
  /** Linked worktrees of this repository found in the folder; never counted as repositories. */
  worktrees: NonNegativeInt,
});
export type RepositoryFingerprintEntry = typeof RepositoryFingerprintEntry.Type;

/** What a folder holds, so copies of one project on two machines can be recognised. */
export const RepositoryFingerprint = Schema.Struct({
  /** A repository at the root, or a plain folder that only holds repositories. */
  root: Schema.Literals(["repository", "folder"]),
  repositories: Schema.Array(RepositoryFingerprintEntry).check(Schema.isMaxLength(1024)),
  /** Directory links seen and skipped; they are never followed. */
  skippedLinks: NonNegativeInt,
  /** The scan stopped at its size limit; the list may be incomplete. */
  truncated: Schema.Boolean,
});
export type RepositoryFingerprint = typeof RepositoryFingerprint.Type;

export const ProjectFingerprintInput = Schema.Struct({
  /** A registered project, or a folder that is not one yet (Add folder). */
  projectId: Schema.optional(ProjectId),
  workspaceRoot: Schema.optional(bounded(4096)),
});
export type ProjectFingerprintInput = typeof ProjectFingerprintInput.Type;
export const ProjectFingerprintResult = Schema.Struct({
  workspaceRoot: bounded(4096),
  fingerprint: RepositoryFingerprint,
});
export type ProjectFingerprintResult = typeof ProjectFingerprintResult.Type;

export interface FingerprintComparison {
  /** Both have a root repository with one origin, or both are plain folders sharing one. */
  readonly rootMatches: boolean;
  /** 0 to 1: how much of the two folders' repositories agree; ranks candidates. */
  readonly score: number;
  readonly shared: number;
  /** In the other folder, not in this one: offered as "Clone from origin". */
  readonly missingHere: ReadonlyArray<RepositoryFingerprintEntry>;
  readonly extraHere: ReadonlyArray<RepositoryFingerprintEntry>;
}

const rootEntry = (fingerprint: RepositoryFingerprint) =>
  fingerprint.root === "repository"
    ? fingerprint.repositories.find((entry) => entry.path === "")
    : undefined;
const repositoryKey = (entry: RepositoryFingerprintEntry) =>
  entry.originKey ?? `path:${entry.path}`;

/**
 * Compares two folders. Resemblance only ranks and suggests; it never links.
 * A folder holding a subset of the other's repositories still matches at the root.
 */
export function compareFingerprints(
  here: RepositoryFingerprint,
  there: RepositoryFingerprint,
): FingerprintComparison {
  const nested = (fingerprint: RepositoryFingerprint) =>
    fingerprint.repositories.filter((entry) => entry !== rootEntry(fingerprint));
  const hereKeys = new Map(nested(here).map((entry) => [repositoryKey(entry), entry]));
  const thereKeys = new Map(nested(there).map((entry) => [repositoryKey(entry), entry]));
  const shared = [...hereKeys.keys()].filter((key) => thereKeys.has(key));
  const samePath = shared.filter((key) => hereKeys.get(key)!.path === thereKeys.get(key)!.path);
  const hereRoot = rootEntry(here);
  const thereRoot = rootEntry(there);
  const rootMatches =
    hereRoot !== undefined || thereRoot !== undefined
      ? hereRoot?.originKey != null && hereRoot.originKey === thereRoot?.originKey
      : samePath.length > 0;
  const union = new Set([...hereKeys.keys(), ...thereKeys.keys()]).size;
  const overlap = union === 0 ? (rootMatches ? 1 : 0) : shared.length / union;
  const placed = shared.length === 0 ? 0 : samePath.length / shared.length;
  return {
    rootMatches,
    score: rootMatches ? 0.6 + 0.3 * overlap + 0.1 * placed : 0.5 * overlap + 0.1 * placed,
    shared: shared.length + (rootMatches && hereRoot ? 1 : 0),
    missingHere: [...thereKeys].filter(([key]) => !hereKeys.has(key)).map(([, entry]) => entry),
    extraHere: [...hereKeys].filter(([key]) => !thereKeys.has(key)).map(([, entry]) => entry),
  };
}

export const ProjectLinkNote = Schema.Struct({
  name: ProjectMemoryName,
  revision: NonNegativeInt,
  content: bounded(PROJECT_MEMORY_FILE_BYTES),
});
export type ProjectLinkNote = typeof ProjectLinkNote.Type;

/** Why this copy cannot take a role; the UI names the fix. */
export const ProjectLinkRefusal = Schema.Literals([
  "already_shared",
  "not_coordinator",
  "handoff_in_progress",
  "paused",
  "archived",
  "not_code_project",
  "coordinator_busy",
]);
export type ProjectLinkRefusal = typeof ProjectLinkRefusal.Type;

export const ProjectLinkPreviewInput = Schema.Struct({ projectId: ProjectId });
export type ProjectLinkPreviewInput = typeof ProjectLinkPreviewInput.Type;
/** One copy as linking sees it. Reading it changes nothing. */
export const ProjectLinkPreview = Schema.Struct({
  member: LogicalProjectMember,
  title: bounded(1000),
  workspaceRoot: bounded(4096),
  logicalProject: Schema.NullOr(LogicalProject),
  coordinatorBinding: Schema.NullOr(ProjectCoordinatorBinding),
  fingerprint: RepositoryFingerprint,
  goal: bounded(PROJECT_GOAL_MAX_LENGTH),
  instructions: bounded(PROJECT_INSTRUCTIONS_MAX_LENGTH),
  notes: Schema.Array(ProjectLinkNote).check(Schema.isMaxLength(4096)),
  /** The notes exceed what one link request carries; merge them by hand. */
  notesTruncated: Schema.Boolean,
  lastCoordinatorActivityAt: Schema.NullOr(IsoDateTime),
  /** Null when this copy may keep its coordinator, otherwise why not. */
  keepRefusal: Schema.NullOr(ProjectLinkRefusal),
  /** Null when this copy may join another as a member, otherwise why not. */
  joinRefusal: Schema.NullOr(ProjectLinkRefusal),
});
export type ProjectLinkPreview = typeof ProjectLinkPreview.Type;

/** Kept machine: make sure the kept copy has a shared identity (adopting one if needed). */
export const ProjectLinkPrepareInput = Schema.Struct({
  operationId: ProjectLinkOperationId,
  projectId: ProjectId,
  joining: LogicalProjectMember,
});
export type ProjectLinkPrepareInput = typeof ProjectLinkPrepareInput.Type;
export const ProjectLinkPrepareResult = Schema.Struct({
  operationId: ProjectLinkOperationId,
  kept: LogicalProjectMember,
  logicalProject: LogicalProject,
  coordinatorBinding: ProjectCoordinatorBinding,
  fingerprint: RepositoryFingerprint,
  /** This step gave the kept copy its first shared identity. */
  adopted: Schema.Boolean,
});
export type ProjectLinkPrepareResult = typeof ProjectLinkPrepareResult.Type;

/** Joining machine: adopt the kept identity and relinquish this copy's coordinator. */
export const ProjectLinkAcceptInput = Schema.Struct({
  operationId: ProjectLinkOperationId,
  projectId: ProjectId,
  kept: LogicalProjectMember,
  logicalProject: LogicalProject,
  coordinatorBinding: ProjectCoordinatorBinding,
  keptFingerprint: RepositoryFingerprint,
});
export type ProjectLinkAcceptInput = typeof ProjectLinkAcceptInput.Type;
export const ProjectLinkAcceptResult = Schema.Struct({
  operationId: ProjectLinkOperationId,
  member: LogicalProjectMember,
  logicalProject: LogicalProject,
  coordinatorBinding: ProjectCoordinatorBinding,
  replayed: Schema.Boolean,
});
export type ProjectLinkAcceptResult = typeof ProjectLinkAcceptResult.Type;

/** A note to write into the kept copy. `expectedRevision` null: it must not exist yet. */
export const ProjectLinkNoteWrite = Schema.Struct({
  name: ProjectMemoryName,
  content: bounded(PROJECT_MEMORY_FILE_BYTES),
  expectedRevision: Schema.NullOr(NonNegativeInt),
});
export type ProjectLinkNoteWrite = typeof ProjectLinkNoteWrite.Type;
const NoteWrites = Schema.Array(ProjectLinkNoteWrite).check(Schema.isMaxLength(4096));

/** Kept machine: list the joined member and write the notes the user chose. */
export const ProjectLinkCommitInput = Schema.Struct({
  operationId: ProjectLinkOperationId,
  projectId: ProjectId,
  joining: LogicalProjectMember,
  notes: NoteWrites,
});
export type ProjectLinkCommitInput = typeof ProjectLinkCommitInput.Type;
export const ProjectLinkCommitResult = Schema.Struct({
  operationId: ProjectLinkOperationId,
  logicalProject: LogicalProject,
  notesWritten: NonNegativeInt,
  replayed: Schema.Boolean,
});
export type ProjectLinkCommitResult = typeof ProjectLinkCommitResult.Type;

/**
 * `member`: this copy leaves the shared project with a fresh identity and its own
 * active coordinator, keeping `notes` copied from the kept copy. `coordinator`: the
 * kept copy stops listing `member`. Either side works while the other is offline.
 */
export const ProjectUnlinkInput = Schema.Union([
  Schema.Struct({
    side: Schema.Literal("member"),
    operationId: ProjectLinkOperationId,
    projectId: ProjectId,
    notes: NoteWrites,
  }),
  Schema.Struct({
    side: Schema.Literal("coordinator"),
    operationId: ProjectLinkOperationId,
    projectId: ProjectId,
    member: LogicalProjectMember,
  }),
]);
export type ProjectUnlinkInput = typeof ProjectUnlinkInput.Type;
export const ProjectUnlinkResult = Schema.Struct({
  operationId: ProjectLinkOperationId,
  logicalProject: LogicalProject,
  coordinatorBinding: ProjectCoordinatorBinding,
  notesWritten: NonNegativeInt,
  replayed: Schema.Boolean,
});
export type ProjectUnlinkResult = typeof ProjectUnlinkResult.Type;

export class ProjectLinkError extends Schema.TaggedError<ProjectLinkError>()("ProjectLinkError", {
  code: Schema.Literals([
    "not_found",
    "invalid",
    "same_machine",
    "already_shared",
    "not_coordinator",
    "handoff_in_progress",
    "paused",
    "archived",
    "not_code_project",
    "coordinator_busy",
    "repository_mismatch",
    "notes_changed",
    "too_large",
    "conflict",
    "not_linked",
    "storage_failed",
  ]),
  /** Names what differs, such as the two root repositories. */
  detail: Schema.optional(bounded(1000)),
}) {
  override get message(): string {
    const messages: Record<ProjectLinkError["code"], string> = {
      not_found: "The project is no longer on this machine. Reload and choose it again.",
      invalid: "The link request is invalid. Reload both projects and try again.",
      same_machine: "Both copies are on this machine. Link copies on two different machines.",
      already_shared:
        "This copy is already shared with other machines. Unlink it there first, then link again.",
      not_coordinator:
        "This copy does not hold the active coordinator. Keep the coordinator of the copy that does.",
      handoff_in_progress:
        "A coordinator handoff is in progress for this project. Finish or retry the handoff first.",
      paused: "This project is paused. Resume it, then link again.",
      archived: "This project is archived. Restore it, then link again.",
      not_code_project: "Only code projects can be linked across machines.",
      coordinator_busy:
        "The coordinator of the joining copy is working. Let it finish or stop it, then link.",
      repository_mismatch:
        "The two folders hold different repositories at the root. Link only copies of the same project.",
      notes_changed: "Memory notes changed since the preview. Review the preview again.",
      too_large: "The memory notes are too large to merge in one link. Merge some by hand first.",
      conflict: "The project changed while linking. Review the preview again and retry.",
      not_linked: "This copy is not linked with that project.",
      storage_failed: "The link could not be saved on this machine. Retry the same link.",
    };
    return this.detail ? `${messages[this.code]} ${this.detail}` : messages[this.code];
  }
}

/** A note name that keeps both versions: `decisions.md` from "MacBook Pro" → `decisions-macbook-pro.md`. */
export function keepBothNoteName(name: string, machineLabel: string): string {
  const stem = name.replace(/\.md$/u, "");
  const slug =
    machineLabel
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "other";
  return `${`${stem}-${slug}`.slice(0, 124).replace(/[-_]+$/u, "")}.md`;
}
