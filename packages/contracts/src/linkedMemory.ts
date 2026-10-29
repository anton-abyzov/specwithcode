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
/** Tombstones one export page carries, newest first; later pages carry older ones. */
export const LINKED_MEMORY_TOMBSTONE_LIMIT = 256;
/** Tombstones a machine keeps: one per file a project can hold, so a bulk delete never comes back. */
export const LINKED_MEMORY_STORED_TOMBSTONE_LIMIT = PROJECT_MEMORY_MAX_FILES;

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

/** Longest page cursor a server hands out; it is opaque to the client. */
export const LINKED_MEMORY_CURSOR_MAX_LENGTH = 1024;

export const LinkedMemoryExportInput = Schema.Struct({
  projectId: ProjectId,
  /** `nextCursor` of the previous page; absent for the first. Older servers ignore it. */
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(LINKED_MEMORY_CURSOR_MAX_LENGTH)),
  ),
  /** Only `digest` is wanted: no files or tombstones are sent. Older servers ignore it. */
  digestOnly: Schema.optionalKey(Schema.Boolean),
});
export type LinkedMemoryExportInput = typeof LinkedMemoryExportInput.Type;

export const LinkedMemoryExport = Schema.Struct({
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  environmentId: EnvironmentId,
  machineLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  files: Schema.Array(LinkedMemoryFile).check(Schema.isMaxLength(PROJECT_MEMORY_MAX_FILES)),
  tombstones: Schema.Array(LinkedMemoryTombstone).check(
    Schema.isMaxLength(LINKED_MEMORY_TOMBSTONE_LIMIT),
  ),
  /**
   * Files were left out to keep one message under `PROJECT_LINK_MAX_BYTES`. With
   * `nextCursor` they come in the next pages; without it (an older server) they
   * are not sent at all this pass.
   */
  truncated: Schema.Boolean,
  /** Fetches the next page. Tombstones come only with the first page. */
  nextCursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(LINKED_MEMORY_CURSOR_MAX_LENGTH)),
  ),
  /**
   * sha256 over every file's name and hash and the exported tombstones' names,
   * for the whole memory rather than this page; equal digests mean two copies
   * hold the same memory. Absent on older servers.
   */
  digest: Schema.optionalKey(Sha256),
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
