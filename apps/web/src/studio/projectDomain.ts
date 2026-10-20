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

/** No election or failover: only the single server-admitted owner can receive messages. */
export function logicalCoordinator<T extends EnvironmentProject>(
  members: readonly T[],
): { member?: T; problem: string | null } | null {
  const declared = members.filter((member) => member.workspaceSettings?.logicalProject);
  if (!declared.length) return null;
  const epochOf = (member: T) => member.workspaceSettings?.coordinatorBinding?.epoch ?? 0;
  const highest = Math.max(...declared.map(epochOf));
  const current = declared.filter((member) => epochOf(member) === highest);
  const pending = current.find(
    (member) => member.workspaceSettings?.coordinatorBinding?.state === "transferring",
  );
  if (pending)
    return {
      member: pending,
      problem:
        "Coordinator handoff is pending. Reconnect the source and destination to confirm the transfer.",
    };
  const active = current.filter(
    (member) => member.workspaceSettings?.coordinatorBinding?.state === "active",
  );
  if (active.length !== 1)
    return {
      problem:
        active.length > 1
          ? "Conflicting coordinator ownership. Sending is blocked until the machines agree."
          : "The active coordinator is unavailable. Reconnect its machine; the project will not switch automatically.",
    };
  const member = active[0]!;
  // A confirmed successor supersedes its exact ancestors, even if an older
  // host has not delivered its acknowledgment yet. An unrelated claim never does.
  const ancestors = new Set<string>();
  let predecessor = member.workspaceSettings?.coordinatorBinding?.predecessor;
  while (predecessor && !ancestors.has(`${predecessor.environmentId}:${predecessor.projectId}`)) {
    const key = `${predecessor.environmentId}:${predecessor.projectId}`;
    ancestors.add(key);
    predecessor = declared.find((candidate) => `${candidate.environmentId}:${candidate.id}` === key)
      ?.workspaceSettings?.coordinatorBinding?.predecessor;
  }
  if (
    declared.some(
      (other) =>
        other !== member &&
        other.workspaceSettings?.coordinatorBinding?.state !== "transferred" &&
        !ancestors.has(`${other.environmentId}:${other.id}`),
    )
  )
    return {
      problem: "Conflicting coordinator ownership. Sending is blocked until the machines agree.",
    };
  return { member, problem: null };
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
  return `${shortMachineName(machine)} · ${model}`;
}

/**
 * "M4: coordinator · M3: runs workers" for a project shared across machines;
 * null for a project with one copy. The sidebar shows the project once and
 * names each copy here.
 */
export function copyRolesSummary<
  T extends EnvironmentProject & { readonly environmentLabel?: string | null },
>(members: readonly T[]): string | null {
  const shared = members.filter((member) => member.workspaceSettings?.logicalProject);
  if (new Set(shared.map((member) => member.environmentId)).size < 2) return null;
  const coordinator = logicalCoordinator(shared)?.member;
  return shared
    .map((member) => {
      const state = member.workspaceSettings?.coordinatorBinding?.state;
      const role =
        member === coordinator
          ? "coordinator"
          : state === "transferring"
            ? "handoff pending"
            : state === "transferred"
              ? "runs workers"
              : "coordinator unconfirmed";
      return `${shortMachineName(member.environmentLabel ?? "Machine")}: ${role}`;
    })
    .join(" · ");
}
