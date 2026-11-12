/**
 * The words of Environment > Repositories: one read-only list of what threads
 * can use, built on the server from the clones found in the project folder,
 * the saved entries and the ones SpecWeave lists. Pure, so the page, the
 * General tab's Use worktrees row and their tests share one wording.
 *
 * @module projectRepositoryRows
 */
import type {
  ProjectEnvironmentReadResult,
  ProjectFoundRepository,
} from "@specweave-studio/contracts";

type Read = Pick<
  ProjectEnvironmentReadResult,
  "found" | "foundMore" | "foundTruncated" | "rootIsRepository" | "redundantEntries"
>;

/** `n repositories`, `1 repository`. */
export const repositoriesCount = (count: number) =>
  `${count} ${count === 1 ? "repository" : "repositories"}`;

/** The rows a thread can get a worktree of now. */
export const availableRows = (found: ReadonlyArray<ProjectFoundRepository>) =>
  found.filter((row) => row.state === "available");

/** How many Git repositories the folder holds, with the ones past the listed 50. */
export function folderRepositoryCount(read: Read): number {
  return availableRows(read.found ?? []).length + (read.foundMore ?? 0);
}

/**
 * The lead line over the list. A project that is one repository with nothing
 * inside says so and shows nothing else; a folder with none says that.
 */
export function repositoriesLead(read: Read): string {
  const rows = read.found ?? [];
  const count = folderRepositoryCount(read);
  if (rows.length === 0 && count === 0)
    return read.rootIsRepository === true
      ? "This project is one Git repository: the project folder."
      : "This folder holds no Git repository.";
  const more = read.foundTruncated === true ? " or more" : "";
  return `This folder holds ${count}${more} Git ${count === 1 ? "repository" : "repositories"}. Threads can use any of them. The agent picks the ones a task changes, and the thread gets its own worktree of only those.`;
}

/** What the Use worktrees switch acts on, for the General tab's row. */
export function worktreesCutFrom(read: Read): string {
  const count = folderRepositoryCount(read);
  if (count > 0)
    return count === 1
      ? "Worktrees are cut from the repository in this folder."
      : `Worktrees are cut from the ${count} repositories in this folder.`;
  return read.rootIsRepository === true
    ? "Worktrees are cut from this folder's repository."
    : "This folder holds no Git repository, so threads work in the folder.";
}

export interface RepositoryRowStatus {
  readonly label: "Available" | "Not on this machine" | "Folder missing";
  readonly tone: "ok" | "warn";
  /** Said beside the label, such as why no pull request can be opened. */
  readonly note: string | null;
  readonly actions: ReadonlyArray<"details" | "clone" | "clone_again" | "remove">;
}

export function repositoryRowStatus(row: ProjectFoundRepository): RepositoryRowStatus {
  if (row.state === "available")
    return {
      label: "Available",
      tone: "ok",
      note: row.noRemote ? "no remote, so no pull request" : null,
      // A saved entry outside the project folder can be taken off the project.
      actions: row.repositoryId !== undefined ? ["details", "remove"] : ["details"],
    };
  if (row.state === "absent")
    return {
      label: "Not on this machine",
      tone: "warn",
      note: null,
      actions: row.repositoryId !== undefined ? ["clone", "remove"] : ["clone"],
    };
  return { label: "Folder missing", tone: "warn", note: null, actions: ["clone_again", "remove"] };
}

/** `repositories/acme/api · acme/api · on main · 2 thread worktrees`. */
export function repositoryRowSummary(row: ProjectFoundRepository): string {
  const parts = [row.relativePath];
  if (row.origin !== null) parts.push(row.origin);
  if (row.state === "available") {
    parts.push(row.branch === null ? "no branch checked out" : `on ${row.branch}`);
    if (row.threadWorktrees > 0)
      parts.push(
        `${row.threadWorktrees} thread ${row.threadWorktrees === 1 ? "worktree" : "worktrees"}`,
      );
  }
  return parts.join(" · ");
}

/** What a "Not on this machine" row says about where Clone puts it. */
export function absentRowHint(row: ProjectFoundRepository): string {
  return row.inSpecweave
    ? `SpecWeave lists it at ${row.relativePath}. Clone puts it there.`
    : `Clone puts it at ${row.relativePath}.`;
}

/** Rows in the order the page shows them: clones first as found, then what needs cloning. */
export function orderedRows(
  found: ReadonlyArray<ProjectFoundRepository>,
): ReadonlyArray<ProjectFoundRepository> {
  const rank = { available: 0, absent: 1, missing: 2 } as const;
  return found.toSorted((left, right) => rank[left.state] - rank[right.state]);
}

