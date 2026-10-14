import {
  OrchestratorMcpFailure,
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

function listItemFromShell(shell: OrchestrationV2ThreadShell): OrchestratorMcpThreadListItem {
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
      threads: page.map(listItemFromShell),
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
