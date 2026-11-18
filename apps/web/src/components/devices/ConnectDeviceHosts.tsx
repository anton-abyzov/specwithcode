/**
 * The always-mounted parts of device approval (1327): the pop-up on the machine
 * a device asks to use, and the card on a device that is waiting for one.
 */
import { useUser } from "@clerk/react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { txNow, useTx } from "../../i18n";

import { requestConfirmDialog } from "../../confirmDialog";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  type ConnectDevice,
  type ConnectDevicesSnapshot,
  approveOutcomeMessage,
  connectDeviceName,
  connectDevices,
  makeSeenNotices,
  noticeMessage,
} from "../../studio/connectDevices";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type ConnectDevicesListActions,
  DeviceApprovalPrompt,
  DeviceWaitingCard,
} from "./ConnectDeviceViews";
import { inlineCodeShown, inlineCodesVersion, subscribeInlineCodes } from "./inlineApprovalCode";

const POLL_MS = 4_000;
const HIDDEN_POLL_MS = 20_000;
/** Other machines are only watched for approval notices, so less often. */
const NOTICE_POLL = { visibleMs: 30_000, hiddenMs: 120_000 } as const;
const takeFreshNotices = makeSeenNotices(() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
});

/** "New device approved on m4 by Anton's MacBook", once per notice on this device. */
function announceNotices(environmentId: EnvironmentId, notices: ConnectDevicesSnapshot["notices"]) {
  for (const notice of takeFreshNotices(environmentId, notices))
    toastManager.add(stackedThreadToast({ type: "info", title: noticeMessage(notice, txNow) }));
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
      setError(cause instanceof Error ? cause.message : txNow("Could not reach this machine."));
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
      description: cause instanceof Error ? cause.message : txNow("Try again."),
    }),
  );

/** The list's actions for one machine, each refreshing the list afterwards. */
export function useConnectDevicesActions(
  environmentId: EnvironmentId,
  machine: string,
  refresh: () => Promise<void>,
): ConnectDevicesListActions {
  const tx = useTx();
  return {
    onApprove: async (code) => {
      try {
        const result = await connectDevices.approve(environmentId, code);
        const problem = approveOutcomeMessage(result, machine, tx);
        if (problem === null && result.device)
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: tx("{device} can now use {machine}", {
                device: connectDeviceName(result.device, tx),
                machine,
              }),
            }),
          );
        return problem;
      } catch (cause) {
        return cause instanceof Error
          ? cause.message
          : tx("Could not reach this machine. Try again.");
      } finally {
        await refresh();
      }
    },
    onDeny: async (requestId) => {
      try {
        await connectDevices.deny(environmentId, requestId);
      } catch (cause) {
        failed(tx("Could not turn that device away"), cause);
      }
      await refresh();
    },
    onRemove: async (device: ConnectDevice) => {
      const name = connectDeviceName(device, tx);
      const confirmed = await requestConfirmDialog(
        `${tx("Remove {device}?", { device: name })}\n${tx(
          "It stops using {machine} right away. To use it again, it asks with a new code.",
          { machine },
        )}`,
        { variant: "destructive", confirmLabel: tx("Remove") },
      );
      if (confirmed !== true) return;
      try {
        await connectDevices.remove(environmentId, device.key);
      } catch (cause) {
        failed(tx("Could not remove {device}", { device: name }), cause);
      }
      await refresh();
    },
    onConfirmReview: async () => {
      try {
        await connectDevices.confirmReview(environmentId);
      } catch (cause) {
        failed(tx("Could not save the list"), cause);
      }
      await refresh();
    },
    onRepair: async () => {
      try {
        await connectDevices.repair(environmentId);
      } catch (cause) {
        failed(tx("Could not repair the list"), cause);
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
  const { environments } = useEnvironments();
  // A phone's hub by the name this app knows it under; unknown hubs read as "another machine".
  const hub =
    request.via === undefined
      ? null
      : (environments.find((environment) => environment.environmentId === request.via)?.label ??
        null);
  return hasCloudPublicConfig() ? (
    <DeviceApprovalPromptWithAccount
      machine={snapshot.machine}
      hub={hub}
      request={request}
      position={position}
      total={total}
      onApprove={actions.onApprove}
      onDeny={() => actions.onDeny(request.id)}
      onLater={onLater}
    />
  ) : (
    <DeviceApprovalPrompt
      machine={snapshot.machine}
      hub={hub}
      request={request}
      position={position}
      total={total}
      onApprove={actions.onApprove}
      onDeny={() => actions.onDeny(request.id)}
      onLater={onLater}
    />
  );
}

/**
 * Names the Connect account in the pop-up (1327). A Connect device can only
 * reach this machine signed in to the account this machine is signed in to.
 */
function DeviceApprovalPromptWithAccount(
  props: Omit<Parameters<typeof DeviceApprovalPrompt>[0], "account">,
) {
  const { user } = useUser();
  return (
    <DeviceApprovalPrompt {...props} account={user?.primaryEmailAddress?.emailAddress ?? null} />
  );
}

/** On a device a machine has not approved yet: where to go, and the code to type there. */
export function DeviceWaitingForApprovalHost() {
  const { environments } = useEnvironments();
  useSyncExternalStore(subscribeInlineCodes, inlineCodesVersion);
  const waiting = environments.filter(
    (environment) =>
      environment.connection.deviceApprovalCode !== undefined &&
      !inlineCodeShown(environment.environmentId),
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
