/**
 * The always-mounted parts of device approval (1327): the pop-up on the machine
 * a device asks to use, and the card on a device that is waiting for one.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  type ConnectDevice,
  type ConnectDevicesSnapshot,
  approveOutcomeMessage,
  connectDevices,
  describeConnectDevice,
  takeUnseenNotices,
} from "../../studio/connectDevices";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type ConnectDevicesListActions,
  DeviceApprovalPrompt,
  DeviceWaitingCard,
} from "./ConnectDeviceViews";

const POLL_MS = 4_000;
const HIDDEN_POLL_MS = 20_000;
/** Other machines are only watched for approval notices, so less often. */
const NOTICE_POLL = { visibleMs: 30_000, hiddenMs: 120_000 } as const;
const SEEN_NOTICES_KEY = "specwithcode:connect-device-notices-seen";

function readSeenNotices(): Record<string, ReadonlyArray<string>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEEN_NOTICES_KEY) ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, ReadonlyArray<string>>)
      : {};
  } catch {
    return {};
  }
}

/** "New device approved on m4 by Anton's MacBook", once per notice on this device. */
function announceNotices(environmentId: EnvironmentId, notices: ConnectDevicesSnapshot["notices"]) {
  if (notices.length === 0) return;
  const all = readSeenNotices();
  const before = Array.isArray(all[environmentId]) ? all[environmentId] : [];
  const { fresh, seen } = takeUnseenNotices(before, notices);
  if (fresh.length === 0) return;
  try {
    localStorage.setItem(SEEN_NOTICES_KEY, JSON.stringify({ ...all, [environmentId]: seen }));
  } catch {
    // Without storage a notice may show again after a reload; never more than once a session.
  }
  for (const notice of fresh)
    toastManager.add(stackedThreadToast({ type: "info", title: notice.message }));
}

/** True when that machine's server checks new devices; older ones never answer the list. */
export function useDeviceApprovalSupported(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  if (environmentId === null) return false;
  return configs.get(environmentId)?.environment.capabilities.deviceApproval === true;
}

/** Polls one machine's device list while mounted; faster while the window is in view. */
export function useConnectDevices(
  environmentId: EnvironmentId | null,
  enabled: boolean,
  poll: { readonly visibleMs: number; readonly hiddenMs: number } = {
    visibleMs: POLL_MS,
    hiddenMs: HIDDEN_POLL_MS,
  },
) {
  const { visibleMs, hiddenMs } = poll;
  const [snapshot, setSnapshot] = useState<ConnectDevicesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (environmentId === null || !enabled) return;
    const mine = ++generation.current;
    try {
      const next = await connectDevices.list(environmentId);
      if (mine !== generation.current) return;
      setSnapshot(next);
      setError(null);
      announceNotices(environmentId, next.notices);
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(cause instanceof Error ? cause.message : "Could not reach this machine.");
    }
  }, [environmentId, enabled]);

  useEffect(() => {
    if (environmentId === null || !enabled) {
      setSnapshot(null);
      return;
    }
    let timer: number | undefined;
    let stopped = false;
    const tick = async () => {
      await refresh();
      if (stopped) return;
      timer = window.setTimeout(
        () => void tick(),
        document.visibilityState === "visible" ? visibleMs : hiddenMs,
      );
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [environmentId, enabled, refresh, visibleMs, hiddenMs]);

  return { snapshot, error, refresh };
}

const failed = (title: string, cause: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: cause instanceof Error ? cause.message : "Try again.",
    }),
  );

