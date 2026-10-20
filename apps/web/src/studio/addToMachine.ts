import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import { isArchivedMember } from "./projectListVisibility";
import { isProjectFolder } from "./projectMachineFolders";

/**
 * Run on → Add to another machine: which machines already have a project, which
 * can take it, where a clone goes and what an existing folder there means.
 * Copies are matched by repository remote only, never by folder or project name.
 */

export type CloneProtocol = "ssh" | "https";

export interface CloneUrls {
  /** Null when the remote is not on a host/owner/repo forge (a local path, a bare server). */
  readonly ssh: string | null;
  readonly https: string | null;
  /** The checkout's own remote URL, used as is when neither form applies. */
  readonly raw: string;
  /** The form the source checkout itself uses. */
  readonly preferred: CloneProtocol | null;
}

const SSH_REMOTE = /^(?:ssh:\/\/)?[^@/\s]+@[^:/\s]+[:/]/u;

/** The URLs the destination can clone the project's repository from. */
export function cloneUrlsFor(identity: RepositoryIdentity): CloneUrls {
  const raw = identity.locator.remoteUrl;
  const key = repositoryGroupingKeyOf(identity).replace(/\.git$/iu, "");
  const [host, ...path] = key.split("/");
  const forge = host && host.includes(".") && path.length >= 2 && path.every(Boolean);
  const preferred: CloneProtocol | null = SSH_REMOTE.test(raw)
    ? "ssh"
    : /^https?:\/\//iu.test(raw)
      ? "https"
      : null;
  return {
    ssh: forge ? `git@${host}:${path.join("/")}.git` : null,
    https: forge ? `https://${host}/${path.join("/")}.git` : null,
    raw,
    preferred,
  };
}

export function cloneUrlFor(urls: CloneUrls, protocol: CloneProtocol | null): string {
  if (protocol === "ssh" && urls.ssh) return urls.ssh;
  if (protocol === "https" && urls.https) return urls.https;
  return urls.raw;
}

const HOME_PREFIX =
  /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/u;

/** D-03: mirror the source folder relative to home; outside home, use its name under home. */
export function defaultDestinationFolder(sourceRoot: string): string {
  const trimmed = sourceRoot.replace(/[\\/]+$/u, "");
  if (trimmed.startsWith("~/") || trimmed === "~") return trimmed || "~";
  const home = HOME_PREFIX.exec(trimmed);
  if (home) {
    const rest = trimmed.slice(home[0].length).replaceAll("\\", "/").replace(/^\/+/u, "");
    return rest ? `~/${rest}` : "~";
  }
  const name = trimmed.split(/[\\/]/u).findLast(Boolean);
  return name ? `~/${name}` : "~";
}

/** `<path>-2`, or the next number when the path already ends in one. */
export function alternateFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const numbered = /^(.*)-(\d+)$/u.exec(trimmed);
  return numbered ? `${numbered[1]}-${Number(numbered[2]) + 1}` : `${trimmed}-2`;
}

export type DestinationPlan =
  | { readonly kind: "clone" }
  /** The folder is a checkout of the same repository: link it after the user agrees. */
  | { readonly kind: "consolidate" }
  | { readonly kind: "refuse"; readonly reason: string; readonly suggestion: string };

/** AC-06/AC-07: what an existing folder at the destination allows. */
export function destinationPlan(
  result: Pick<SourceControlInspectDestinationResult, "path" | "state" | "sameRepository">,
): DestinationPlan {
  switch (result.state) {
    case "missing":
    case "empty":
      return { kind: "clone" };
    case "repository":
      return result.sameRepository
        ? { kind: "consolidate" }
        : {
            kind: "refuse",
            reason: "That folder is a checkout of a different repository.",
            suggestion: alternateFolder(result.path),
          };
    case "not-repository":
      return {
        kind: "refuse",
        reason: "That folder already has files that are not this repository.",
        suggestion: alternateFolder(result.path),
      };
    case "unreadable":
      return {
        kind: "refuse",
        reason: "That path is a file or a folder this machine can't read.",
        suggestion: alternateFolder(result.path),
      };
  }
}

