/**
 * The hand off progress view: one card for a hand off started by hand and for
 * one the usage-limit rule started. It shows the transfer records the source
 * machine keeps and starts nothing itself. Its only writes are the next step a
 * row names: release a hold that was never sent, or open a dialog.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentId, HandoffTransferTrigger, ThreadId } from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { create } from "zustand";

import { useLocale, useTx, type TranslatePhrase } from "../../i18n";
import { readThreadShell, useProjects } from "../../state/entities";
import {
  handoffMode,
  refreshHandoffMode,
  runHandoffMode,
  useHandoffModeSnapshot,
} from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  progressGroups,
  progressNotes,
  progressReason,
  progressRow,
  progressSummary,
  progressSummaryText,
  progressTitle,
  trackOutView,
  type HandOffProgressGroup,
  type HandOffProgressRow,
  type HandOffRowState,
  type HandOffTrackOut,
} from "./handOffProgress.logic";
import { requestHandOffThread } from "./HandOffThreadDialog";

/** While a row is not finished the records are read this often, not every 15 seconds. */
const OPEN_REFRESH_MS = 3_000;

export interface HandOffProgressViewRow extends HandOffProgressRow {
  readonly title: string;
}

export interface HandOffProgressViewProps {
  readonly projectName: string;
  /** The project's own icon; a monogram of its name when the caller has none. */
  readonly projectIcon?: ReactNode;
  readonly sourceName: string;
  /** Null for a hold whose destination is not known, and for the every-machine-out state. */
  readonly targetName: string | null;
  readonly trigger: HandoffTransferTrigger;
  readonly rows: ReadonlyArray<HandOffProgressViewRow>;
  /** No machine has the track: shown in place of the bar. */
  readonly trackOut?: HandOffTrackOut | null;
  /** The row whose release is being asked now. */
  readonly busyOperationId?: string | null;
  /** What the machine answered to the last press, under its row. */
  readonly rowNotice?: { readonly operationId: string; readonly text: string } | null;
  /** "Cancel" and "Resume here": releases a hold nothing was sent under. */
  readonly onRelease?: (row: HandOffProgressViewRow) => void;
  readonly onOpen?: (row: HandOffProgressViewRow) => void;
  readonly onRetry?: (row: HandOffProgressViewRow) => void;
  readonly formatTime?: (iso: string) => string;
}

const STATE_TONE: Record<HandOffRowState, { dot: string; text: string }> = {
  pending: { dot: "border border-muted-foreground", text: "text-muted-foreground" },
  held: { dot: "bg-muted-foreground", text: "text-foreground" },
  waiting: { dot: "bg-warning", text: "text-warning-foreground" },
  resumed: { dot: "bg-success", text: "text-success-foreground" },
  ready: { dot: "border-2 border-success", text: "text-success-foreground" },
  stayed: { dot: "border border-dashed border-muted-foreground", text: "text-foreground" },
  failed: { dot: "bg-destructive", text: "text-destructive-foreground" },
};

function stateLabel(
  row: HandOffProgressRow,
  names: { source: string; target: string | null },
  tx: TranslatePhrase,
): string {
  switch (row.state) {
    case "pending":
      return tx("Pending");
    case "held":
      return tx("Held on {machine}", { machine: names.source });
    case "waiting":
      return tx("Waiting for confirmation");
    case "resumed":
      return names.target === null
        ? tx("Resumed")
        : tx("Resumed on {machine}", { machine: names.target });
    case "ready":
      return names.target === null
        ? tx("Ready")
        : tx("Ready on {machine}", { machine: names.target });
    case "stayed":
      return tx("Stayed");
    case "failed":
      return tx("Failed");
  }
}

function stateDetail(
  row: HandOffProgressRow,
  names: { source: string; target: string | null },
  tx: TranslatePhrase,
  formatTime: (iso: string) => string,
): string {
  const target = names.target ?? tx("the other machine");
  switch (row.state) {
    case "pending":
      return tx("Not held yet");
    case "held":
      return tx("Paused on {machine}, not sent yet", { machine: names.source });
    case "waiting":
      return row.sentAt === null
        ? tx("{machine} has not answered yet", { machine: target })
        : tx("Sent at {time}. {machine} has not answered yet", {
            time: formatTime(row.sentAt),
            machine: target,
          });
    case "resumed":
      return tx("Its interrupted run continues there");
    case "ready":
      return tx("Idle. Installed on {machine}; nothing started", { machine: target });
    case "stayed":
      return tx("It stays on {machine}", { machine: names.source });
    case "failed":
      return tx("{target} did not accept it. It runs on {source} again", {
        target,
        source: names.source,
      });
  }
}

