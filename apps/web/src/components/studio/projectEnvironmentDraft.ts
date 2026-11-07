import {
  projectRepositoryIdentity,
  type ProjectEnvironmentEntryRef,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";

type EnvironmentDraft = ProjectWorkspaceReadResult["settings"]["environment"];
type RepositoryDraft = EnvironmentDraft["repositories"][number];

/** POSIX, drive-letter and UNC roots. The host re-checks every path on save. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
/** Anything that reads as a remote address rather than a folder. */
const LOOKS_LIKE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@[^:/\s]+:)/iu;

export interface CheckoutPathError {
  readonly message: string;
  /** A valid repository URL typed where the folder belongs, offered as the entry's URL. */
  readonly url?: string;
}

/** Why a checkout path cannot be saved as typed, or null when it can (empty means managed). */
export function checkoutPathError(localPath: string | null): CheckoutPathError | null {
  const value = localPath?.trim() ?? "";
  if (value === "") return null;
  if (LOOKS_LIKE_URL.test(value)) {
    return projectRepositoryIdentity(value) === null
      ? { message: "This is a folder path, not a URL." }
      : { message: "This is a folder path, not a URL.", url: value };
  }
  if (!ABSOLUTE_PATH.test(value)) {
    return {
      message: value.startsWith("~")
        ? "Use an absolute folder path; ~ is not expanded here."
        : "Use an absolute folder path.",
    };
  }
  return null;
}

/** Why `url` cannot replace entry `id`'s URL, or null when it can. */
export function repositoryUrlError(
  url: string,
  repositories: readonly RepositoryDraft[],
  id: string,
): string | null {
  const identity = projectRepositoryIdentity(url.trim());
  if (identity === null)
    return "Use a credential-free HTTPS or SSH repository URL, without a query or fragment.";
  return repositories.some(
    (repository) => repository.id !== id && projectRepositoryIdentity(repository.url) === identity,
  )
    ? "Another entry already uses this repository."
    : null;
}

/** Entries whose fields cannot be saved as typed; Save waits until they are fixed. */
export function environmentFieldErrorCount(environment: EnvironmentDraft): number {
  return environment.repositories.filter(
    (repository) => checkoutPathError(repository.localPath) !== null,
  ).length;
}

/**
 * The checkout's own origin when it differs from the entry's URL and could
 * replace it, for "Update URL to …" after a repository rename.
 */
export function originUpdateFor(
  repository: RepositoryDraft,
  observed: { readonly status: string; readonly origin?: string } | undefined,
): string | null {
  if (observed?.status !== "mismatch" || observed.origin === undefined) return null;
  const origin = projectRepositoryIdentity(observed.origin);
  return origin === null || origin === projectRepositoryIdentity(repository.url)
    ? null
    : observed.origin;
}

/** Whether a save error names this repository entry. */
export function entryMatchesRepository(
  entry: ProjectEnvironmentEntryRef | undefined,
  repositoryId: string,
): boolean {
  return entry?.kind === "repository" && entry.repositoryId === repositoryId;
}

/** Whether a save error names this approved folder. */
export function entryMatchesFolder(
  entry: ProjectEnvironmentEntryRef | undefined,
  folder: string,
): boolean {
  return entry?.kind === "folder" && entry.path === folder;
}

/** The short repository name shown on the update button: "specwithcode.git". */
export function repositoryShortName(url: string): string {
  const trimmed = url.replace(/\/+$/u, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1) || url;
}