const repositoryKey = (project: Pick<EnvironmentProject, "repositoryIdentity">) =>
  project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()
    : null;

const usableCopy = (project: EnvironmentProject) =>
  !isArchivedMember(project) &&
  isProjectFolder(project.workspaceRoot, project.id) &&
  project.workspaceSettings?.kind !== "personal";

export interface RunOnMachineGroups {
  /** Machines with a copy of this logical project, the active one included. */
  readonly withProject: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly project: EnvironmentProject;
  }>;
  /** Machines without it; `copy` is a saved, unlinked checkout of the same repository. */
  readonly addable: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly copy: EnvironmentProject | null;
  }>;
}

/** AC-01/AC-02: group the saved machines for the Run on menu. */
export function runOnMachineGroups(input: {
  readonly active: EnvironmentProject;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly logicalKey: (project: EnvironmentProject) => string;
}): RunOnMachineGroups {
  const logical = input.logicalKey(input.active);
  const repository = repositoryKey(input.active);
  const withProject: Array<RunOnMachineGroups["withProject"][number]> = [];
  const addable: Array<RunOnMachineGroups["addable"][number]> = [];
  for (const environmentId of input.environmentIds) {
    const here = input.projects.filter(
      (project) => project.environmentId === environmentId && usableCopy(project),
    );
    const member =
      environmentId === input.active.environmentId
        ? input.active
        : here.find((project) => input.logicalKey(project) === logical);
    if (member) {
      withProject.push({ environmentId, project: member });
      continue;
    }
    const copy =
      repository === null
        ? null
        : (here.find((project) => repositoryKey(project) === repository) ?? null);
    addable.push({ environmentId, copy });
  }
  return { withProject, addable };
}

/** Folders git ignores whole stay behind; the note the dialog shows next to the tick. */
export const IGNORED_FILES_NOTE =
  "Folders Git ignores whole, such as node_modules, are left out; reinstall them there.";

/** A clone started from Run on. The job runner links it and copies the extras once it is done. */
export interface AddToMachineJob {
  readonly version: 1;
  readonly source: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  };
  readonly destination: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  };
  readonly copyIgnored: boolean;
  /** Secret-like files the user ticked, relative to the project folder. */
  readonly secrets: ReadonlyArray<string>;
  readonly createdAt: string;
}

const JOB_PREFIX = "studio:add-to-machine:v1:";

export const addToMachineJobKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${JOB_PREFIX}${JSON.stringify([environmentId, projectId])}`;

function parseJob(value: string | null): AddToMachineJob | null {
  if (value === null) return null;
  try {
    const job = JSON.parse(value) as AddToMachineJob;
    return job?.version === 1 &&
      typeof job.source?.environmentId === "string" &&
      typeof job.destination?.projectId === "string" &&
      Array.isArray(job.secrets)
      ? job
      : null;
  } catch {
    return null;
  }
}

export function readAddToMachineJob(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): AddToMachineJob | null {
  try {
    return parseJob(localStorage.getItem(addToMachineJobKey(environmentId, projectId)));
  } catch {
    return null;
  }
}

export function listAddToMachineJobs(): AddToMachineJob[] {
  const jobs: AddToMachineJob[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(JOB_PREFIX)) continue;
      const job = parseJob(localStorage.getItem(key));
      if (job) jobs.push(job);
    }
  } catch {
    /* Without storage there are no jobs to resume. */
  }
  return jobs;
}

export function writeAddToMachineJob(job: AddToMachineJob): void {
  try {
    localStorage.setItem(
      addToMachineJobKey(job.destination.environmentId, job.destination.projectId),
      JSON.stringify(job),
    );
  } catch {
    /* The clone still lands; only the follow-up link waits for the user. */
  }
}

export function clearAddToMachineJob(environmentId: EnvironmentId, projectId: ProjectId): void {
  try {
    localStorage.removeItem(addToMachineJobKey(environmentId, projectId));
  } catch {
    /* Nothing stored. */
  }
}
