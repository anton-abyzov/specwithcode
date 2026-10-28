import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { useState } from "react";

import {
  continueHereFailure,
  handoffBadgeFor,
  handoffMode,
  incomingReplicaFor,
  runHandoffMode,
  unreachableBadgeFor,
  useHandoffModeSnapshot,
  type HandoffBadgeView,
} from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useHostOffline } from "../../studio/unreachableHosts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The handoff badge for a thread. `localEnvironmentId` is the machine this
 * window serves; it holds the checkpoints other machines replicated here, so a
 * thread whose own machine went silent can still read "{M} is offline".
 */
export function useHandoffBadge(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  localEnvironmentId: EnvironmentId | null,
  /** False for a machine that stopped answering: only the local replica can speak for it. */
  ownReachable = true,
): HandoffBadgeView | null {
  const name = useMachineNicknames();
  const own = useHandoffModeSnapshot(ownReachable ? environmentId : null);
  const local = useHandoffModeSnapshot(
    localEnvironmentId !== null && localEnvironmentId !== environmentId ? localEnvironmentId : null,
  );
  const badge = handoffBadgeFor(own.snapshot, threadId, name);
  if (badge) return badge;
  if (localEnvironmentId === null || localEnvironmentId === environmentId) return null;
  return unreachableBadgeFor(incomingReplicaFor(local.snapshot, environmentId, threadId), name);
}

/** The chip itself; "ready" uses the accent color. */
export function HandoffBadgeChip({
  badge,
  className = "sws-chip",
}: {
  badge: HandoffBadgeView;
  className?: string;
}) {
  const chip = (
    <span className={`${className} sws-handoff-badge`} data-handoff={badge.kind} role="status">
      {badge.label}
    </span>
  );
  // "Syncing" names each machine that lags and why on hover.
  if (badge.kind !== "behind" || !badge.detail) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="bottom">{badge.detail}</TooltipPopup>
    </Tooltip>
  );
}

export interface HandoffBadgeActionsProps {
  badge: HandoffBadgeView;
  /** The machine whose snapshot set the badge (paused) or which holds the replica. */
  environmentId: EnvironmentId | null;
  localEnvironmentId: EnvironmentId | null;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  className?: string;
  disabled?: boolean;
}

/** A "Not carried over: …" notice is a warning, not a success. */
const noticeType = (notice: string) => (/not carried over/i.test(notice) ? "warning" : "success");

/**
 * The one-click action a badge offers: open the thread on the machine it moved
 * to, continue an offline machine's thread here, or resume a paused machine.
 * The same outline button in a thread row and in the thread header.
 */
export function HandoffBadgeActions(props: HandoffBadgeActionsProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { badge } = props;
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  switch (badge.kind) {
    case "continued":
      return (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className={props.className}
          onClick={() => props.onOpenThread(badge.threadId, badge.environmentId)}
        >
          Open on {badge.machine}
        </Button>
      );
    case "source-unreachable": {
      const local = props.localEnvironmentId;
      if (local === null) return null;
      return (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className={props.className}
          disabled={busy || props.disabled}
          onClick={() =>
            void run(async () => {
              const result = await runHandoffMode(handoffMode.continueHere, {
                environmentId: local,
                input: {
                  sourceEnvironmentId: badge.replica.sourceEnvironmentId,
                  sourceThreadId: badge.replica.sourceThreadId,
                },
              });
              if (!result.ok) {
                const failure = continueHereFailure(result.error, badge.machine);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: failure.title,
                    description: failure.description,
                  }),
                );
                return;
              }
              if (result.value.notice)
                toastManager.add(
                  stackedThreadToast({
                    type: noticeType(result.value.notice),
                    title: result.value.notice,
                  }),
                );
              props.onOpenThread(result.value.threadId, result.value.environmentId);
            })
          }
        >
          {busy ? "Continuing…" : "Continue here"}
        </Button>
      );
    }
    case "paused": {
      const environmentId = props.environmentId;
      if (environmentId === null) return null;
      const resume = () =>
        void run(async () => {
          const result = await runHandoffMode(handoffMode.resumeFenced, {
            environmentId,
            input: {},
          });
          if (!result.ok)
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Couldn't resume this Mac",
                description: result.error,
              }),
            );
        });
      return (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className={props.className}
            disabled={busy || props.disabled}
            onClick={() => setConfirming(true)}
          >
            {busy ? "Resuming…" : "Resume this Mac…"}
          </Button>
          <ResumeMachineDialogView
            open={confirming}
            onOpenChange={setConfirming}
            onConfirm={() => {
              setConfirming(false);
              resume();
            }}
          />
        </>
      );
    }
    default:
      return null;
  }
}

/** Asks before resuming: it unpauses every thread on this machine, not just one. */
export function ResumeMachineDialogView(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Resume all threads on this Mac?</AlertDialogTitle>
          <AlertDialogDescription>
            This Mac handed its threads off before sleeping. Resuming lets them run here again, even
            if another machine already picked them up.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="default" onClick={props.onConfirm}>
            Resume this Mac
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Badge plus its action, for the thread header. */
export function HandoffThreadHeaderBadge(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  localEnvironmentId: EnvironmentId | null;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  canOperate: boolean;
}) {
  // Like the row: a machine that stopped answering speaks only through the local replica.
  const hostOffline = useHostOffline(props.environmentId);
  const badge = useHandoffBadge(
    props.environmentId,
    props.threadId,
    props.localEnvironmentId,
    !hostOffline,
  );
  if (!badge) return null;
  return (
    <>
      <HandoffBadgeChip badge={badge} />
      <HandoffBadgeActions
        badge={badge}
        environmentId={props.environmentId}
        localEnvironmentId={props.localEnvironmentId}
        onOpenThread={props.onOpenThread}
        disabled={!props.canOperate}
      />
    </>
  );
}

interface RowProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  localEnvironmentId: EnvironmentId | null;
  hostOffline: boolean;
}

/** The badge in a thread row's meta line; the row itself is a button, so no controls here. */
export function HandoffRowBadge(props: RowProps) {
  const badge = useHandoffBadge(
    props.environmentId,
    props.threadId,
    props.localEnvironmentId,
    !props.hostOffline,
  );
  return badge ? <HandoffBadgeChip badge={badge} className="sws-thread-handoff-chip" /> : null;
}

/** The row's one-click action beside its open button: "Continue here" and "Resume this Mac…". */
export function HandoffRowAction(
  props: RowProps & {
    onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
    canOperate: boolean;
  },
) {
  const badge = useHandoffBadge(
    props.environmentId,
    props.threadId,
    props.localEnvironmentId,
    !props.hostOffline,
  );
  if (!badge || (badge.kind !== "source-unreachable" && badge.kind !== "paused")) return null;
  // Without the machine that would act, there is no button, so no empty slot either.
  if (badge.kind === "source-unreachable" && props.localEnvironmentId === null) return null;
  // The wrapper carries the row layout, so the button stays a plain outline Button.
  return (
    <span className="sws-thread-handoff-action">
      <HandoffBadgeActions
        badge={badge}
        environmentId={props.environmentId}
        localEnvironmentId={props.localEnvironmentId}
        onOpenThread={props.onOpenThread}
        disabled={!props.canOperate}
      />
    </span>
  );
}
