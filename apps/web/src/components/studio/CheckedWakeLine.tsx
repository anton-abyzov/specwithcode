import type { CoordinatorReplySource } from "@specweave-studio/shared/coordinatorReplySources";
import type { ReactNode } from "react";

import type { CheckedWakeGroup } from "../../studio/coordinatorActivity";
import { CoordinatorReplySources } from "./CoordinatorReplySources";

/**
 * Results only: status-only replies to worker wakes fold into one
 * "Checked <worker>" line that opens them. Other replies pass through.
 */
export function CheckedWakeLine({
  group,
  rowId,
  openGroups,
  onToggle,
  sources,
  onOpenSource,
  resolveTitle,
  canOpenSource,
  children,
}: {
  group: CheckedWakeGroup | undefined;
  rowId: string;
  openGroups: ReadonlySet<string>;
  onToggle: (leaderId: string, open: boolean) => void;
  sources: readonly CoordinatorReplySource[];
  onOpenSource: (id: string, environmentId: string) => void;
  resolveTitle: (id: string, environmentId: string) => string | undefined;
  canOpenSource: (id: string) => boolean;
  children: ReactNode;
}) {
  if (group === undefined) return children;
  const open = openGroups.has(group.leaderId);
  // The rest of the run shows only once its line is opened.
  if (group.leaderId !== rowId) return open ? children : null;
  return (
    <details
      className="sws-checked-wake"
      data-checked-wake=""
      open={open}
      onToggle={(event) => onToggle(group.leaderId, event.currentTarget.open)}
    >
      <summary>
        Checked{" "}
        {sources[0]?.kind === "thread" ? (
          <CoordinatorReplySources
            sources={sources}
            inline
            onOpenThread={onOpenSource}
            resolveTitle={resolveTitle}
            canOpenThread={canOpenSource}
          />
        ) : (
          group.worker.title
        )}
        {group.count > 1 ? ` · ${group.count} times` : null}
      </summary>
      {open ? children : null}
    </details>
  );
}
