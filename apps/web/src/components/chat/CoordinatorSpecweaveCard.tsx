/**
 * The setup card under the project page's coordinator conversation (1396
 * AC-09). That column draws its messages without timeline rows, so the keys
 * the card refreshes on come from the coordinator's projection. Kept apart
 * from SpecweaveSetupCard.tsx so the Board and the composer line, which share
 * that file's hooks, do not load the thread entity store.
 */
import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useMemo } from "react";

import { useThreadProjection } from "../../state/entities";
import { viewerIso } from "../../viewerDate";
import { specweaveCoordinatorKeys } from "../studio/specweaveSetup.logic";
import { SpecweaveSetupCard } from "./SpecweaveSetupCard";

export function CoordinatorSpecweaveCard({
  environmentId,
  projectId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(
    useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]),
  )?.projection;
  const keys = useMemo(
    () =>
      specweaveCoordinatorKeys({
        turnItems: (projection?.turnItems ?? []).map((item) => ({
          id: item.id,
          type: item.type,
          toolName: "toolName" in item ? item.toolName : null,
          status: item.status,
        })),
        messages: (projection?.messages ?? []).map((message) => ({
          role: message.role,
          createdAt: viewerIso(message.createdAt),
          createdBy: message.createdBy,
        })),
      }),
    [projection?.messages, projection?.turnItems],
  );
  return (
    <div className="mx-auto w-full max-w-3xl px-1 pt-2 empty:hidden">
      <SpecweaveSetupCard
        environmentId={environmentId}
        projectId={projectId}
        threadId={threadId}
        toolKey={keys.toolKey}
        lastUserMessageAt={keys.lastUserMessageAt}
      />
    </div>
  );
}
