import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, ProjectId } from "./baseSchemas.ts";
import {
  PROJECT_MEMORY_FILE_BYTES,
  PROJECT_MEMORY_MAX_FILES,
  ProjectMemoryName,
} from "./projectWorkspace.ts";

/**
 * Project memory replicated both ways between the members of a linked project.
 * Each machine remembers which versions (content hashes) every file has had, so
 * a merge tells an edit from an older copy; concurrent edits go to the last
 * writer and the losing version is kept as `<name>.conflict-<machine>.md`.
 */
export const LINKED_MEMORY_HISTORY_LIMIT = 50;
/** Tombstones one export carries, newest first. */
export const LINKED_MEMORY_TOMBSTONE_LIMIT = 256;

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const History = Schema.Array(Sha256).check(Schema.isMaxLength(LINKED_MEMORY_HISTORY_LIMIT));

export const LinkedMemoryFile = Schema.Struct({
  name: ProjectMemoryName,
  content: Schema.String.check(Schema.isMaxLength(PROJECT_MEMORY_FILE_BYTES)),
  contentSha256: Sha256,
  /** When this content was written on the machine that wrote it. */
  updatedAt: IsoDateTime,
  /** Versions the file has had on this machine, oldest first; the last is this content. */
  history: History,
});
export type LinkedMemoryFile = typeof LinkedMemoryFile.Type;

export const LinkedMemoryTombstone = Schema.Struct({
  name: ProjectMemoryName,
  deletedAt: IsoDateTime,
  /** Versions the file had had here when it was deleted. */
  history: History,
});
export type LinkedMemoryTombstone = typeof LinkedMemoryTombstone.Type;

export const LinkedMemoryExportInput = Schema.Struct({ projectId: ProjectId });
export type LinkedMemoryExportInput = typeof LinkedMemoryExportInput.Type;

export const LinkedMemoryExport = Schema.Struct({
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  environmentId: EnvironmentId,
  machineLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  files: Schema.Array(LinkedMemoryFile).check(Schema.isMaxLength(PROJECT_MEMORY_MAX_FILES)),
  tombstones: Schema.Array(LinkedMemoryTombstone).check(
    Schema.isMaxLength(LINKED_MEMORY_TOMBSTONE_LIMIT),
  ),
  /** Files were left out to keep one request under `PROJECT_LINK_MAX_BYTES`. */
  truncated: Schema.Boolean,
});
export type LinkedMemoryExport = typeof LinkedMemoryExport.Type;

export const LinkedMemoryMergeInput = Schema.Struct({
  projectId: ProjectId,
  /** The member the export came from. */
  peer: Schema.Struct({
    environmentId: EnvironmentId,
    projectId: ProjectId,
    label: Schema.String.check(Schema.isMaxLength(200)),
  }),
  export: LinkedMemoryExport,
});
export type LinkedMemoryMergeInput = typeof LinkedMemoryMergeInput.Type;

export const LinkedMemoryMergeResult = Schema.Struct({
  /** Written or deleted here from the peer's version. */
  applied: Schema.Array(ProjectMemoryName),
  /** The peer's version won a concurrent edit; this machine's is kept as `copy`. */
  conflicts: Schema.Array(Schema.Struct({ name: ProjectMemoryName, copy: ProjectMemoryName })),
  /** This machine's version is newer, won a concurrent edit or outlived a deletion. */
  kept: Schema.Array(ProjectMemoryName),
  /** Could not be written here, for example over the memory size limit. */
  skipped: Schema.Array(ProjectMemoryName),
});
export type LinkedMemoryMergeResult = typeof LinkedMemoryMergeResult.Type;
