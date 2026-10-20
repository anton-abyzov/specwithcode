import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { projectThreads } from "./projectWorkspaceModel";
import { isOrchestratorThreadId } from "./projectCoordinatorThreads";
import { modelLabel, shortMachineName, type ProviderNameSource } from "./shellModel";
import { isNestedSubagentThread } from "./threadSubagents";

export interface ProjectExecutionScope {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  coordinatorThreadId: ThreadId | null;
}

/** Domain membership is explicit. Repository grouping alone never joins conversations. */
export function projectExecutionScopes(
  project: EnvironmentProject,
  members: readonly EnvironmentProject[],
): ProjectExecutionScope[] {
  const domain = project.workspaceSettings?.logicalProject;
  if (!domain)
    return [
      {
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId: project.workspaceSettings?.coordinatorThreadId ?? null,
      },
    ];
  const refs = new Map<string, ProjectExecutionScope>();
  for (const member of members) {
    const identity = member.workspaceSettings?.logicalProject;
    if (identity?.id !== domain.id) continue;
    for (const ref of identity.members) refs.set(`${ref.environmentId}:${ref.projectId}`, ref);
  }
  for (const ref of domain.members) refs.set(`${ref.environmentId}:${ref.projectId}`, ref);
  refs.set(`${project.environmentId}:${project.id}`, {
    environmentId: project.environmentId,
    projectId: project.id,
    coordinatorThreadId:
      project.workspaceSettings?.coordinatorThreadId ??
      refs.get(`${project.environmentId}:${project.id}`)?.coordinatorThreadId ??
      null,
  });
  return [...refs.values()];
}

export interface LogicalCoordinators<T> {
  /** Every copy that coordinates now: newest epoch first, then by machine. */
  readonly coordinators: readonly T[];
  /** Copies mid-handoff that nothing has superseded yet. */
  readonly pending: readonly T[];
  /** Active copies a newer coordinator took over from; each gives way once reachable. */
  readonly superseded: readonly T[];
  /** Coordinators that a successor took over from at the same epoch, and that successor: an unresolved claim. */
  readonly contested: readonly T[];
}

const memberKey = (member: EnvironmentProject) => `${member.environmentId}:${member.id}`;
const bindingOf = (member: EnvironmentProject) => member.workspaceSettings?.coordinatorBinding;

/**
 * The coordinators of a linked project. Each machine may run its own (0969), so
 * several active copies are not a conflict; only a copy whose exact ancestor
 * took over again is superseded. A copy never becomes a coordinator by election:
 * its own server records the binding.
 */
export function logicalCoordinators<T extends EnvironmentProject>(
  members: readonly T[],
): LogicalCoordinators<T> | null {
  const declared = members.filter((member) => member.workspaceSettings?.logicalProject);
  if (!declared.length) return null;
  const byKey = new Map(declared.map((member) => [memberKey(member), member]));
  const epochOf = (member: T) => bindingOf(member)?.epoch ?? 0;
  const superseded = new Set<string>();
  const contested = new Set<string>();
  for (const member of declared) {
    if (bindingOf(member)?.state !== "active") continue;
    const seen = new Set<string>([memberKey(member)]);
    let predecessor = bindingOf(member)?.predecessor;
    while (predecessor) {
      const key = `${predecessor.environmentId}:${predecessor.projectId}`;
      if (seen.has(key)) break;
      seen.add(key);
      const ancestor = byKey.get(key);
      if (!ancestor) break;
      if (epochOf(ancestor) < epochOf(member)) superseded.add(key);
      else if (
        epochOf(ancestor) === epochOf(member) &&
        bindingOf(ancestor)?.state === "active" &&
        bindingOf(member)?.predecessor?.environmentId === predecessor.environmentId &&
        bindingOf(member)?.predecessor?.projectId === predecessor.projectId
      ) {
        contested.add(key);
        contested.add(memberKey(member));
      }
      predecessor = bindingOf(ancestor)?.predecessor;
    }
  }
  const order = (a: T, b: T) => epochOf(b) - epochOf(a) || memberKey(a).localeCompare(memberKey(b));
  const live = (member: T) => !superseded.has(memberKey(member));
  return {
    coordinators: declared
      .filter((member) => bindingOf(member)?.state === "active" && live(member))
      .toSorted(order),
    pending: declared
      .filter((member) => bindingOf(member)?.state === "transferring" && live(member))
      .toSorted(order),
    superseded: declared
      .filter((member) => bindingOf(member)?.state === "active" && !live(member))
      .toSorted(order),
    contested: declared.filter((member) => contested.has(memberKey(member))).toSorted(order),
  };
}

