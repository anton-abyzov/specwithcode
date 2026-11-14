import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
  type SourceControlInspectDestinationResult,
} from "@specweave-studio/contracts";
import { alternateFolder, existingCopyOn } from "@specweave-studio/shared/existingCopy";
import { isArchivedMember } from "./projectListVisibility";
import { isProjectFolder } from "./projectMachineFolders";

/**
 * Run on → Add to another machine: which machines already have a project, which
 * can take it, where a clone goes and what an existing folder there means.
 * Copies are matched by `existingCopyOn`: linked first, then one project of the same
 * repository at the same place in it; never by folder or project name.
 */

export type CloneProtocol = "ssh" | "https";

export interface CloneUrls {
  /** Null when the remote is not on a host/owner/repo forge (a local path, a bare server). */
  readonly ssh: string | null;
  readonly https: string | null;
  /** The checkout's own remote URL (a fork's origin), used as is when neither form applies. */
  readonly raw: string;
  /** The form the source checkout itself uses. */
  readonly preferred: CloneProtocol | null;
}

const SSH_REMOTE = /^(?:ssh:\/\/)?[^@/\s]+@[^:/\s]+[:/]/u;

/** The URLs the destination can clone the project's repository from. */
export function cloneUrlsFor(identity: RepositoryIdentity): CloneUrls {
  // A fork's checkout reports its upstream as the locator; the copy clones the fork.
  const raw = identity.origin?.remoteUrl ?? identity.locator.remoteUrl;
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

export { alternateFolder, defaultDestinationFolder } from "@specweave-studio/shared/existingCopy";

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

/** A copy Run on may use: not archived, a real project folder, not the personal assistant. */
export const usableCopy = (project: EnvironmentProject) =>
  !isArchivedMember(project) &&
  isProjectFolder(project.workspaceRoot, project.id) &&
  project.workspaceSettings?.kind !== "personal";

export interface RunOnMachineGroups {
  /** Machines with a copy of this logical project, the active one included. */
  readonly withProject: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly project: EnvironmentProject;
  }>;
  /**
   * Machines without it. `copy` is the one unlinked project there of the same repository at
   * the same place in it; `candidates` lists them when several match, for the person to pick.
   */
  readonly addable: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly copy: EnvironmentProject | null;
    readonly candidates: readonly EnvironmentProject[];
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
  const withProject: Array<RunOnMachineGroups["withProject"][number]> = [];
  const addable: Array<RunOnMachineGroups["addable"][number]> = [];
  // A personal assistant runs only on its own machine, and is never copied to another.
  if (input.active.workspaceSettings?.kind === "personal")
    return {
      withProject: [{ environmentId: input.active.environmentId, project: input.active }],
      addable: [],
    };
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
    const found = existingCopyOn({ source: input.active, candidates: here });
    addable.push({
      environmentId,
      copy: found.kind === "same-repository" || found.kind === "linked" ? found.copy : null,
      candidates: found.kind === "several" ? found.copies : [],
    });
  }
  return { withProject, addable };
}

/**
 * How Add to another machine puts a project on a machine without a copy: a clone
 * from its Git remote, or, with no remote to clone from, the folder copy review
 * the project menu opens (Review files to transfer).
 */
export function addToMachineRoute(project: {
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}): "clone" | "copy" {
  return project.repositoryIdentity ? "clone" : "copy";
}

/** The line next to a machine Add can put the project on, by route. */
export const ADD_ROUTE_TEXT = {
  clone: "Clone it there",
  copy: "Copy its folder there",
} as const;

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
