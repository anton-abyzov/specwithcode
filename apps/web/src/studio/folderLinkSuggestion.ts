import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  compareFingerprints,
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type RepositoryFingerprint,
} from "@specweave-studio/contracts";
import { isProjectFolder } from "./projectMachineFolders";
import { isArchivedMember } from "./projectListVisibility";
import {
  fingerprintSummary,
  looksLikeSameProject,
  rankCandidates,
  type LinkCandidate,
} from "./projectLink";

/**
 * Add folder: recognise a folder that is already a copy of a project on another
 * machine and suggest linking it. Resemblance only suggests; nothing links or
 * clones without a click.
 */

/** Projects fingerprinted per machine, and how many calls run at once. */
export const FOLDER_COPY_PROJECTS_PER_MACHINE = 6;
export const FOLDER_COPY_CONCURRENCY = 4;
/** A big umbrella folder takes seconds to scan; a stuck machine must not hold up the add. */
export const FOLDER_SCAN_TIMEOUT_MS = 15_000;
export const COPY_SCAN_TIMEOUT_MS = 10_000;

export interface FolderCopyMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** `capabilities.projectLink`; absent on servers that predate linking. */
  readonly supportsLink: boolean | undefined;
}

/** Where a repository missing here can be cloned from. */
export type CloneSource =
  | { readonly provider: "github" | "gitlab"; readonly repository: string }
  | { readonly remoteUrl: string };

export interface MissingRepository {
  /** Relative to the folder, forward slashes. */
  readonly path: string;
  readonly originKey: string | null;
  /** Absolute clone target under the new folder. */
  readonly destination: string;
  /** Null when there is no origin to clone from. */
  readonly clone: CloneSource | null;
}

export interface FolderCopyMatch {
  readonly candidate: LinkCandidate;
  readonly machine: string;
  readonly missing: ReadonlyArray<MissingRepository>;
}

export interface FolderToAdd {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly title: string;
}

const groupingKey = (project: Pick<EnvironmentProject, "repositoryIdentity">) =>
  project.repositoryIdentity ? repositoryGroupingKeyOf(project.repositoryIdentity) : null;

/** Other machines that can take part in a link. */
export function linkableMachines(
  machines: ReadonlyArray<FolderCopyMachine>,
  here: EnvironmentId,
): FolderCopyMachine[] {
  return machines.filter(
    (machine) =>
      machine.environmentId !== here && machine.connected && machine.supportsLink === true,
  );
}

/**
 * The projects worth a fingerprint: on a linkable machine, a code project, and
 * either tracking one of the folder's repositories or named like it. The same
 * repository ranks first; at most `limit` per machine.
 */
export function folderCopyTargets(input: {
  readonly folder: FolderToAdd;
  readonly fingerprint: RepositoryFingerprint;
  readonly machines: ReadonlyArray<FolderCopyMachine>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly limit?: number;
}): EnvironmentProject[] {
  const limit = input.limit ?? FOLDER_COPY_PROJECTS_PER_MACHINE;
  const origins = new Set(
    input.fingerprint.repositories.flatMap((entry) =>
      entry.originKey === null ? [] : [entry.originKey.toLowerCase()],
    ),
  );
  const here = {
    title: input.folder.title,
    repositoryIdentity: null,
    workspaceRoot: input.folder.workspaceRoot,
  };
  return linkableMachines(input.machines, input.folder.environmentId).flatMap((machine) =>
    input.projects
      .filter(
        (project) =>
          project.environmentId === machine.environmentId &&
          project.workspaceSettings?.kind !== "personal" &&
          !isArchivedMember(project) &&
          isProjectFolder(project.workspaceRoot, project.id),
      )
      .map((project) => {
        const key = groupingKey(project)?.toLowerCase() ?? null;
        const priority =
          key !== null && origins.has(key)
            ? 0
            : looksLikeSameProject(here, project, groupingKey)
              ? 1
              : null;
        return { project, priority };
      })
      .filter(
        (item): item is { project: EnvironmentProject; priority: number } => item.priority !== null,
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          b.project.updatedAt.localeCompare(a.project.updatedAt) ||
          a.project.id.localeCompare(b.project.id),
      )
      .slice(0, limit)
      .map((item) => item.project),
  );
}

