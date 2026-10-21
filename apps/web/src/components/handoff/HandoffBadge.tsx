import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { useState } from "react";

import {
  handoffBadgeFor,
  handoffMode,
  incomingReplicaFor,
  runHandoffMode,
  unreachableBadgeFor,
  useHandoffModeSnapshot,
  type HandoffBadgeView,
} from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The handoff badge for a thread. `localEnvironmentId` is the machine this
 * window serves; it holds the checkpoints other machines replicated here, so a
 * thread whose own machine went silent can still read "Handoff ready".
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
  // "Checkpoint behind" names each machine that lags and why on hover.
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

/**
 * The one-click action a badge offers: open the continuation, continue an
 * unreachable machine's thread here, or resume a paused machine anyway.
 */
export function HandoffBadgeActions(props: HandoffBadgeActionsProps) {
  const [busy, setBusy] = useState(false);
  const { badge } = props;
  const className = props.className ?? "sws-chip sws-handoff-action";
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
        <button
          type="button"
          className={className}
          onClick={() => props.onOpenThread(badge.threadId, badge.environmentId)}
        >
          Open continuation
        </button>
      );
    case "source-unreachable": {
      const local = props.localEnvironmentId;
      if (local === null) return null;
      return (
        <button
          type="button"
          className={className}
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
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Couldn't continue here",
                    description: result.error,
                  }),
                );
                return;
              }
              if (result.value.notice)
                toastManager.add(
                  stackedThreadToast({ type: "success", title: result.value.notice }),
                );
              props.onOpenThread(result.value.threadId, result.value.environmentId);
            })
          }
        >
          {busy ? "Continuing…" : "Continue here"}
        </button>
      );
    }
    case "paused": {
      const environmentId = props.environmentId;
      if (environmentId === null) return null;
      return (
        <button
          type="button"
          className={className}
          disabled={busy || props.disabled}
          onClick={() =>
            void run(async () => {
              const result = await runHandoffMode(handoffMode.resumeFenced, {
                environmentId,
                input: {},
              });
              if (!result.ok)
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: "Couldn't continue",
                    description: result.error,
                  }),
                );
            })
          }
        >
          {busy ? "Continuing…" : "Continue here anyway"}
        </button>
      );
    }
    default:
      return null;
  }
}

/** Badge plus its action, for the thread header. */
export function HandoffThreadHeaderBadge(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  localEnvironmentId: EnvironmentId | null;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  canOperate: boolean;
}) {
  const badge = useHandoffBadge(props.environmentId, props.threadId, props.localEnvironmentId);
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
  return badge ? <HandoffBadgeChip badge={badge} className="sws-chip" /> : null;
}

/** The row's one-click action beside its open button: "Continue here" and friends. */
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
  return (
    <HandoffBadgeActions
      badge={badge}
      environmentId={props.environmentId}
      localEnvironmentId={props.localEnvironmentId}
      onOpenThread={props.onOpenThread}
      className="sws-thread-handoff-action"
      disabled={!props.canOperate}
    />
  );
}
