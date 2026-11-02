/**
 * The project's repository list, kept as the project note `repositories.md`.
 *
 * Notes travel with a linked project: every copy keeps a read-only copy of the
 * coordinator's notes, goal and instructions, and a takeover starts from them.
 * So the list reaches every machine the project is on, even one whose folder
 * never held the repositories, and the coordinator and its workers read it
 * like any other note.
 *
 * The folder stays the source: a clone found in it is listed. A repository
 * the note names but this folder lacks stays listed, so a copy that took over
 * still knows it; deleting its line from the note drops it.
 */
import {
  type ProjectId,
  ProjectNestedRepository,
  PROJECT_NESTED_REPOSITORY_LIMIT,
  projectRepositoryIdentity,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

export const REPOSITORY_NOTE = "repositories.md";

const LIST_START = "<!-- specwithcode:repositories";
const LIST_END = "-->";

const decodeList = Schema.decodeUnknownOption(Schema.Array(ProjectNestedRepository));

/** The note's text: a table people and models read, and the list in a comment the app reads back. */
export function renderRepositoryNote(repositories: ReadonlyArray<ProjectNestedRepository>): string {
  const rows = repositories.map(
    (entry) => `| ${entry.name} | \`${entry.path}\` | ${entry.remoteUrl} |`,
  );
  return [
    "# Repositories",
    "",
    "The Git repositories this project uses, besides its own folder. SpecWithCode keeps this",
    "list from the coordinator's project folder and shares it with every machine the project",
    "is on. A machine may keep a clone anywhere in its copy; one it lacks is cloned from the",
    "remote below. Delete a line to drop a repository the folder no longer holds.",
    "",
    "| Repository | Path where it was first listed | Remote |",
    "| --- | --- | --- |",
    ...rows,
    "",
    LIST_START,
    // `>` only occurs inside strings, so escaping it keeps `-->` out of the comment.
    JSON.stringify(repositories).replaceAll(">", "\\u003e"),
    LIST_END,
    "",
  ].join("\n");
}

/** The list a note holds, or none when it was edited past reading; a deleted table row drops its entry. */
export function parseRepositoryNote(content: string): ReadonlyArray<ProjectNestedRepository> {
  const start = content.indexOf(LIST_START);
  if (start < 0) return [];
  const body = content.slice(start + LIST_START.length);
  const end = body.indexOf(LIST_END);
  if (end < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(0, end));
  } catch {
    return [];
  }
  const entries = Option.getOrElse(decodeList(parsed), () => []);
  // A row someone deleted from the table is dropped from the list too.
  const table = content.slice(0, start);
  // The note may come from another machine: only a network remote and a
  // one-line name reach a worker's brief or a clone.
  return entries.filter(
    (entry) =>
      table.includes(`\`${entry.path}\``) &&
      projectRepositoryIdentity(entry.remoteUrl) !== null &&
      !/[\u0000-\u001f\u007f`|]/u.test(entry.name),
  );
}

/**
 * The note's repositories, with any of `listed` (this folder's clones) it
 * does not name yet added after them, and the note updated when one was
 * added. An entry already in the note keeps its place and path, so linked
 * copies that keep a repository at different paths never rewrite each
 * other's note. Without the workspace service, or when the note cannot be
 * read or written, `listed` as it is.
 */
export const withRepositoryNote = Effect.fn("ProjectRepositoryNote.merge")(function* (
  projectId: ProjectId,
  listed: ReadonlyArray<ProjectNestedRepository>,
) {
  const workspace = yield* Effect.serviceOption(ProjectWorkspaceService.ProjectWorkspaceService);
  if (Option.isNone(workspace)) return listed;
  const note = yield* workspace.value
    .readMemory({ projectId, name: REPOSITORY_NOTE })
    .pipe(Effect.option);
  const noted = Option.isSome(note) ? parseRepositoryNote(note.value.content) : [];
  const keys = new Set(noted.map((entry) => entry.key));
  const paths = new Set(noted.map((entry) => entry.path));
  const added = listed.filter((entry) => !keys.has(entry.key) && !paths.has(entry.path));
  const merged = [...noted, ...added].slice(0, PROJECT_NESTED_REPOSITORY_LIMIT);
  // A project with no nested repositories gets no note.
  if (merged.length === 0 && Option.isNone(note)) return merged;
  const content = renderRepositoryNote(merged);
  if (Option.isSome(note) && note.value.content === content) return merged;
  // Written only when it names something new, or was edited past reading.
  if (Option.isSome(note) && added.length === 0 && noted.length > 0) return merged;
  yield* workspace.value
    .writeMemory({
      projectId,
      name: REPOSITORY_NOTE,
      content,
      expectedRevision: Option.isSome(note) ? note.value.revision : null,
    })
    .pipe(Effect.ignore);
  return merged;
});
