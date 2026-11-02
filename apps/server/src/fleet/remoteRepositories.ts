/**
 * What a worker on another machine is told about the project's repositories.
 *
 * Nothing is cloned or copied for it. The list comes from the project folder
 * here (and its `repositories.md` note, which every linked copy also holds),
 * and the worker decides: it uses a clone its machine already has, wherever
 * that is, and clones one its task needs from the remote, wherever suits it.
 */
import type { Project, ProjectNestedRepository } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { listProjectRepositories } from "../project/ProjectRepositoryPresence.ts";

/** The most repositories a worker's brief names; the note holds the rest. */
const BRIEF_LIMIT = 24;

export function repositoryBrief(repositories: ReadonlyArray<ProjectNestedRepository>): string {
  const lines = repositories
    .slice(0, BRIEF_LIMIT)
    .map(
      (entry) =>
        `- ${entry.name}: ${entry.remoteUrl} (\`${entry.path}\` on the coordinator's machine)`,
    );
  const more = repositories.length - lines.length;
  return [
    "This project uses these Git repositories besides its folder (the repositories.md project note lists them all). Use a clone this machine already has, wherever it is. If your task needs one that is not here, clone it from its remote, wherever suits this machine:",
    ...lines,
    ...(more > 0 ? [`- and ${more} more in repositories.md`] : []),
  ].join("\n");
}

/** The brief for a worker of `project`, or undefined when the project uses no other repositories. */
export const remoteRepositoryBrief = Effect.fn("fleet.remoteRepositoryBrief")(function* (
  project: Pick<Project, "id" | "workspaceRoot">,
) {
  // A folder or Git problem, or a slow disk, never holds up or fails the launch.
  const listed = yield* listProjectRepositories(project).pipe(
    Effect.timeoutOption("15 seconds"),
    Effect.exit,
  );
  if (listed._tag === "Failure" || Option.isNone(listed.value)) return undefined;
  const repositories = listed.value.value.repositories;
  return repositories.length === 0 ? undefined : repositoryBrief(repositories);
});
