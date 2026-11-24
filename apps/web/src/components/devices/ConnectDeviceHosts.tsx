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
  connectDeviceTitle,
  connectDevices,
  laterKey,
  laterKeys,
  makeSeenNotices,
  noticeMessage,
  requestsToPrompt,
} from "../../studio/connectDevices";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type ConnectDevicesListActions,
  DeviceApprovalPrompt,
  DeviceWaitingList,
} from "./ConnectDeviceViews";
import {
  FLOATING_CODE_LAYER_CLASS,
  inlineCodeShown,
  inlineCodesVersion,
  subscribeInlineCodes,
} from "./inlineApprovalCode";
import { readOwnDeviceForJoinCodes } from "./closedJoinCodes";
import { makeLaterStore } from "./laterStore";
import { hideWaitingCodes, useWaitingCodeHidden, useWaitingCodes } from "./waitingCodes";
import { useOwnDeviceShortId } from "./ownDeviceId";

const POLL_MS = 4_000;
const HIDDEN_POLL_MS = 20_000;
/** Other machines are only watched for approval notices, so less often. */
const NOTICE_POLL = { visibleMs: 30_000, hiddenMs: 120_000 } as const;
const appStorage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const takeFreshNotices = makeSeenNotices(appStorage);
/** Later, kept across restarts so the pop-up does not come back for a device put off (1416). */
const laterStore = makeLaterStore(appStorage);
const NO_LATER: ReadonlySet<string> = new Set();
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

/** A polled device list, or why it could not be read, with the machine it came from. */
interface FromMachine<T> {
  readonly environmentId: EnvironmentId;
  readonly value: T;
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
  // Kept with the machine they came from, so a change of machine never shows the
  // last machine's list or error while the new one loads.
  const [loaded, setLoaded] = useState<FromMachine<ConnectDevicesSnapshot> | null>(null);
  const [failure, setFailure] = useState<FromMachine<string> | null>(null);
  const current = <T,>(entry: FromMachine<T> | null) =>
    enabled && entry !== null && entry.environmentId === environmentId ? entry.value : null;
  const snapshot = current(loaded);
  const error = current(failure);
  const generation = useRef(0);

  /** Reads the list again; answers with it only when this read is the one now shown. */
  const refresh = useCallback(async (): Promise<ConnectDevicesSnapshot | null> => {
    if (environmentId === null || !enabled) return null;
    const mine = ++generation.current;
    try {
      const next = await connectDevices.list(environmentId);
      if (mine !== generation.current) return null;
      setLoaded({ environmentId, value: next });
      setFailure(null);
      announceNotices(environmentId, next.notices);
      return next;
    } catch (cause) {
      if (mine !== generation.current) return null;
      setFailure({
        environmentId,
        value: cause instanceof Error ? cause.message : txNow("Could not reach this machine."),
      });
      return null;
    }
  }, [environmentId, enabled]);

