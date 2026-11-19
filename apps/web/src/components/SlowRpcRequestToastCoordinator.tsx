import { useEffect, useMemo, useRef } from "react";

import {
  groupSlowRpcAckRequests,
  type SlowRpcAckRequest,
  useSlowRpcAckRequests,
} from "../rpc/requestLatencyState";
import { useNamedEnvironments } from "./settings/useNamedEnvironments";
import { toastManager } from "./ui/toast";

type ToastId = ReturnType<typeof toastManager.add>;

function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );

  return `${count} request${count === 1 ? "" : "s"} waiting longer than ${thresholdSeconds}s.`;
}

/**
 * The warning names the machine that is slow, so a window that waits on
 * another machine does not read as a problem with its own connection.
 */
export function slowMachineTitle(label: string | null): string {
  return label ? `${label} is slow to answer` : "A machine is slow to answer";
}

function SlowRequestDetails({ requests }: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  return (
    <ul className="space-y-2.5 text-xs text-muted-foreground">
      {requests.map((request) => (
        <li
          className="min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0"
          key={request.requestId}
        >
          <div className="wrap-break-word font-medium text-foreground">{request.tag}</div>
          <div className="mt-0.5 text-3xs opacity-75">
            Started {new Date(request.startedAt).toLocaleTimeString()}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * One warning per machine this window is waiting on. Each window tracks only
 * the requests it sent, so a machine shows up here only in windows that are
 * actually waiting on it.
 */
export function SlowRpcRequestToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  // Named as the sidebar names them ("m4"), not by host label.
  const { environments } = useNamedEnvironments();
  const labels = useMemo(
    () =>
      new Map<string, string>(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  /** The warning on screen for each machine, and the requests it lists. */
  const shownRef = useRef(
    new Map<string | null, { id: ToastId; requestIds: ReadonlySet<string> }>(),
  );
  /**
   * Requests the user already dismissed a machine's warning for. The warning
   * stays away until that machine has a slow request the user has not seen.
   */
  const dismissedRef = useRef(new Map<string | null, ReadonlySet<string>>());

  useEffect(() => {
    const shown = shownRef.current;
    const dismissed = dismissedRef.current;
    const groups = groupSlowRpcAckRequests(slowRequests);
    const live = new Set(groups.map((group) => group.environmentId));

    for (const [environmentId, toast] of shown) {
      if (live.has(environmentId)) continue;
      // Forget it first, so its removal does not read as a dismissal.
      shown.delete(environmentId);
      toastManager.close(toast.id);
    }
    for (const environmentId of dismissed.keys()) {
      if (!live.has(environmentId)) dismissed.delete(environmentId);
    }

    for (const group of groups) {
      const environmentId = group.environmentId;
      const requestIds = new Set(group.requests.map((request) => request.requestId));
      const seen = dismissed.get(environmentId);
      if (seen && [...requestIds].every((requestId) => seen.has(requestId))) continue;
      dismissed.delete(environmentId);

      const label = environmentId === null ? null : (labels.get(environmentId) ?? environmentId);
      const nextToast = {
        data: {
          expandableContent: <SlowRequestDetails requests={group.requests} />,
          expandableDescriptionTrigger: true,
          expandableLabels: { collapse: "Hide requests", expand: "Show requests" },
        },
        description: describeSlowRequests(group.requests),
        timeout: 0,
        title: slowMachineTitle(label),
        type: "warning" as const,
      };
      const existing = shown.get(environmentId);
      if (existing) {
        toastManager.update(existing.id, nextToast);
        shown.set(environmentId, { id: existing.id, requestIds });
        continue;
      }
      const id: ToastId = toastManager.add({
        ...nextToast,
        onClose: () => {
          const current = shown.get(environmentId);
          if (current?.id !== id) return;
          // Still shown when it went away: the user dismissed it.
          shown.delete(environmentId);
          dismissed.set(environmentId, current.requestIds);
        },
      });
      shown.set(environmentId, { id, requestIds });
    }
  }, [slowRequests, labels]);

  useEffect(
    () => () => {
      const toasts = [...shownRef.current.values()];
      shownRef.current.clear();
      for (const toast of toasts) toastManager.close(toast.id);
    },
    [],
  );

  return null;
}
