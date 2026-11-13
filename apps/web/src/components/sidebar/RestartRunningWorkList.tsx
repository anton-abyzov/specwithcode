import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  InfoIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MonitorIcon,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { respondToConfirmDialog } from "../../confirmDialog";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useMachineNicknames } from "../../studio/machineNickname";
import { threadLocation } from "../../studio/threadLocation";
import {
  restartWorkCount,
  restartWorkRows,
  type RestartWorkRow,
  type RestartWorkThreadInfo,
} from "./restartRunningWork.logic";

/** Threads listed before "Show all"; the rest stay one click away. */
export const RUNNING_WORK_VISIBLE_THREADS = 5;
/** How often an open restart dialog looks at what runs again. */
export const RUNNING_WORK_POLL_MS = 3_000;

/** Opens a listed thread (and closes the dialog). */
export type OpenRestartThread = (thread: {
  readonly environmentId: string | null;
  readonly threadId: string;
}) => void;

/**
 * What an update restart would interrupt, one row per thread: what it is doing
 * now and the machine it runs on. A row closes the question (as Later) and opens
 * that thread through `onOpenThread`.
 */
export function RestartRunningWorkList({
  blockers,
  onOpenThread: openThread,
  openFromDialog = false,
  machine,
}: {
  readonly blockers: ReadonlyArray<ServiceUpdateBlocker>;
  readonly onOpenThread?: OpenRestartThread | undefined;
  /** Without `onOpenThread`: a row closes the confirm dialog and opens its thread. */
  readonly openFromDialog?: boolean;
  /** The machine whose service reported the blockers, for threads this window does not know. */
  readonly machine?: { readonly environmentId: string | null; readonly name: string | null };
}) {
  const shells = useThreadShells();
  const nickname = useMachineNicknames();
  const router = useRouter({ warn: false });
  const fallbackEnvironmentId = machine?.environmentId ?? null;
  const onOpenThread: OpenRestartThread | undefined =
    openThread ??
    (openFromDialog && router
      ? (thread) => {
          const environmentId = thread.environmentId ?? fallbackEnvironmentId;
          if (environmentId === null) return;
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.threadId },
          });
        }
      : undefined);
  const reportingId = machine?.environmentId ?? null;
  const reportingName = machine?.name ?? null;
  const rows = useMemo(() => {
    const byThread = new Map<string, RestartWorkThreadInfo>();
    for (const shell of shells) {
      // The reporting machine's own copy wins over a mirror of the same thread.
      if (byThread.has(shell.id) && shell.environmentId !== reportingId) continue;
      const location = threadLocation({
        summary: shell.source,
        servingEnvironmentId: shell.environmentId,
        name: nickname,
      });
      byThread.set(shell.id, {
        environmentId: shell.environmentId,
        activeWork: shell.activeWork?.label ?? null,
        machine: location.label,
        machineDescription: location.description,
      });
    }
    return restartWorkRows(blockers, (threadId) => byThread.get(threadId) ?? null, {
      environmentId: reportingId,
      name: reportingName,
    });
  }, [blockers, nickname, reportingId, reportingName, shells]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, RUNNING_WORK_VISIBLE_THREADS);
  const running = rows.some((row) => row.state === "running");

  return (
    <div data-testid="restart-running-work" className="space-y-2">
      <div
        data-testid="restart-running-work-count"
        aria-live="polite"
        className="flex items-center gap-2 text-sm font-medium"
      >
        {rows.length === 0 ? (
          <CheckCircle2Icon aria-hidden className="size-4 text-success-foreground" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              running ? "animate-status-pulse bg-primary" : "bg-warning",
            )}
          />
        )}
        <span>{restartWorkCount(rows)}</span>
        {rows.length === 0 ? (
          <span className="font-normal text-muted-foreground">Safe to restart</span>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div className="max-h-72 overflow-y-auto rounded-xl border bg-muted/30 text-sm">
          <ul className="divide-y">
            {shown.map((row) => (
              <RunningWorkRow key={row.key} row={row} onOpenThread={onOpenThread} />
            ))}
          </ul>
          {rows.length > RUNNING_WORK_VISIBLE_THREADS ? (
            <button
              type="button"
              className="w-full cursor-pointer border-t px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer" : `Show all ${rows.length} threads`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The list kept current while the dialog is open: `poll` reads what runs again
 * every few seconds, so finished threads leave and new ones appear.
 */
export function LiveRestartRunningWorkList({
  initial,
  poll,
  intervalMs = RUNNING_WORK_POLL_MS,
  onOpenThread,
  openFromDialog = false,
  machine,
}: {
  readonly initial: ReadonlyArray<ServiceUpdateBlocker>;
  /** What runs now; null keeps the last answer (the service did not answer in time). */
  readonly poll?: (() => Promise<ReadonlyArray<ServiceUpdateBlocker> | null>) | undefined;
  readonly intervalMs?: number;
  readonly onOpenThread?: OpenRestartThread | undefined;
  readonly openFromDialog?: boolean;
  readonly machine?: { readonly environmentId: string | null; readonly name: string | null };
}) {
  const [blockers, setBlockers] = useState(initial);
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });
  useEffect(() => {
    if (pollRef.current === undefined) return;
    let active = true;
    let busy = false;
    const look = () => {
      const read = pollRef.current;
      if (busy || read === undefined) return;
      busy = true;
      void read()
        .then((next) => {
          if (active && next !== null) setBlockers(next);
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const timer = setInterval(look, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return (
    <RestartRunningWorkList
      blockers={blockers}
      onOpenThread={onOpenThread}
      openFromDialog={openFromDialog}
      {...(machine ? { machine } : {})}
    />
  );
}

const STATE_ICON = {
  running: <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin text-primary" />,
  queued: <ClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
  question: (
    <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
  ),
} as const;

function RunningWorkRow({
  row,
  onOpenThread,
}: {
  readonly row: RestartWorkRow;
  readonly onOpenThread?: OpenRestartThread | undefined;
}) {
  const content = (
    <>
      {STATE_ICON[row.state]}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{row.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.now}
          {row.projectTitle ? ` · ${row.projectTitle}` : ""}
        </span>
      </span>
      {row.machine ? (
        <span
          aria-hidden
          className="inline-flex max-w-32 shrink-0 items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          <MonitorIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{row.machine}</span>
        </span>
      ) : null}
    </>
  );
  const threadId = row.threadId;
  return (
    <li data-testid="restart-running-work-row">
      {threadId !== null && onOpenThread ? (
        <button
          type="button"
          aria-label={`Open ${row.title}: ${row.now}${row.machine ? `, on ${row.machine}` : ""}`}
          className="group flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={() => {
            // The list lives in the restart question: opening a thread answers it with Later.
            respondToConfirmDialog("cancel");
            onOpenThread({ environmentId: row.environmentId, threadId });
          }}
        >
          {content}
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground opacity-40 group-hover:opacity-100"
          />
        </button>
      ) : (
        <div className="flex items-center gap-2.5 px-3 py-2">
          {content}
          <span aria-hidden className="size-3.5 shrink-0" />
        </div>
      )}
    </li>
  );
}

/** Secondary lines under the list: what is asked again, and what waiting does. */
export function RestartDialogNotes({ lines }: { readonly lines: ReadonlyArray<string | null> }) {
  const shown = lines.filter((line): line is string => line !== null && line !== "");
  if (shown.length === 0) return null;
  return (
    <ul data-testid="restart-dialog-notes" className="space-y-1 text-xs text-muted-foreground">
      {shown.map((line) => (
        <li key={line} className="flex items-start gap-1.5">
          <InfoIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