  useEffect(() => {
    if (environmentId === null || !enabled) {
      setLoaded(null);
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
  refresh: () => Promise<unknown>,
  /** Told which device a typed code allowed, so the pop-up can name it (1406). */
  onApproved?: (device: ConnectDevice) => void,
): ConnectDevicesListActions {
  const tx = useTx();
  return {
    onApprove: async (code) => {
      try {
        const result = await connectDevices.approve(environmentId, code);
        const problem = approveOutcomeMessage(result, machine, tx);
        if (problem === null && result.device) {
          onApproved?.(result.device);
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: tx("{device} can now use {machine}", {
                device: connectDeviceTitle(result.device, tx),
                machine,
              }),
            }),
          );
        }
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
      const name = connectDeviceTitle(device, tx);
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
 * Pops up on this machine's own app as soon as a device asks: the waiting
 * devices not put off, one code box, a Deny per device. Later hides it for the
 * devices it lists, across restarts. A device that was not listed opens it for
 * itself only: the ones put off stay quiet, under Settings > Machines.
 */
export function DeviceApprovalPromptHost() {
  const environmentId = usePrimaryEnvironmentId();
  const supported = useDeviceApprovalSupported(environmentId);
  const { snapshot, refresh } = useConnectDevices(environmentId, supported);
  // What Later put off on this machine. A machine that keeps Later is the only
  // word on it; for one that keeps none, this window's storage is read on each
  // render, so a restart keeps it and an entry past its 30 days lets the pop-up back.
  const [, setLaterVersion] = useState(0);
  const later =
    environmentId === null ? NO_LATER : laterKeys(laterStore.keys(environmentId), snapshot?.later);
  // The requests this window closed while their machine is told, by request, so
  // the pop-up closes at once. Held in memory only, and a request is never
  // reused: nothing here can hide a request the device makes later.
  const [closed, setClosed] = useState<ReadonlySet<string>>(NO_LATER);
  // Devices allowed while this pop-up is open, so it can say which one a code let in.
  const [allowed, setAllowed] = useState<ReadonlyArray<ConnectDevice>>([]);
  const requests =
    environmentId === null || snapshot === null || !snapshot.canApprove
      ? []
      : requestsToPrompt(snapshot.pending, later).filter((request) => !closed.has(request.id));
  const open = requests.length > 0;
  // A closed pop-up forgets whom it allowed, so the next one starts clean.
  if (!open && allowed.length > 0) setAllowed([]);
  if (environmentId === null || snapshot === null || !open) return null;
  return (
    <DeviceApprovalPromptForMachine
      environmentId={environmentId}
      snapshot={snapshot}
      refresh={refresh}
      requests={requests}
      allowed={allowed}
      onApproved={(device) =>
        setAllowed((current) => [...current.filter((entry) => entry.key !== device.key), device])
      }
      laterOnMachine={snapshot.later !== undefined}
      onLater={() => {
        const ids = requests.map((request) => request.id);
        setClosed((current) => new Set([...current, ...ids]));
        if (snapshot.later === undefined) {
          // A machine that keeps no Later: this window keeps it across restarts.
          laterStore.add(environmentId, requests.map(laterKey));
          setLaterVersion((version) => version + 1);
          return;
        }
        // The machine keeps it, for every window, and ends it when the device is
        // settled. If it cannot be told, the pop-up stays closed in this window
        // for this request only.
        void connectDevices.later(environmentId, ids).then(refresh, () => undefined);
      }}
    />
  );
}

function DeviceApprovalPromptForMachine({
  environmentId,
  snapshot,
  refresh,
  requests,
  allowed,
  laterOnMachine,
  onApproved,
  onLater,
}: {
  environmentId: EnvironmentId;
  snapshot: ConnectDevicesSnapshot;
  refresh: () => Promise<ConnectDevicesSnapshot | null>;
  requests: ConnectDevicesSnapshot["pending"];
  allowed: ReadonlyArray<ConnectDevice>;
  laterOnMachine: boolean;
  onApproved: (device: ConnectDevice) => void;
  onLater: () => void;
}) {
  const actions = useConnectDevicesActions(environmentId, snapshot.machine, refresh, onApproved);
  const { environments } = useEnvironments();
  // A phone's hub by the name this app knows it under; unknown hubs read as "another machine".
  const hubName = (via: string) =>
    environments.find((environment) => environment.environmentId === via)?.label ?? null;
  const Prompt = hasCloudPublicConfig() ? DeviceApprovalPromptWithAccount : DeviceApprovalPrompt;
  return (
    <Prompt
      machine={snapshot.machine}
      hubName={hubName}
      requests={requests}
      allowed={allowed}
      laterOnMachine={laterOnMachine}
      onApprove={actions.onApprove}
      onDeny={actions.onDeny}
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

/**
 * On a device machines have not approved yet: one card with every machine it
 * waits on and that machine's code, and which device this is (1406). The ×,
 * Escape and a click outside close it; the join stays pending (see waitingCodes).
 */
export function DeviceWaitingForApprovalHost() {
  useSyncExternalStore(subscribeInlineCodes, inlineCodesVersion);
  const isHidden = useWaitingCodeHidden();
  const all = useWaitingCodes();
  // A new code can mean a new key on this device: read its ID again, so a card
  // closed as the old device shows for the new one.
  const asked = all.map((entry) => `${entry.id} ${entry.code}`).join("\n");
  useEffect(() => {
    if (asked !== "") void readOwnDeviceForJoinCodes();
  }, [asked]);
  const waiting = all.filter((entry) => !inlineCodeShown(entry.id) && !isHidden(entry));
  if (waiting.length === 0) return null;
  return <FloatingWaitingCard waiting={waiting} onClose={() => hideWaitingCodes(waiting)} />;
}

/**
 * Mounted only while a machine waits, so this device's ID is read then: a key
 * made at sign-in after the window opened still shows (1406).
 */
function FloatingWaitingCard({
  waiting,
  onClose,
}: {
  waiting: Parameters<typeof DeviceWaitingList>[0]["waiting"];
  onClose: () => void;
}) {
  const deviceId = useOwnDeviceShortId();
  const card = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && card.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);
  return (
    <div className={FLOATING_CODE_LAYER_CLASS} data-device-waiting-layer>
      <div ref={card} className="pointer-events-auto">
        <DeviceWaitingList waiting={waiting} deviceId={deviceId} onClose={onClose} />
      </div>
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