export const COORDINATOR_PENDING_PROBLEM =
  "Coordinator handoff is pending. Reconnect the source and destination to confirm the transfer.";
export const COORDINATOR_CONTESTED_PROBLEM =
  "Two coordinators claim the same epoch, one as the other's successor. Renaming waits until that claim is settled.";
export const COORDINATOR_UNAVAILABLE_PROBLEM =
  "The active coordinator is unavailable. Reconnect its machine; the project will not switch automatically.";

/**
 * One coordinator to name for the project as a whole (settings, renames,
 * replication source): the newest one. Each machine's own coordinator still
 * takes its own messages; see `logicalCoordinators`.
 */
export function logicalCoordinator<T extends EnvironmentProject>(
  members: readonly T[],
): { member?: T; problem: string | null } | null {
  const found = logicalCoordinators(members);
  if (!found) return null;
  const first = found.coordinators[0];
  if (first)
    return {
      member: first,
      problem: found.contested.includes(first) ? COORDINATOR_CONTESTED_PROBLEM : null,
    };
  const pending = found.pending[0];
  if (pending) return { member: pending, problem: COORDINATOR_PENDING_PROBLEM };
  return { problem: COORDINATOR_UNAVAILABLE_PROBLEM };
}

export function logicalProjectThreads(
  threads: readonly EnvironmentThreadShell[],
  scopes: readonly ProjectExecutionScope[],
  explicit: boolean,
): EnvironmentThreadShell[] {
  if (!explicit)
    return scopes.flatMap((scope) =>
      projectThreads(threads, scope.environmentId, scope.projectId, scope.coordinatorThreadId),
    );
  const refs = new Set(scopes.map((scope) => `${scope.environmentId}:${scope.projectId}`));
  const coordinators = new Set(
    scopes.flatMap((scope) => (scope.coordinatorThreadId ? [scope.coordinatorThreadId] : [])),
  );
  return threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      refs.has(`${thread.environmentId}:${thread.projectId}`) &&
      !isOrchestratorThreadId(thread.id) &&
      !isNestedSubagentThread(thread, coordinators) &&
      !scopes.some(
        (scope) =>
          scope.environmentId === thread.environmentId && scope.coordinatorThreadId === thread.id,
      ),
  );
}

/**
 * History labels use the run that actually executed the request, never today's
 * model picker. They read as the thread rows do: "MacBook M4MAX · Claude Code · Opus 5.5".
 * A message outside any run (the task a subagent was given) ran on its thread's own model,
 * which `unrunModel` names.
 */
export function requestExecutionLabel(
  message: { runId?: string | null },
  runs: readonly { id: string; modelSelection?: { instanceId: string; model: string } }[],
  /** The machine's display name, from `machineNickname`. */
  machine: string,
  entries?: ReadonlyMap<string, ProviderNameSource>,
  unrunModel?: { instanceId: string; model: string } | null,
): string {
  const run = message.runId ? runs.find((candidate) => candidate.id === message.runId) : undefined;
  const selection = run?.modelSelection ?? (message.runId ? undefined : (unrunModel ?? undefined));
  const model = selection
    ? modelLabel(entries?.get(selection.instanceId) ?? null, selection.instanceId, selection.model)
        .full
    : "Model not recorded";
  return `${machine} · ${model}`;
}

/**
 * "M4: coordinator · M3: runs workers" for a project shared across machines;
 * null for a project with one copy. The sidebar shows the project once and
 * names each copy here.
 */
export function copyRolesSummary<
  T extends EnvironmentProject & { readonly environmentLabel?: string | null },
>(
  members: readonly T[],
  nameOf: (member: T) => string = (member) =>
    shortMachineName(member.environmentLabel ?? "Machine"),
): string | null {
  const shared = members.filter((member) => member.workspaceSettings?.logicalProject);
  if (new Set(shared.map((member) => member.environmentId)).size < 2) return null;
  const coordinators = new Set<T>(logicalCoordinators(shared)?.coordinators ?? []);
  return shared
    .map((member) => {
      const state = member.workspaceSettings?.coordinatorBinding?.state;
      const role = coordinators.has(member)
        ? "coordinator"
        : state === "transferring"
          ? "handoff pending"
          : state === "transferred"
            ? "runs workers"
            : "coordinator unconfirmed";
      return `${nameOf(member)}: ${role}`;
    })
    .join(" · ");
}
