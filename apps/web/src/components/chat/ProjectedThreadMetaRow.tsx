import * as DateTime from "effect/DateTime";
import { useMemo, type ComponentProps } from "react";
import { ThreadMetaRow } from "./ThreadMetaRow";
import { threadTimingBackground } from "./threadTiming";

type ProjectedTimingRun = {
  readonly id: string;
  readonly status: string;
  readonly queueHeld?: boolean | undefined;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
};

type Props = Omit<
  ComponentProps<typeof ThreadMetaRow>,
  "recordedRuns" | "historyComplete" | "background"
> & {
  readonly projection: { readonly runs: readonly ProjectedTimingRun[] } | null;
  readonly historyStatus: string;
  readonly hasMoreHistory: boolean;
  readonly pendingBackgroundTasks: Parameters<typeof threadTimingBackground>[0];
  readonly isWorking: boolean;
  readonly hasActiveThread: boolean;
};

/** The actual ChatView boundary from server projection/history to visible timing. */
export function ProjectedThreadMetaRow({
  projection,
  historyStatus,
  hasMoreHistory,
  pendingBackgroundTasks,
  isWorking,
  hasActiveThread,
  ...metadata
}: Props) {
  const recordedRuns = useMemo(
    () =>
      projection?.runs.map((run) => ({
        id: run.id,
        status: run.status,
        queueHeld: run.queueHeld,
        startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
        completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
      })),
    [projection?.runs],
  );
  return (
    <ThreadMetaRow
      {...metadata}
      recordedRuns={recordedRuns}
      historyComplete={projection !== null && historyStatus === "live" && !hasMoreHistory}
      background={threadTimingBackground(pendingBackgroundTasks, isWorking, hasActiveThread)}
    />
  );
}
