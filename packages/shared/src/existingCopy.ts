/**
 * Where a project goes on another machine, and whether that machine already has it.
 * One rule for the app and the server: the copy linked to this project first, then a
 * project of the same repository at the same place inside it, used only when exactly one
 * matches. Never by folder or project name alone.
 *
 * @module existingCopy
 */
import {
  repositoryGroupingKeyOf,
  repositoryRelativePathOf,
  type RepositoryIdentity,
} from "@specweave-studio/contracts";

/** What the detection reads of a project on either machine. */
export interface CopyCandidate {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly workspaceSettings?:
    | {
        readonly logicalProject?: { readonly id: string } | null | undefined;
      }
    | null
    | undefined;
}

export type ExistingCopy<T> =
  /** Linked to this project, or saved as its copy there. */
  | { readonly kind: "linked"; readonly copy: T }
  /** Not linked: the one project there of the same repository at the same place in it. */
  | { readonly kind: "same-repository"; readonly copy: T }
  /** Several match; the person picks one. */
  | { readonly kind: "several"; readonly copies: readonly T[] }
  | { readonly kind: "none" };

const repositoryKeyOf = (project: CopyCandidate): string | null =>
  project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()
    : null;

/** Where the project folder sits inside its repository; null when unknown. */
export const repositoryPlaceOf = (project: CopyCandidate): string | null =>
  repositoryRelativePathOf(project.workspaceRoot, project.repositoryIdentity?.rootPath);

/**
 * The same repository at the same place inside it. Both places must be known: a record
 * without its repository root could be a subfolder, so it is never the same copy.
 */
export function sameRepositoryPlace(source: CopyCandidate, candidate: CopyCandidate): boolean {
  const key = repositoryKeyOf(source);
  const place = repositoryPlaceOf(source);
  const there = repositoryPlaceOf(candidate);
  if (key === null || place === null || there === null) return false;
  return repositoryKeyOf(candidate) === key && there === place;
}

/**
 * The copy of `source` among `candidates` (the projects on one destination machine).
 * `linkedId` is the project id there that `source` already names (a logical member or a
 * saved worker project), when it names one.
 */
export function existingCopyOn<T extends CopyCandidate>(input: {
  readonly source: CopyCandidate;
  readonly candidates: readonly T[];
  readonly linkedId?: string | null | undefined;
}): ExistingCopy<T> {
  const logical = input.source.workspaceSettings?.logicalProject?.id ?? null;
  const linked = input.candidates.filter(
    (candidate) =>
      (input.linkedId != null && candidate.id === input.linkedId) ||
      (logical !== null && candidate.workspaceSettings?.logicalProject?.id === logical),
  );
  if (linked.length === 1) return { kind: "linked", copy: linked[0]! };
  if (linked.length > 1) return { kind: "several", copies: linked };
  const same = input.candidates.filter((candidate) => sameRepositoryPlace(input.source, candidate));
  if (same.length === 1) return { kind: "same-repository", copy: same[0]! };
  if (same.length > 1) return { kind: "several", copies: same };
  return { kind: "none" };
}

const HOME_PREFIX =
  /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/u;

/** The source folder's own name. */
export function folderNameOf(sourceRoot: string): string {
  return (
    sourceRoot
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .findLast(Boolean) ?? "project"
  );
}

/**
 * Where a project goes on a machine without a copy. With that machine's projects folder
 * (`suggestedProjectsRoot`), the source folder's name inside it. Without one (an older
 * machine), the same place relative to home; outside home, its name under home.
 * The folder must still be inspected there before anything is written to it.
 */
export function defaultDestinationFolder(
  sourceRoot: string,
  projectsRoot?: string | null | undefined,
): string {
  const trimmed = sourceRoot.replace(/[\\/]+$/u, "");
  if (projectsRoot) {
    const root = projectsRoot.replace(/[\\/]+$/u, "");
    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
    return `${root}${separator}${folderNameOf(trimmed)}`;
  }
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed;
  const home = HOME_PREFIX.exec(trimmed);
  if (home) {
    const rest = trimmed.slice(home[0].length).replaceAll("\\", "/").replace(/^\/+/u, "");
    if (rest) return `~/${rest}`;
  }
  return `~/${folderNameOf(trimmed)}`;
}

/** `<path>-2`, or the next number when the path already ends in one. */
export function alternateFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const numbered = /^(.*)-(\d+)$/u.exec(trimmed);
  return numbered ? `${numbered[1]}-${Number(numbered[2]) + 1}` : `${trimmed}-2`;
}
