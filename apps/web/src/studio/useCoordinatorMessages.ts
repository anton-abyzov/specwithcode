/**
 * The coordinator messages this machine keeps for a linked project (1427 AC-18):
 * read every ten seconds while the conversation is open, so a merge, a receipt
 * or an answer updates its row in place. The step notifier reads in the
 * background too: a step must reach a person who is not looking at the window.
 */
import type { CoordinatorMessageView, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { useEffect, useMemo } from "react";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { useEnvironmentQuery } from "../state/query";
import { projectWorkspace } from "./projectWorkspace";

export const COORDINATOR_MESSAGES_REFRESH_MS = 10_000;

const NONE: readonly CoordinatorMessageView[] = [];

export function useCoordinatorMessages(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly enabled: boolean;
  readonly background?: boolean;
}): {
  readonly list: readonly CoordinatorMessageView[];
  readonly byId: ReadonlyMap<string, CoordinatorMessageView>;
} {
  const { environmentId, projectId, enabled, background = false } = input;
  const query = useEnvironmentQuery(
    enabled ? projectWorkspace.coordinatorMessages({ environmentId, input: { projectId } }) : null,
  );
  useLiveRefresh(query.refresh, {
    enabled: enabled && !background,
    key: `coordinator-messages:${environmentId}:${projectId}`,
    intervalMs: COORDINATOR_MESSAGES_REFRESH_MS,
  });
  const { refresh } = query;
  useEffect(() => {
    if (!enabled || !background) return;
    const timer = window.setInterval(refresh, COORDINATOR_MESSAGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [background, enabled, refresh]);
  const list = query.data?.messages ?? NONE;
  const byId = useMemo(() => new Map(list.map((message) => [message.id, message])), [list]);
  return { list, byId };
}
