import { useEffect, useMemo, useRef } from "react";

import {
  groupSlowRpcAckRequests,
  type SlowRpcAckRequest,
  useSlowRpcAckRequests,
} from "../rpc/requestLatencyState";
import { useEnvironments } from "../state/environments";
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
  const { environments } = useEnvironments();
  const labels = useMemo(
    () =>
      new Map<string, string>(
        environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [environments],
  );
  const toastIdsRef = useRef(new Map<string | null, ToastId>());

  useEffect(() => {
    const toastIds = toastIdsRef.current;
    const groups = groupSlowRpcAckRequests(slowRequests);
    const live = new Set(groups.map((group) => group.environmentId));

    for (const [environmentId, toastId] of toastIds) {
      if (live.has(environmentId)) continue;
      toastManager.close(toastId);
      toastIds.delete(environmentId);
    }

    for (const group of groups) {
      const label = group.environmentId === null ? null : (labels.get(group.environmentId) ?? null);
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
      const existing = toastIds.get(group.environmentId);
      if (existing === undefined) toastIds.set(group.environmentId, toastManager.add(nextToast));
      else toastManager.update(existing, nextToast);
    }
  }, [slowRequests, labels]);

  useEffect(
    () => () => {
      for (const toastId of toastIdsRef.current.values()) toastManager.close(toastId);
      toastIdsRef.current.clear();
    },
    [],
  );

  return null;
}