function Monogram({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-2xs font-semibold text-primary-foreground"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

const linkClass =
  "-my-1 shrink-0 rounded-md px-2 py-1 text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/** The card, without data wiring, so fixtures and tests can render each state. */
export function HandOffProgressView(props: HandOffProgressViewProps) {
  const tx = useTx();
  const locale = useLocale();
  const formatTime =
    props.formatTime ??
    ((iso: string) =>
      new Date(iso).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }));
  const names = { source: props.sourceName, target: props.targetName };
  const out = props.trackOut ? trackOutView(props.trackOut) : null;
  const summary = progressSummary(props.rows);
  const notes = out
    ? [
        tx(
          "Same-account and unknown-usage machines are never chosen automatically, and no other track is used.",
        ),
      ]
    : progressNotes(props.rows, names, tx);
  const percent = Math.round(summary.fraction * 100);
  return (
    <section
      className="flex flex-col gap-3"
      data-slot="hand-off-progress"
      data-start={props.trigger.kind}
      aria-label={progressTitle(props.projectName, out ? null : props.targetName, tx)}
    >
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        {props.projectIcon ?? <Monogram name={props.projectName} />}
        <span className="min-w-0 truncate">
          {progressTitle(props.projectName, out ? null : props.targetName, tx)}
        </span>
      </h3>
      <p
        data-slot="hand-off-reason"
        className={
          props.trigger.kind === "automatic"
            ? "rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
            : "rounded-lg bg-accent/60 px-3 py-2 text-sm text-foreground"
        }
      >
        {progressReason(props.trigger, names, tx, out?.track)}
      </p>
      {out ? (
        <div className="flex flex-col gap-1" role="status" data-slot="hand-off-track-out">
          <p className="text-sm font-semibold">
            {tx("{track} track is out on every machine", { track: out.track })}
          </p>
          <p className="text-sm text-muted-foreground">
            {out.staying === 1
              ? tx("1 thread stays on {machine}. Nothing moves.", { machine: props.sourceName })
              : tx("{n} threads stay on {machine}. Nothing moves.", {
                  n: out.staying,
                  machine: props.sourceName,
                })}
          </p>
          {out.reset ? (
            <p className="text-sm">
              <span className="font-medium">
                {tx("Next reset: {machine} at {time}", {
                  machine: out.reset.machineLabel,
                  time: formatTime(out.reset.resetsAt),
                })}
              </span>
              <span className="text-muted-foreground">{` ${tx("Checked again then.")}`}</span>
            </p>
          ) : (
            <p className="text-sm">
              <span className="font-medium">{tx("Reset unknown")}</span>
              <span className="text-muted-foreground">
                {` ${tx("No eligible sign-in reports when it resets.")}`}
              </span>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium" role="status" data-slot="hand-off-summary">
              {progressSummaryText(summary, props.targetName, tx)}
            </p>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={summary.total}
              aria-valuenow={summary.finished}
              aria-label={tx("Threads finished")}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                data-slot="hand-off-bar"
                data-percent={percent}
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${summary.fraction * 100}%` }}
              />
            </div>
          </div>
          <ul className="flex flex-col divide-y divide-border/70" aria-label={tx("Threads")}>
            {props.rows.map((row) => {
              const tone = STATE_TONE[row.state];
              const busy = props.busyOperationId === row.operationId;
              return (
                <li
                  key={row.operationId}
                  data-row-state={row.state}
                  className="flex flex-col gap-0.5 py-2"
                >
                  <span className="flex min-w-0 items-baseline gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
                    <span
                      className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${tone.text}`}
                    >
                      <span className={`size-2 rounded-full ${tone.dot}`} aria-hidden />
                      {stateLabel(row, names, tx)}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {stateDetail(row, names, tx, formatTime)}
                    </span>
                    {row.action === "wait" ? (
                      <span className="shrink-0 px-2 text-xs text-muted-foreground">
                        {tx("Wait")}
                      </span>
                    ) : row.action === "open" && props.onOpen ? (
                      <button
                        type="button"
                        className={linkClass}
                        onClick={() => props.onOpen?.(row)}
                      >
                        {tx("Open on {machine}", { machine: props.targetName ?? "" })}
                      </button>
                    ) : row.action === "try-again" && props.onRetry ? (
                      <button
                        type="button"
                        className={linkClass}
                        onClick={() => props.onRetry?.(row)}
                      >
                        {tx("Try again")}
                      </button>
                    ) : (row.action === "cancel" || row.action === "resume-here") &&
                      props.onRelease ? (
                      <button
                        type="button"
                        className={linkClass}
                        disabled={busy}
                        onClick={() => props.onRelease?.(row)}
                      >
                        {row.action === "cancel" ? tx("Cancel") : tx("Resume here")}
                      </button>
                    ) : null}
                  </span>
                  {row.detail && (row.state === "stayed" || row.state === "failed") ? (
                    <span className="text-xs text-muted-foreground" data-slot="hand-off-row-reason">
                      {row.detail}
                    </span>
                  ) : null}
                  {props.rowNotice?.operationId === row.operationId ? (
                    <span role="status" className="text-xs text-muted-foreground">
                      {props.rowNotice.text}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {notes.map((note) => (
        <p key={note} className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </section>
  );
}

/** One group of this machine's transfer records, with names, titles and the rows' next steps. */
export function HandOffProgress(props: {
  environmentId: EnvironmentId;
  group: HandOffProgressGroup;
  /** Called before the view leaves for a thread or another dialog. */
  onLeave?: () => void;
}) {
  const { environmentId, group } = props;
  const tx = useTx();
  const router = useRouter();
  const name = useMachineNicknames();
  const { snapshot } = useHandoffModeSnapshot(environmentId);
  const projects = useProjects();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ operationId: string; text: string } | null>(null);
  const project =
    projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === group.projectId,
    ) ?? null;
  const open = group.rows.some((row) => !row.finished);
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void refreshHandoffMode(environmentId), OPEN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environmentId, open]);
  const rows = group.rows.map((row) => ({
    ...row,
    title:
      readThreadShell(scopeThreadRef(environmentId, row.threadId))?.title || tx("Untitled thread"),
  }));
  return (
    <HandOffProgressView
      projectName={project?.title || tx("This project")}
      projectIcon={
        project ? <ProjectFavicon project={project} className="size-5 shrink-0" /> : undefined
      }
      sourceName={name(environmentId, snapshot?.machineLabel)}
      targetName={group.targetEnvironmentId === null ? null : name(group.targetEnvironmentId)}
      trigger={group.trigger}
      rows={rows}
      busyOperationId={busy}
      rowNotice={notice}
      onRelease={(row) => {
        setBusy(row.operationId);
        setNotice(null);
        void runHandoffMode(handoffMode.resumeFenced, {
          environmentId,
          input: { threadId: row.threadId },
        }).then((result) => {
          setBusy(null);
          if (!result.ok) {
            setNotice({ operationId: row.operationId, text: result.error });
            return;
          }
          const after = result.value.transfers?.find(
            (record) => record.operationId === row.operationId,
          );
          // The machine releases only a hold nothing was sent under, and not one it is sending now.
          if (after && !progressRow(after).finished)
            setNotice({
              operationId: row.operationId,
              text: tx("It is being sent now, so it was not released. Nothing changed."),
            });
        });
      }}
      onOpen={(row) => {
        if (row.continuedThreadId === null || row.targetEnvironmentId === null) return;
        props.onLeave?.();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(row.targetEnvironmentId, row.continuedThreadId),
          ),
        });
      }}
      onRetry={(row) => {
        if (row.targetEnvironmentId === null) return;
        props.onLeave?.();
        requestHandOffThread(
          { environmentId, threadId: row.threadId },
          {
            destinationEnvironmentId: row.targetEnvironmentId,
            ...(row.modelSelection ? { modelSelection: row.modelSelection } : {}),
          },
        );
      }}
    />
  );
}

/** This machine's groups, newest first, from the snapshot every window already polls. */
export function useHandOffProgressGroups(environmentId: EnvironmentId | null) {
  const { snapshot } = useHandoffModeSnapshot(environmentId);
  return useMemo(
    () => progressGroups(snapshot?.transfers, snapshot?.transferBatches),
    [snapshot?.transfers, snapshot?.transferBatches],
  );
}

interface ProgressRequest {
  readonly environmentId: EnvironmentId;
  /** A group's key, or a thread whose newest move is shown. */
  readonly groupKey: string | null;
  readonly threadId: ThreadId | null;
}

const useRequest = create<{ request: ProgressRequest | null }>(() => ({ request: null }));

/** Opens the progress view for one hand off of a machine: a group, or the one a thread is in. */
export function requestHandOffProgress(
  environmentId: EnvironmentId,
  target: { readonly groupKey: string } | { readonly threadId: ThreadId },
) {
  useRequest.setState({
    request: {
      environmentId,
      groupKey: "groupKey" in target ? target.groupKey : null,
      threadId: "threadId" in target ? target.threadId : null,
    },
  });
}

const closeProgress = () => useRequest.setState({ request: null });

export function HandOffProgressDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? <HandOffProgressDialog request={request} /> : null;
}

function HandOffProgressDialog({ request }: { request: ProgressRequest }) {
  const tx = useTx();
  const groups = useHandOffProgressGroups(request.environmentId);
  const group =
    groups.find((candidate) =>
      request.groupKey !== null
        ? candidate.key === request.groupKey
        : candidate.rows.some((row) => row.threadId === request.threadId),
    ) ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeProgress();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tx("Hand off progress")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {group ? (
            <HandOffProgress
              environmentId={request.environmentId}
              group={group}
              onLeave={closeProgress}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {tx("This machine keeps no record of that hand off any more.")}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" onClick={closeProgress}>
            {tx("Done")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