/** `specweave-studio is a link to specwithcode-dev.` */
export function skippedLinkLine(link: { readonly path: string; readonly target: string | null }): {
  readonly name: string;
  readonly rest: string;
} {
  const name = link.path.split("/").at(-1) ?? link.path;
  return {
    name,
    rest:
      link.target === null
        ? "is a link to a repository outside this folder."
        : `is a link to ${link.target.split("/").at(-1) ?? link.target}.`,
  };
}

/**
 * The one line naming saved entries the list makes redundant, and its button.
 * Null when there are none. Nothing is removed without the click.
 */
export function redundantEntriesLine(
  entries: NonNullable<ProjectEnvironmentReadResult["redundantEntries"]>,
  saved: ReadonlyArray<{ readonly id: string; readonly url: string }>,
): { readonly text: string; readonly button: string; readonly ids: ReadonlyArray<string> } | null {
  const known = entries.filter((entry) => saved.some((item) => item.id === entry.repositoryId));
  if (known.length === 0) return null;
  const names = known.map((entry) => {
    const url = saved.find((item) => item.id === entry.repositoryId)!.url;
    const name =
      url
        .replace(/\/+$/u, "")
        .split(/[/:]/u)
        .at(-1)
        ?.replace(/\.git$/iu, "") ?? url;
    return `${name} (${entry.reason === "no_folder" ? "no folder" : "its folder is in the list"})`;
  });
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  return {
    text: `${known.length} saved ${known.length === 1 ? "entry" : "entries"} from before ${known.length === 1 ? "is" : "are"} no longer needed: ${list}.`,
    button:
      known.length === 1
        ? "Remove"
        : known.length === 2
          ? "Remove both"
          : `Remove all ${known.length}`,
    ids: known.map((entry) => entry.repositoryId),
  };
}

/** Whether `folder` is the project folder or inside it, on either path separator. */
export function insideProjectFolder(projectFolder: string, folder: string): boolean {
  const base = projectFolder.replace(/[\\/]+$/u, "");
  return folder === base || folder.startsWith(`${base}/`) || folder.startsWith(`${base}\\`);
}

/**
 * Where a new clone goes by default: `repositories/<owner>/<name>` when the
 * folder already keeps its clones that way, else `<name>`. Empty for a URL
 * that names no repository.
 */
export function defaultCloneFolder(
  url: string,
  found: ReadonlyArray<ProjectFoundRepository>,
): string {
  const parts = url
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split(/[/:]/u)
    .filter(Boolean);
  const name = parts.at(-1);
  const owner = parts.at(-2);
  if (name === undefined || owner === undefined || !/^[\w.-]+$/u.test(name)) return "";
  const umbrella =
    found.length > 0 && found.every((row) => row.relativePath.startsWith("repositories/"));
  return umbrella && /^[\w.-]+$/u.test(owner) ? `repositories/${owner}/${name}` : name;
}

/** A typed folder as an absolute path: inside the project folder unless it is a full path. */
export function resolveCloneFolder(projectFolder: string, folder: string): string {
  const value = folder.trim();
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value)) return value;
  const windows = /^[A-Za-z]:\\|^\\\\/u.test(projectFolder);
  const separator = windows ? "\\" : "/";
  const base = projectFolder.replace(/[\\/]+$/u, "");
  const relative = value.replace(/^\.[\\/]/u, "").replace(/[\\/]+/gu, separator);
  return `${base}${separator}${relative}`;
}

/** Why a typed folder cannot hold a new clone, or null when it can. */
export function cloneFolderError(folder: string): string | null {
  const value = folder.trim();
  if (value === "") return "Name the folder the clone goes in.";
  if (value.startsWith("~"))
    return "Use a full path or a folder inside the project folder; ~ is not expanded here.";
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^git@/iu.test(value))
    return "This is a folder, not a URL.";
  if (value.split(/[\\/]/u).includes("..")) return 'The folder cannot leave its parent with "..".';
  return null;
}

/** The one line an older server's page shows instead of the list. */
export const olderServerLine = (machine: string) =>
  `Update SpecWithCode on ${machine} to find the repositories in this folder.`;

/** What the page says under the list while the project's Use worktrees switch is off. */
export const WORKTREES_OFF_LINE =
  "Use worktrees is off for this project, so threads work in the project folder.";
