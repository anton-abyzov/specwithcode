// @effect-diagnostics nodeBuiltinImport:off - Pure path checks on saved locations.
/**
 * The project's locations as agents read them in the environment section of
 * the project context: one repository list, what Use worktrees does here, and
 * nothing the folder already covers. Saved settings are never changed; only
 * what agents read is folded.
 *
 * @module projectEnvironmentContext
 */
import type { ProjectEnvironmentSettings } from "@specweave-studio/contracts";
import * as NodePath from "node:path";

import { stringifyJson } from "../json.ts";
import { boundProjectContext } from "./ProjectContextSnapshot.ts";
import {
  availableRepositories,
  type ProjectRepositoryDiscovery,
} from "./ProjectRepositoryDiscovery.ts";

const LOCATIONS_LIMIT = 4096;

const inside = (root: string, folder: string) => {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(folder));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** What a new thread gets here, or null when that is not known on this machine. */
export function worktreeSwitchLine(input: {
  readonly discovery: ProjectRepositoryDiscovery | null;
  /** The project's Use worktrees switch; null when settings could not be read. */
  readonly usesWorktrees: boolean | null;
}): string | null {
  const { discovery } = input;
  // A launch here has nothing to cut a worktree from, whatever the switch says.
  if (discovery !== null && !discovery.rootIsRepository && !discovery.separateClones)
    return discovery.kind === "plain"
      ? "This folder holds no Git repository, so threads work in the folder."
      : "The project folder is not a Git repository and holds no clone of its own, so threads work in the folder.";
  if (input.usesWorktrees === null || discovery === null) return null;
  if (!input.usesWorktrees)
    return "Use worktrees is off for this project: threads work in the project folder, on whatever branch is checked out there.";
  return discovery.separateClones
    ? "Use worktrees is on for this project: a new thread gets its own folder with a worktree of each repository its task names by path, and adds others with studio_worktree_add_repository."
    : "Use worktrees is on for this project: a new thread gets its own worktree of the project folder's repository.";
}

/** The found repositories as lines: name, relative path, origin, branch, and a saved id when there is one. */
export function repositoryContextLines(discovery: ProjectRepositoryDiscovery | null): string {
  const available = availableRepositories(discovery);
  if (available.length === 0) return "";
  const lines = available.map(
    (repository) =>
      `- ${repository.name}: ${repository.relativePath} (${repository.origin ?? "no remote, so no pull request"}, ${
        repository.branch === null ? "no branch checked out" : `on ${repository.branch}`
      }${repository.repositoryId === undefined ? "" : `, saved as ${repository.repositoryId}`})`,
  );
  const more = discovery?.foundMore ?? 0;
  return more > 0 ? `${lines.join("\n")}\nand ${more} more` : lines.join("\n");
}

/**
 * The environment section's body after its fixed preamble: the saved
 * locations as JSON without the entries the folder already covers (1276's
 * redundant entries and approved folders inside the project folder), the
 * Use worktrees line, then the repositories found in the folder.
 */
export function projectEnvironmentContext(input: {
  readonly kind: string;
  readonly workspaceRoot: string;
  readonly environment: ProjectEnvironmentSettings;
  readonly discovery: ProjectRepositoryDiscovery | null;
  readonly usesWorktrees: boolean | null;
}): string {
  const redundant = new Set(
    (input.discovery?.redundantEntries ?? []).map((entry) => entry.repositoryId),
  );
  const locations = stringifyJson({
    kind: input.kind,
    workspaceRoot: input.workspaceRoot,
    ...input.environment,
    additionalFolders: input.environment.additionalFolders.filter(
      (folder) => !inside(input.workspaceRoot, folder),
    ),
    repositories: input.environment.repositories.filter(
      (repository) => !redundant.has(repository.id),
    ),
  });
  const bounded =
    locations.length <= LOCATIONS_LIMIT
      ? locations
      : `${boundProjectContext(locations, LOCATIONS_LIMIT)}\n[Location list truncated. Read project settings for the full list.]`;
  const switchLine = worktreeSwitchLine(input);
  const lines = repositoryContextLines(input.discovery);
  return [
    bounded,
    ...(switchLine === null ? [] : [switchLine]),
    ...(lines === ""
      ? []
      : [
          `Repositories in the project folder, available to every thread with nothing to register (name: path relative to the project folder, origin, checked-out branch). Name one by its path in a launch's repository or repositories, or in studio_worktree_add_repository:\n${lines}`,
        ]),
  ].join("\n");
}
