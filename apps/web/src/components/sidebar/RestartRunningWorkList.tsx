import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  groupRunningWork,
  runningWorkCounts,
  type RunningWorkThread,
} from "./restartRunningWork.logic";

/** Threads listed before "Show all"; the rest stay one click away. */
export const RUNNING_WORK_VISIBLE_THREADS = 5;

/**
 * What an update restart would interrupt, grouped by project: each project
 * with its icon and counts, its threads under it with a status dot. A thread
 * row opens that thread (and closes the dialog through `onOpenThread`).
 */
export function RestartRunningWorkList({
  blockers,
  onOpenThread,
}: {
  readonly blockers: ReadonlyArray<ServiceUpdateBlocker>;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const groups = useMemo(() => groupRunningWork(blockers), [blockers]);
  const projects = useProjects();
  const [expanded, setExpanded] = useState(false);
  const totalThreads = groups.reduce((total, group) => total + group.threads.length, 0);
  // Threads are shown in project order until the budget runs out.
  let budget = expanded ? Number.POSITIVE_INFINITY : RUNNING_WORK_VISIBLE_THREADS;

  return (
    <div
      data-testid="restart-running-work"
      className="max-h-72 overflow-y-auto rounded-xl border bg-muted/30 text-sm"
    >
      <ul className="divide-y">
        {groups.map((group) => {
          if (budget <= 0) return null;
          const shown = group.threads.slice(0, budget);
          budget -= shown.length;
          const project = projects.find((candidate) => candidate.id === group.projectId);
          return (
            <li key={group.projectId ?? "other"} className="py-1.5">
              <div className="flex items-center gap-2 px-3 py-1">
                {project ? (
                  <ProjectFavicon project={project} className="size-4 shrink-0" />
                ) : (
                  <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{group.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {runningWorkCounts(group)}
                </span>
              </div>
              <ul>
                {shown.map((thread) => (
                  <RunningWorkThreadRow
                    key={thread.threadId ?? thread.title}
                    thread={thread}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {totalThreads > RUNNING_WORK_VISIBLE_THREADS ? (
        <button
          type="button"
          className="w-full cursor-pointer border-t px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `Show all ${totalThreads} threads`}
        </button>
      ) : null}
    </div>
  );
}

function RunningWorkThreadRow({
  thread,
  onOpenThread,
}: {
  readonly thread: RunningWorkThread;
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const dot = (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        thread.running > 0
          ? "animate-status-pulse bg-primary"
          : thread.questions > 0
            ? "bg-warning"
            : "bg-muted-foreground/60",
      )}
    />
  );
  const content = (
    <>
      {dot}
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {runningWorkCounts(thread)}
      </span>
    </>
  );
  const threadId = thread.threadId;
  return (
    <li>
      {threadId !== null && onOpenThread ? (
        <button
          type="button"
          className="group flex w-full cursor-pointer items-center gap-2 py-1 pr-3 pl-9 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={() => onOpenThread(threadId)}
        >
          {content}
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
          />
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1 pr-3 pl-9">{content}</div>
      )}
    </li>
  );
}
