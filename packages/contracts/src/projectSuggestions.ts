import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

/** What a starter task is about; the project view picks its icon from this. */
export const ProjectStarterSuggestionTopic = Schema.Literals([
  "handoff",
  "increment",
  "changes",
  "goal",
  "tests",
  "todos",
  "commits",
  "readme",
  "explore",
  "memory",
  "routine",
  "scaffold",
  "capabilities",
]);
export type ProjectStarterSuggestionTopic = typeof ProjectStarterSuggestionTopic.Type;

/** Where the idea came from, said on the card so a suggestion never reads as a guess. */
export const ProjectStarterSuggestionOrigin = Schema.Literals([
  "repository",
  "goal",
  "specweave",
  "common",
]);
export type ProjectStarterSuggestionOrigin = typeof ProjectStarterSuggestionOrigin.Type;

/**
 * A first task offered while a project has no threads. `prompt` is what the
 * person sends to the coordinator by choosing it, so it holds only words Studio
 * wrote: text read from the repository appears in `detail`, never in `prompt`,
 * except a plain file path (see `isPlainSourcePath` in the shared package).
 */
export const ProjectStarterSuggestion = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  topic: ProjectStarterSuggestionTopic,
  origin: ProjectStarterSuggestionOrigin,
  title: Schema.String.check(Schema.isMaxLength(80)),
  detail: Schema.String.check(Schema.isMaxLength(240)),
  prompt: Schema.String.check(Schema.isMaxLength(2_000)),
});
export type ProjectStarterSuggestion = typeof ProjectStarterSuggestion.Type;

export const ProjectStarterSuggestionsInput = Schema.Struct({ projectId: ProjectId });
export const ProjectStarterSuggestionsResult = Schema.Struct({
  suggestions: Schema.Array(ProjectStarterSuggestion),
  /** False when the project folder is missing or empty, so the ideas are general ones. */
  hasWorkspace: Schema.Boolean,
});
export type ProjectStarterSuggestionsResult = typeof ProjectStarterSuggestionsResult.Type;
