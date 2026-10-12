import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";

/**
 * A project's Library: the artifacts a SpecWeave project hub registers
 * (`.specweave/project/hub.json`) and the folders where SpecWeave keeps
 * shared output. The hub file belongs to the SpecWeave CLI; Studio reads it
 * and appends to it under the same lock and revision rules.
 */
export const PROJECT_HUB_PATH = ".specweave/project/hub.json";

/** Shared SpecWeave output folders, in the order the Library lists them. */
export const PROJECT_LIBRARY_FOLDERS = [
  { path: ".specweave/reports", label: "Reports" },
  { path: ".specweave/increments", label: "Increments" },
  { path: ".specweave/docs", label: "Docs" },
  { path: ".specweave/memory", label: "Memory" },
] as const;

export const ProjectLibraryArtifactKind = Schema.Literals(["file", "link"]);
export type ProjectLibraryArtifactKind = typeof ProjectLibraryArtifactKind.Type;

export const ProjectLibraryArtifact = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  location: Schema.String,
  kind: ProjectLibraryArtifactKind,
  intentId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** File artifacts only: what the file is now. Absent when the file is gone. */
  byteLength: Schema.optional(NonNegativeInt),
  modifiedAt: Schema.optional(Schema.String),
  missing: Schema.Boolean,
});
export type ProjectLibraryArtifact = typeof ProjectLibraryArtifact.Type;

export const ProjectLibraryFolder = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  modifiedAt: Schema.optional(Schema.String),
});
export type ProjectLibraryFolder = typeof ProjectLibraryFolder.Type;

export const ProjectLibrarySnapshot = Schema.Struct({
  workspaceRoot: Schema.String,
  /** The workspace has a `.specweave/config.json`, so artifacts can be added. */
  specweave: Schema.Boolean,
  hub: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      revision: NonNegativeInt,
      updatedAt: Schema.NullOr(Schema.String),
    }),
  ),
  /** Why the hub could not be read, when it exists but is unreadable. */
  hubProblem: Schema.NullOr(Schema.String),
  artifacts: Schema.Array(ProjectLibraryArtifact),
  folders: Schema.Array(ProjectLibraryFolder),
});
export type ProjectLibrarySnapshot = typeof ProjectLibrarySnapshot.Type;

export const ProjectLibraryReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectLibraryReadInput = typeof ProjectLibraryReadInput.Type;

export const ProjectLibraryAddArtifactInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
  /** A project-relative file path or an HTTPS URL, as the SpecWeave CLI accepts. */
  location: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  /** The hub revision the person saw; 0 when there is no hub yet. */
  expectedRevision: NonNegativeInt,
});
export type ProjectLibraryAddArtifactInput = typeof ProjectLibraryAddArtifactInput.Type;

/** A thread's long report, saved as markdown in the project. */
export const ProjectThreadReport = Schema.Struct({
  /** Matches `reportKey(threadId, text)`, so a card finds its own saved copy. */
  key: Schema.String,
  /** Project-relative path of the markdown file. */
  path: Schema.String,
  savedAt: Schema.String,
});
export type ProjectThreadReport = typeof ProjectThreadReport.Type;

export const ProjectThreadReportsSnapshot = Schema.Struct({
  workspaceRoot: Schema.String,
  /** The project has a `.specweave` folder, so reports can be saved in it. */
  specweave: Schema.Boolean,
  /** The SpecWeave increment the thread works on, when one could be matched. */
  increment: Schema.NullOr(Schema.Struct({ id: Schema.String, path: Schema.String })),
  /** Folder new reports of this thread are saved to; null when there is none. */
  folder: Schema.NullOr(Schema.String),
  reports: Schema.Array(ProjectThreadReport),
});
export type ProjectThreadReportsSnapshot = typeof ProjectThreadReportsSnapshot.Type;

export const ProjectThreadReportsInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ProjectThreadReportsInput = typeof ProjectThreadReportsInput.Type;

export const ProjectThreadReportSaveInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512 * 1024)),
});
export type ProjectThreadReportSaveInput = typeof ProjectThreadReportSaveInput.Type;

export class ProjectLibraryError extends Schema.TaggedError<ProjectLibraryError>()(
  "ProjectLibraryError",
  {
    projectId: ProjectId,
    code: Schema.Literals([
      "not_found",
      "not_specweave",
      "invalid",
      "conflict",
      "operation_failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
