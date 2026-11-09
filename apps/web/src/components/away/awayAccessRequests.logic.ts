import type {
  AwayAccessRequestRecord,
  AwayMissingGrantKind,
  EnvironmentId,
  ProjectId,
} from "@specweave-studio/contracts";

/** Requests still waiting for the owner, oldest first. */
export function pendingAccessRequests(
  requests: readonly AwayAccessRequestRecord[],
): AwayAccessRequestRecord[] {
  return requests
    .filter((request) => request.status === "pending")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** A project as the machine that received the request knows it. */
export interface TargetProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly deletedAt?: string | null | undefined;
  readonly workspaceSettings?:
    | {
        readonly logicalProject?:
          | {
              readonly title?: string | undefined;
              readonly members: ReadonlyArray<{
                readonly environmentId: EnvironmentId;
                readonly projectId: ProjectId;
              }>;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
}

const titleOf = (project: TargetProject) =>
  project.workspaceSettings?.logicalProject?.title ?? project.title;

/** This machine's own title for one of its projects, or null when it has no such project. */
export function targetProjectTitle(
  projects: readonly TargetProject[],
  projectId: ProjectId,
): string | null {
  const project = projects.find((entry) => entry.id === projectId && !entry.deletedAt);
  return project === undefined ? null : titleOf(project);
}

/** This machine's title for the sender's project, through the link between them. */
export function linkedProjectTitle(
  projects: readonly TargetProject[],
  from: EnvironmentId,
  senderProjectId: ProjectId,
): string | null {
  const project = projects.find(
    (entry) =>
      !entry.deletedAt &&
      (entry.workspaceSettings?.logicalProject?.members ?? []).some(
        (member) => member.environmentId === from && member.projectId === senderProjectId,
      ),
  );
  return project === undefined ? null : titleOf(project);
}

/**
 * What Approve applies here, from this machine's own data: the stored grant
 * changes, with project titles this machine resolves. Nothing the sender
 * wrote is shown as the description.
 */
export function approveChangeLines(
  request: Pick<AwayAccessRequestRecord, "changes">,
  projects: readonly TargetProject[],
): string[] {
  const lines: string[] = [];
  if (request.changes.routines === true) lines.push("Manage scheduled routines");
  const ids = request.changes.addProjectIds ?? [];
  if (ids.length > 0) {
    const titles = ids.map((id) => targetProjectTitle(projects, id) ?? "A project no longer here");
    lines.push(`Run work in ${titles.join(", ")}`);
  }
  return lines;
}

const MANUAL_STEPS: Partial<Record<AwayMissingGrantKind, string>> = {
  provider: "Sign in to a provider it needs",
  "secret-file": "Copy a file it needs into the project folder",
  "project-link": "Link a project with its copy",
  standby: "Let this machine take over a coordinator",
};

/**
 * The steps Approve does not take, in this machine's words: one line per kind
 * of step for this machine, with the project titles it knows. Steps for the
 * sender's own machine are its own to take and are left out.
 */
export function manualStepLines(
  request: Pick<AwayAccessRequestRecord, "missing" | "fromEnvironmentId">,
  projects: readonly TargetProject[],
): string[] {
  const byKind = new Map<string, Set<string>>();
  for (const item of request.missing) {
    if (item.machineEnvironmentId === request.fromEnvironmentId) continue;
    const step = MANUAL_STEPS[item.kind];
    if (step === undefined) continue;
    const titles = byKind.get(step) ?? new Set<string>();
    const title =
      item.projectId === undefined
        ? null
        : linkedProjectTitle(projects, request.fromEnvironmentId, item.projectId);
    if (title !== null) titles.add(title);
    byKind.set(step, titles);
  }
  return [...byKind.entries()].map(([step, titles]) =>
    titles.size === 0 ? step : `${step}: ${[...titles].join(", ")}`,
  );
}

/** The one line under the list: what Approve changes, or that it changes nothing. */
export function requestChangeSummary(request: Pick<AwayAccessRequestRecord, "changes">): string {
  const asks =
    request.changes.routines === true || (request.changes.addProjectIds?.length ?? 0) > 0;
  return asks ? "Approve applies these here." : "Approve changes nothing here.";
}

/** Pending requests on a machine the user has not been told about yet. */
export function unseenRequests(
  requests: readonly AwayAccessRequestRecord[],
  seen: ReadonlySet<string>,
): AwayAccessRequestRecord[] {
  return pendingAccessRequests(requests).filter((request) => !seen.has(request.requestId));
}

/** The attention line for new requests on one machine. */
export function accessRequestToastTitle(
  requests: readonly Pick<AwayAccessRequestRecord, "fromEnvironmentId">[],
  fromName: (environmentId: EnvironmentId) => string,
  machineName: string,
): string {
  const first = requests[0];
  if (first === undefined) return "";
  return requests.length === 1
    ? `${fromName(first.fromEnvironmentId)} asks to leave its work on ${machineName}`
    : `${requests.length} machines ask to leave their work on ${machineName}`;
}
