import {
  OrchestratorMcpFailure,
  resolveThreadExecution,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

export function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

/**
 * ownerMachineId, executionMachineId and executionState for the thread list
 * API. With no serving environment id (a test without one), only what the
 * thread itself recorded.
 */
export function threadExecutionFields(
  summary: Parameters<typeof resolveThreadExecution>[0],
  servingEnvironmentId: EnvironmentId | null,
): Pick<
  OrchestratorMcpThreadListItem,
  | "ownerMachineId"
  | "executionMachineId"
  | "executionMachineLabel"
  | "executionState"
  | "executionLastSeenAt"
> {
  if (servingEnvironmentId === null)
    return {
      ...(summary.ownerMachineId === undefined ? {} : { ownerMachineId: summary.ownerMachineId }),
      ...(summary.executionMachineId === undefined
        ? {}
        : { executionMachineId: summary.executionMachineId }),
      ...(summary.executionMachineLabel === undefined
        ? {}
        : { executionMachineLabel: summary.executionMachineLabel }),
      ...(summary.executionState === undefined ? {} : { executionState: summary.executionState }),
      ...(summary.executionLastSeenAt === undefined
        ? {}
        : { executionLastSeenAt: summary.executionLastSeenAt }),
    };
  const resolved = resolveThreadExecution(summary, servingEnvironmentId);
  return {
    ownerMachineId: resolved.ownerMachineId,
    executionMachineId: resolved.executionMachineId,
    ...(resolved.executionMachineLabel === null
      ? {}
      : { executionMachineLabel: resolved.executionMachineLabel }),
    executionState: resolved.executionState,
    ...(resolved.executionState === "unknown"
      ? { executionLastSeenAt: resolved.executionLastSeenAt }
      : {}),
  };
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  servingEnvironmentId: EnvironmentId | null,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    threadLink: formatStudioThreadLink(shell.id, shell.title),
    archived: shell.archivedAt !== null,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    ...threadSettlement(shell),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    ...(shell.heldQueuedCount ? { heldQueuedMessages: shell.heldQueuedCount } : {}),
    ...threadExecutionFields(shell, servingEnvironmentId),
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

/** The authoritative catalog includes archive snapshots, never the bounded worker follower store. */
export const listProjectThreadInventory = (options: {
  readonly threadManagement: Pick<
    ThreadManagementServiceShape,
    "listProjectThreads" | "getShellSnapshot"
  >;
  readonly projectId: ProjectId;
  readonly currentThreadId: ThreadId | null;
  readonly input: OrchestratorMcpThreadListInput;
  /** This machine; fills ownerMachineId and executionMachineId for threads that never moved. */
  readonly servingEnvironmentId?: EnvironmentId | null;
}) =>
  Effect.gen(function* () {
    const { threadManagement, projectId, currentThreadId, input } = options;
    const active = yield* threadManagement.listProjectThreads({
      projectId,
      includeSubagents: input.includeSubagents !== false,
    });
    const archived = input.includeArchived
      ? (yield* threadManagement.getShellSnapshot({ location: "archive" })).threads
      : [];
    const statuses = input.statuses === undefined ? null : new Set(input.statuses);
    const titleContains = input.titleContains?.toLocaleLowerCase();
    // Concurrent archive/unarchive can put a shell in both snapshots. Preserve one identity.
    const shells = new Map([...active, ...archived].map((thread) => [thread.id, thread]));
    const filtered = [...shells.values()]
      .filter((thread) => thread.projectId === projectId && thread.deletedAt === null)
      .filter(
        (thread) =>
          input.includeSubagents !== false || thread.lineage.relationshipToParent !== "subagent",
      )
      .filter(
        (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
      )
      .filter(
        (thread) =>
          input.settled === undefined || threadSettlement(thread).settled === input.settled,
      )
      .filter(
        (thread) =>
          titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
      )
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
          right.id.localeCompare(left.id),
      );
    const cursor = input.cursor ?? 0;
    const page = filtered.slice(cursor, cursor + (input.limit ?? 50));
    return {
      projectId,
      currentThreadId,
      includeArchived: input.includeArchived === true,
      threads: page.map((shell) => listItemFromShell(shell, options.servingEnvironmentId ?? null)),
      nextCursor: cursor + page.length < filtered.length ? cursor + page.length : null,
      total: filtered.length,
    } satisfies OrchestratorMcpThreadListResult;
  }).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Unable to read the project's thread inventory.",
        }),
    ),
  );
