import { newProjectFolderName } from "@specweave-studio/shared/path";

/** The folder above `path`, or null at a root. Avoids showing `…/Alpha/../`. */
export function parentFolderOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  if (cut === 0) return trimmed.length > 1 ? "/" : null;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

export const withSeparator = (path: string) => (/[\\/]$/.test(path) ? path : `${path}/`);

const trimmedPath = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

/** Same folder, whatever the trailing separator. */
export const sameFolder = (left: string, right: string) => trimmedPath(left) === trimmedPath(right);

const baseName = (path: string) => trimmedPath(path).split(/[\\/]/).pop() ?? path;

export interface PathCrumb {
  readonly label: string;
  readonly path: string;
}

/**
 * One crumb per folder from the root to `path`. Folders under the machine's
 * home start at a single "Home" crumb, so the account name is not repeated.
 */
export function pathCrumbs(path: string, homePath: string | null): PathCrumb[] {
  const full = trimmedPath(path);
  const home = homePath === null ? null : trimmedPath(homePath);
  const crumbs: PathCrumb[] = [];
  let cursor: string | null = full;
  while (cursor !== null) {
    if (home !== null && cursor === home) {
      crumbs.unshift({ label: "Home", path: cursor });
      return crumbs;
    }
    const parent = parentFolderOf(cursor);
    crumbs.unshift({ label: parent === null ? cursor : baseName(cursor), path: cursor });
    cursor = parent;
  }
  return crumbs;
}

/**
 * Keeps the first crumb and the last `tail`, with the folders between them
 * handed back separately for a menu, so a deep path fits on one line.
 */
export function collapseCrumbs(
  crumbs: readonly PathCrumb[],
  tail = 2,
): {
  readonly head: readonly PathCrumb[];
  readonly hidden: readonly PathCrumb[];
  readonly tail: readonly PathCrumb[];
} {
  if (crumbs.length <= tail + 2) return { head: crumbs, hidden: [], tail: [] };
  return {
    head: crumbs.slice(0, 1),
    hidden: crumbs.slice(1, crumbs.length - tail),
    tail: crumbs.slice(crumbs.length - tail),
  };
}