/** `github.com/team/repo` → the provider lookup the app clones with, or an HTTPS URL. */
export function cloneSourceOf(originKey: string | null): CloneSource | null {
  if (originKey === null || originKey.startsWith("file://")) return null;
  const [host, ...rest] = originKey.split("/");
  const repository = rest.join("/");
  if (!host || repository.length === 0) return null;
  if (host === "github.com" && rest.length === 2) return { provider: "github", repository };
  if (host === "gitlab.com") return { provider: "gitlab", repository };
  return { remoteUrl: `https://${originKey}.git` };
}

/** Joins a fingerprint path onto the folder, in the folder's own separator. */
export function folderPath(root: string, relative: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/u, "");
  return relative.length === 0 ? base : `${base}${separator}${relative.split("/").join(separator)}`;
}

/** Copies whose root repository matches, best first, each with what this folder lacks. */
export function folderCopyMatches(input: {
  readonly folder: FolderToAdd;
  readonly fingerprint: RepositoryFingerprint;
  readonly copies: ReadonlyArray<{
    readonly project: EnvironmentProject;
    readonly fingerprint: RepositoryFingerprint;
  }>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
}): FolderCopyMatch[] {
  const compared = input.copies.map((copy) => {
    const result = fingerprintSummary(input.fingerprint, copy.fingerprint);
    return { copy, result };
  });
  const candidates = rankCandidates(
    compared
      .filter(({ result }) => result.rootMatches)
      .map(({ copy, result }) => ({
        project: copy.project,
        score: result.score,
        rootMatches: result.rootMatches,
        summary: result.summary,
      })),
  );
  return candidates.map((candidate) => {
    const copy = compared.find(({ copy }) => copy.project === candidate.project)!.copy;
    return {
      candidate,
      machine: input.machineLabel(candidate.project.environmentId),
      missing: missingRepositories(input.fingerprint, copy.fingerprint, input.folder.workspaceRoot),
    };
  });
}

/** Matches the "missing here" count in the summary: the same comparison lists them. */
function missingRepositories(
  here: RepositoryFingerprint,
  there: RepositoryFingerprint,
  workspaceRoot: string,
): MissingRepository[] {
  const occupied = new Set(here.repositories.map((entry) => entry.path));
  return compareFingerprints(here, there)
    .missingHere.map((entry) => ({
      path: entry.path,
      originKey: entry.originKey,
      destination: folderPath(workspaceRoot, entry.path),
      // Never clone over a repository that already sits at that path.
      clone: occupied.has(entry.path) ? null : cloneSourceOf(entry.originKey),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolves null when `promise` fails or takes longer than `ms`. */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Runs `run` over `items`, at most `concurrency` at a time, in input order. */
export async function mapLimited<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export type FingerprintReader = (
  environmentId: EnvironmentId,
  input: { readonly projectId: EnvironmentProject["id"] } | { readonly workspaceRoot: string },
) => Promise<RepositoryFingerprint | null>;

/**
 * Fingerprints the folder, then likely copies on other machines, and returns the
 * ones that match at the root. Any failure or slow machine is left out; with no
 * linkable machine it returns at once without scanning.
 */
export async function findFolderCopies(input: {
  readonly folder: FolderToAdd;
  readonly machines: ReadonlyArray<FolderCopyMachine>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly read: FingerprintReader;
}): Promise<FolderCopyMatch[]> {
  const machines = linkableMachines(input.machines, input.folder.environmentId);
  if (machines.length === 0) return [];
  const here = await settleWithin(
    input.read(input.folder.environmentId, { workspaceRoot: input.folder.workspaceRoot }),
    FOLDER_SCAN_TIMEOUT_MS,
  );
  if (here === null || here.repositories.length === 0) return [];
  const targets = folderCopyTargets({
    folder: input.folder,
    fingerprint: here,
    machines,
    projects: input.projects,
  });
  const copies = await mapLimited(targets, FOLDER_COPY_CONCURRENCY, async (project) => {
    const fingerprint = await settleWithin(
      input.read(project.environmentId, { projectId: project.id }),
      COPY_SCAN_TIMEOUT_MS,
    );
    return fingerprint === null ? [] : [{ project, fingerprint }];
  });
  return folderCopyMatches({
    folder: input.folder,
    fingerprint: here,
    copies: copies.flat(),
    machineLabel: (environmentId) =>
      machines.find((machine) => machine.environmentId === environmentId)?.label ?? "Machine",
  });
}
