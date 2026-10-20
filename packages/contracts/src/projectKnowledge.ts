import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * Project knowledge: the project's memory files, hub artifacts and Library
 * folder text that the app indexes for its threads. Memory files and hub
 * artifacts are what people chose to keep; while they fit the inline
 * allowance every worker thread receives them in full, and Library folder
 * files are always searched. Past the allowance the project switches to
 * search mode, and returns to inline only once it is back under the lower
 * mark, so edits near the threshold do not flap.
 */
export const PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT = 24_000;
export const PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT = 19_200;
/** Larger files are left out and counted. */
export const PROJECT_KNOWLEDGE_FILE_BYTES = 2 * 1024 * 1024;
export const PROJECT_KNOWLEDGE_MAX_DOCUMENTS = 20_000;
/** Index capacity, measured as the documents' size on disk, as files are chosen before reading. */
export const PROJECT_KNOWLEDGE_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECT_KNOWLEDGE_SEARCH_DEFAULT_RESULTS = 8;
export const PROJECT_KNOWLEDGE_SEARCH_MAX_RESULTS = 20;
export const PROJECT_KNOWLEDGE_READ_PAGE_CHARACTERS = 16_000;

export const ProjectKnowledgeMode = Schema.Literals(["empty", "inline", "search"]);
export type ProjectKnowledgeMode = typeof ProjectKnowledgeMode.Type;

export const ProjectKnowledgeIndexState = Schema.Literals([
  "unindexed",
  "indexing",
  "ready",
  "failed",
]);
export type ProjectKnowledgeIndexState = typeof ProjectKnowledgeIndexState.Type;

export const ProjectKnowledgeSourceKind = Schema.Literals(["memory", "artifact", "library"]);
export type ProjectKnowledgeSourceKind = typeof ProjectKnowledgeSourceKind.Type;

export const ProjectKnowledgeSourceSummary = Schema.Struct({
  kind: ProjectKnowledgeSourceKind,
  /** Project memory, Hub artifacts, or a Library folder label such as Reports. */
  label: Schema.String,
  documents: NonNegativeInt,
  characters: NonNegativeInt,
});
export type ProjectKnowledgeSourceSummary = typeof ProjectKnowledgeSourceSummary.Type;

export const ProjectKnowledgeSkipped = Schema.Struct({
  tooLarge: NonNegativeInt,
  overCapacity: NonNegativeInt,
  unreadable: NonNegativeInt,
});
export type ProjectKnowledgeSkipped = typeof ProjectKnowledgeSkipped.Type;

export const ProjectKnowledgeStatus = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectKnowledgeMode,
  state: ProjectKnowledgeIndexState,
  documents: NonNegativeInt,
  /** Extracted text of every indexed document. */
  characters: NonNegativeInt,
  /** The knowledge as threads would receive it inline; this is what the allowance measures. */
  inlineCharacters: NonNegativeInt,
  inlineLimit: NonNegativeInt,
  inlineReturnLimit: NonNegativeInt,
  /** Size on disk of the indexed documents, the measure the capacity limits. */
  bytes: NonNegativeInt,
  capacityBytes: NonNegativeInt,
  capacityDocuments: NonNegativeInt,
  sources: Schema.Array(ProjectKnowledgeSourceSummary),
  skipped: ProjectKnowledgeSkipped,
  indexedAt: Schema.NullOr(Schema.String),
  /** Why the last refresh failed, in words a person can act on. */
  problem: Schema.NullOr(Schema.String),
});
export type ProjectKnowledgeStatus = typeof ProjectKnowledgeStatus.Type;

export const ProjectKnowledgeStatusInput = Schema.Struct({ projectId: ProjectId });
export type ProjectKnowledgeStatusInput = typeof ProjectKnowledgeStatusInput.Type;

export const ProjectKnowledgeQuery = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_000),
);
export const ProjectKnowledgeDocumentId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_200),
);

export const ProjectKnowledgeSearchInput = Schema.Struct({
  projectId: ProjectId,
  query: ProjectKnowledgeQuery,
  limit: Schema.optional(NonNegativeInt),
  /** Only documents whose location starts with this path, such as `.specweave/increments/0864`. */
  within: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type ProjectKnowledgeSearchInput = typeof ProjectKnowledgeSearchInput.Type;

export const ProjectKnowledgeSearchHit = Schema.Struct({
  documentId: Schema.String,
  title: Schema.String,
  /** The memory file name or the project-relative path. */
  location: Schema.String,
  kind: ProjectKnowledgeSourceKind,
  /** Heading breadcrumb of the matching passage, empty before the first heading. */
  heading: Schema.String,
  /** The passage; empty once the result's text budget is spent. */
  excerpt: Schema.String,
  /** Character offset of the passage, for studio_project_knowledge_read. */
  offset: NonNegativeInt,
  /** When the document last changed, so an old or archived passage reads as such. */
  modifiedAt: Schema.String,
  score: Schema.Number,
});
export type ProjectKnowledgeSearchHit = typeof ProjectKnowledgeSearchHit.Type;

export const ProjectKnowledgeSearchResult = Schema.Struct({
  projectId: ProjectId,
  mode: ProjectKnowledgeMode,
  state: ProjectKnowledgeIndexState,
  results: Schema.Array(ProjectKnowledgeSearchHit),
  /** More passages matched than were returned. */
  truncated: Schema.Boolean,
});
export type ProjectKnowledgeSearchResult = typeof ProjectKnowledgeSearchResult.Type;

export const ProjectKnowledgeReadInput = Schema.Struct({
  projectId: ProjectId,
  documentId: ProjectKnowledgeDocumentId,
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});
export type ProjectKnowledgeReadInput = typeof ProjectKnowledgeReadInput.Type;

export const ProjectKnowledgeDocument = Schema.Struct({
  projectId: ProjectId,
  documentId: Schema.String,
  title: Schema.String,
  location: Schema.String,
  kind: ProjectKnowledgeSourceKind,
  content: Schema.String,
  offset: NonNegativeInt,
  /** Pass as offset to read on; null at the end of the document. */
  nextOffset: Schema.NullOr(NonNegativeInt),
  totalCharacters: NonNegativeInt,
});
export type ProjectKnowledgeDocument = typeof ProjectKnowledgeDocument.Type;

export const ProjectKnowledgeReindexInput = Schema.Struct({ projectId: ProjectId });
export type ProjectKnowledgeReindexInput = typeof ProjectKnowledgeReindexInput.Type;

export class ProjectKnowledgeError extends Schema.TaggedError<ProjectKnowledgeError>()(
  "ProjectKnowledgeError",
  {
    projectId: ProjectId,
    code: Schema.Literals(["not_found", "invalid", "unavailable", "operation_failed"]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "not_found":
        return "That project or knowledge document no longer exists.";
      case "invalid":
        return "That knowledge request is not valid.";
      case "unavailable":
        return "Project knowledge is not available on this host.";
      case "operation_failed":
        return "Project knowledge could not be read. Try again.";
    }
  }
}
