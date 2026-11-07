import {
  coordinatorReplySources,
  type CoordinatorReplySource,
  type CoordinatorSourceMessage,
} from "@specweave-studio/shared/coordinatorReplySources";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Use retained input metadata, never message prose or neighbouring turn order. */
export function mobileReplySources(
  feed: ReadonlyArray<ThreadFeedEntry>,
  environmentId: string,
  scope: {
    readonly threadId: string;
    readonly coordinatorThreadId?: string | null;
    readonly visibleMessageIds?: ReadonlySet<string>;
  },
) {
  const result = new Map<string, readonly CoordinatorReplySource[]>();
  if (
    !scope.threadId.startsWith("project-coordinator:") &&
    scope.threadId !== scope.coordinatorThreadId
  )
    return result;
  const sources = coordinatorReplySources(
    feed.flatMap<CoordinatorSourceMessage>((entry) => {
      if (entry.type === "activity-group") {
        return entry.activities.flatMap((activity) => {
          const item = activity.projectedItem.item;
          return item.type === "notification"
            ? [{ id: activity.id, role: "system", runId: item.runId, notification: item }]
            : [];
        });
      }
      if (entry.type !== "message") return [];
      const message = entry.message;
      return [
        {
          id: message.id,
          role: message.role,
          runId: message.runId,
          senderThreadId: message.senderThreadId,
        },
      ];
    }),
    environmentId,
    scope.threadId,
  );
  const shownRuns = new Set<string>();
  for (const entry of feed) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { id, runId, text, attachments } = entry.message;
    if (
      !runId ||
      shownRuns.has(runId) ||
      (scope.visibleMessageIds && !scope.visibleMessageIds.has(id))
    )
      continue;
    if (!text.trim() && attachments.length === 0) continue;
    shownRuns.add(runId);
    const source = sources.get(id);
    if (source) result.set(id, source);
  }
  return result;
}

export function replySourceThreadTarget(
  source: CoordinatorReplySource,
  environments: ReadonlyArray<{
    environmentId: string;
    isEnabled: boolean;
    connectionState: string;
  }>,
) {
  if (source.kind !== "thread") return null;
  const environment = environments.find((item) => item.environmentId === source.environmentId);
  if (!environment?.isEnabled || environment.connectionState !== "connected") return null;
  return { environmentId: source.environmentId, threadId: source.threadId };
}