/** `~/Projects/x` for a folder under home, the path itself otherwise. */
export function displayPath(path: string, homePath: string | null): string {
  if (homePath === null) return path;
  const home = trimmedPath(homePath);
  if (path === home) return "~";
  return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * The row typed letters jump to: the next name starting with `typed` after
 * `from`, wrapping around. A repeated single letter cycles through its matches.
 */
export function typeAheadIndex(names: readonly string[], typed: string, from: number): number {
  const needle = typed.toLowerCase();
  if (needle.length === 0 || names.length === 0) return -1;
  const cycling = needle.length > 1 && [...needle].every((letter) => letter === needle[0]);
  const prefix = cycling ? needle[0]! : needle;
  const start = cycling || needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < names.length; step += 1) {
    const index = (start + step + names.length) % names.length;
    if (names[index]!.toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}

export interface KnownProject {
  readonly workspaceRoot: string;
  readonly title: string;
}

/** The project whose folder this is, if any. */
export function projectAt(
  folder: string,
  projects: readonly KnownProject[],
): KnownProject | undefined {
  return projects.find((project) => sameFolder(project.workspaceRoot, folder));
}

export interface FolderOutcome {
  /** `create`: a new subfolder is made. `use`: an existing folder becomes the project. */
  readonly kind: "create" | "use";
  readonly path: string;
  readonly note: string | null;
}

/**
 * What creating a project named `name` does in `folder`, mirroring the
 * server: a folder that already is a project (it holds a repository or
 * SpecWeave, or is named like the project and holds files) is used as it is,
 * as is a child of that name that is one; an empty folder named like the
 * project is filled as a new one; otherwise a new subfolder is made, numbered when the
 * plain name is taken.
 */
export function folderOutcome(input: {
  readonly folder: string;
  readonly name: string;
  readonly entries: ReadonlyArray<{ readonly name: string; readonly kind?: string | undefined }>;
}): FolderOutcome | null {
  if (input.name.trim().length === 0) return null;
  const slug = newProjectFolderName(input.name);
  const folder = trimmedPath(input.folder);
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  const join = (child: string) =>
    folder.endsWith(separator) ? `${folder}${child}` : `${folder}${separator}${child}`;
  const holds = (child: string) => input.entries.some((entry) => entry.name === child);
  if (holds(".git") || holds(".specweave")) {
    return {
      kind: "use",
      path: folder,
      note: holds(".git") ? "It is already a Git repository." : "It already uses SpecWeave.",
    };
  }
  if (newProjectFolderName(baseName(folder)) === slug) {
    // The listing holds folders only, so whether it is empty is the server's call.
    return {
      kind: "use",
      path: folder,
      note:
        input.entries.length === 0
          ? "Its name matches the project. If it is empty, the new project is set up in it."
          : "Its name matches the project.",
    };
  }
  const child = input.entries.find((entry) => entry.name === slug);
  if (child?.kind === "git") {
    return { kind: "use", path: join(slug), note: "It is already a Git repository." };
  }
  if (child !== undefined) {
    let attempt = 2;
    while (holds(`${slug}-${attempt}`)) attempt += 1;
    return {
      kind: "create",
      path: join(`${slug}-${attempt}`),
      note: `A folder named ${slug} is already here.`,
    };
  }
  return { kind: "create", path: join(slug), note: null };
}

/** The server's own answer for the browsed folder (`filesystem.browse` with a project name). */
export interface ServerFolderOutcome {
  readonly kind: "creates" | "uses";
  readonly path: string;
  readonly because?:
    | "repository"
    | "specweave"
    | "named_like_project"
    | "empty_named_like_project"
    | "name_taken"
    | undefined;
}

/**
 * The footer's outcome from the server's decision, which knows what a listing
 * of folders cannot: a `.git` file, a child's `.specweave`, a child past the
 * marked entries, an empty folder. `slug` names the taken folder.
 */
export function outcomeFromServer(outcome: ServerFolderOutcome, slug: string): FolderOutcome {
  const note =
    outcome.because === "repository"
      ? "It is already a Git repository."
      : outcome.because === "specweave"
        ? "It already uses SpecWeave."
        : outcome.because === "named_like_project"
          ? "Its name matches the project."
          : outcome.because === "empty_named_like_project"
            ? "Its name matches the project and it is empty, so the new project is set up in it."
            : outcome.because === "name_taken"
              ? `A folder named ${slug} is already here.`
              : null;
  return { kind: outcome.kind === "creates" ? "create" : "use", path: outcome.path, note };
}

/**
 * Folders that already hold projects on a machine, newest first, for the
 * Recent places. `skip` drops places listed elsewhere and app-managed storage.
 */
export function recentParents(
  projectRoots: readonly string[],
  skip: readonly string[],
  limit = 3,
): string[] {
  const seen = new Set(skip.map(trimmedPath));
  const parents: string[] = [];
  for (const root of projectRoots.toReversed()) {
    const parent = parentFolderOf(root);
    if (parent === null || seen.has(trimmedPath(parent))) continue;
    if (/[\\/]\.[^\\/]+([\\/]|$)/.test(parent)) continue;
    seen.add(trimmedPath(parent));
    parents.push(parent);
    if (parents.length === limit) break;
  }
  return parents;
}

export interface FolderPlace {
  readonly kind: "projects" | "home" | "recent";
  readonly label: string;
  readonly path: string;
}

/**
 * Places offered beside the folder list: the machine's projects folder, home,
 * then recent folders. With `recent` (folders confirmed in an address bar,
 * newest first) the Recent list holds up to five: those, then the folders the
 * existing projects sit in.
 */
export function projectPlaces(input: {
  readonly projectsFolder: string | null;
  readonly projectRoots: readonly string[];
  readonly recent?: readonly string[];
}): FolderPlace[] {
  const places: FolderPlace[] = [];
  if (input.projectsFolder !== null) {
    places.push({
      kind: "projects",
      label: baseName(input.projectsFolder),
      path: input.projectsFolder,
    });
  }
  places.push({ kind: "home", label: "Home", path: "~/" });
  const skip = input.projectsFolder === null ? [] : [input.projectsFolder];
  if (input.recent === undefined) {
    for (const parent of recentParents(input.projectRoots, skip)) {
      places.push({ kind: "recent", label: baseName(parent), path: parent });
    }
    return places;
  }
  const recent: string[] = [];
  for (const path of [...input.recent, ...recentParents(input.projectRoots, skip, 5)]) {
    if ([...skip, ...recent].some((taken) => sameFolder(taken, path))) continue;
    recent.push(path);
    if (recent.length === 5) break;
  }
  for (const path of recent) places.push({ kind: "recent", label: baseName(path), path });
  return places;
}