/** The list's actions for one machine, each refreshing the list afterwards. */
export function useConnectDevicesActions(
  environmentId: EnvironmentId,
  machine: string,
  refresh: () => Promise<void>,
): ConnectDevicesListActions {
  return {
    onApprove: async (code) => {
      try {
        const result = await connectDevices.approve(environmentId, code);
        const problem = approveOutcomeMessage(result, machine);
        if (problem === null && result.device)
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${describeConnectDevice(result.device)} can now use ${machine}`,
            }),
          );
        return problem;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Could not reach this machine. Try again.";
      } finally {
        await refresh();
      }
    },
    onDeny: async (requestId) => {
      try {
        await connectDevices.deny(environmentId, requestId);
      } catch (cause) {
        failed("Could not turn that device away", cause);
      }
      await refresh();
    },
    onRemove: async (device: ConnectDevice) => {
      const confirmed = await requestConfirmDialog(
        `Remove ${device.label}?\nIt stops using ${machine} right away. To use it again, it asks with a new code.`,
        { variant: "destructive", confirmLabel: "Remove" },
      );
      if (confirmed !== true) return;
      try {
        await connectDevices.remove(environmentId, device.key);
      } catch (cause) {
        failed(`Could not remove ${device.label}`, cause);
      }
      await refresh();
    },
    onConfirmReview: async () => {
      try {
        await connectDevices.confirmReview(environmentId);
      } catch (cause) {
        failed("Could not save the list", cause);
      }
      await refresh();
    },
    onRepair: async () => {
      try {
        await connectDevices.repair(environmentId);
      } catch (cause) {
        failed("Could not repair the list", cause);
      }
      await refresh();
    },
  };
}

/**
 * Pops up on this machine's own app as soon as a device asks, with the code box,
 * Allow and Deny. Later hides a request until a new one comes.
 */
export function DeviceApprovalPromptHost() {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useDeviceApprovalSupported(environmentId);
  const { snapshot, refresh } = useConnectDevices(environmentId, supported);
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());
  if (environmentId === null || snapshot === null || !snapshot.canApprove) return null;
  const waiting = snapshot.pending.filter((request) => !later.has(request.id));
  const request = waiting[0];
  if (!request) return null;
  return (
    <DeviceApprovalPromptForMachine
      environmentId={environmentId}
      snapshot={snapshot}
      refresh={refresh}
      request={request}
      position={snapshot.pending.indexOf(request) + 1}
      total={snapshot.pending.length}
      onLater={() => setLater((current) => new Set([...current, request.id]))}
    />
  );
}

function DeviceApprovalPromptForMachine({
  environmentId,
  snapshot,
  refresh,
  request,
  position,
  total,
  onLater,
}: {
  environmentId: EnvironmentId;
  snapshot: ConnectDevicesSnapshot;
  refresh: () => Promise<void>;
  request: ConnectDevicesSnapshot["pending"][number];
  position: number;
  total: number;
  onLater: () => void;
}) {
  const actions = useConnectDevicesActions(environmentId, snapshot.machine, refresh);
  return (
    <DeviceApprovalPrompt
      machine={snapshot.machine}
      request={request}
      position={position}
      total={total}
      onApprove={actions.onApprove}
      onDeny={() => actions.onDeny(request.id)}
      onLater={onLater}
    />
  );
}

/** On a device a machine has not approved yet: where to go, and the code to type there. */
export function DeviceWaitingForApprovalHost() {
  const { environments } = useEnvironments();
  const waiting = environments.filter(
    (environment) => environment.connection.deviceApprovalCode !== undefined,
  );
  if (waiting.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2">
      {waiting.map((environment) => (
        <div key={environment.environmentId} className="pointer-events-auto">
          <DeviceWaitingCard
            machine={environment.label}
            code={environment.connection.deviceApprovalCode ?? ""}
          />
        </div>
      ))}
    </div>
  );
}

function DeviceNoticesWatcher({ environmentId }: { environmentId: EnvironmentId }) {
  useConnectDevices(environmentId, true, NOTICE_POLL);
  return null;
}

/**
 * On this device, for each other machine it is approved on: shows that
 * machine's "New device approved" notices once each. The pop-up host already
 * covers this machine's own list.
 */
export function DeviceApprovalNoticesHost() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  const watched = environments.filter(
    (environment) =>
      environment.environmentId !== primary &&
      environment.connection.phase === "connected" &&
      environment.connection.deviceApprovalCode === undefined &&
      configs.get(environment.environmentId)?.environment.capabilities.deviceApproval === true,
  );
  return (
    <>
      {watched.map((environment) => (
        <DeviceNoticesWatcher
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}
