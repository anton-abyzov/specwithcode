import { useAtomValue } from "@effect/atom-react";
import {
  computerUseHostPlatformFor,
  computerUseUnsupportedPlatformReason,
  isComputerUseSupportedHostPlatform,
  type ComputerUsePermission,
  type ComputerUsePermissions,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { CircleCheckIcon, MonitorIcon } from "lucide-react";
import { createContext, use, useState, useSyncExternalStore, type ReactNode } from "react";

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironment } from "../../state/environments";
import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { PermissionChecklist } from "../permissions/PermissionChecklist";
import { Button } from "../ui/button";

/** Sends a message to the agent in the open thread; absent where the user cannot send. */
export const ComputerUseRetryContext = createContext<((text: string) => void) | null>(null);

export const COMPUTER_USE_PERMISSION_COPY: Record<
  ComputerUsePermission,
  { readonly title: string; readonly purpose: string; readonly key: keyof ComputerUsePermissions }
> = {
  "screen-recording": {
    title: "Screen Recording",
    purpose: "Lets agents see the screen.",
    key: "screenRecording",
  },
  accessibility: {
    title: "Accessibility",
    purpose: "Lets agents click and type.",
    key: "accessibility",
  },
};

const ALL_PERMISSIONS: readonly ComputerUsePermission[] = ["screen-recording", "accessibility"];
const NONE_GRANTED: ComputerUsePermissions = { screenRecording: false, accessibility: false };

/** True when this window is the SpecWithCode desktop app on a Mac that can report the permissions. */
export function computerUsePermissionsAvailable(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.getComputerUsePermissions != null;
}

/**
 * True when the permissions shown here belong to the machine the thread runs
 * on: this desktop app only knows its own Mac's permissions.
 */
export function useComputerUsePermissionsAreLocal(environmentId: EnvironmentId | null): boolean {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  return (
    computerUsePermissionsAvailable() &&
    (environmentId === null || environmentId === primaryEnvironmentId)
  );
}

/**
 * The host platform of the machine being configured when computer use does not
 * work there, else null. The server's own OS decides, because agents act on the
 * desktop of the machine their server runs on.
 */
export function useComputerUseUnsupportedPlatform(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverOs = environment?.serverConfig?.environment.platform.os;
  const local = environmentId === null || environmentId === primaryEnvironmentId;
  const os =
    serverOs ??
    (local && typeof window !== "undefined"
      ? window.desktopBridge?.getClientPlatform?.()
      : undefined);
  if (os === undefined) return null;
  const platform = computerUseHostPlatformFor(os);
  return isComputerUseSupportedHostPlatform(platform) ? null : platform;
}

// One poll serves every card, banner and settings row on screen: each check
// starts a short child process on the desktop side.
const POLL_MS = 1_500;
let sharedStatus: ComputerUsePermissions = NONE_GRANTED;
let sharedError: string | null = null;
interface StatusSnapshot {
  readonly status: ComputerUsePermissions;
  readonly error: string | null;
}
let snapshot: StatusSnapshot = { status: sharedStatus, error: sharedError };
const statusListeners = new Set<() => void>();
let pollTimer: number | undefined;
let checking = false;

async function refreshSharedStatus() {
  if (checking || document.visibilityState === "hidden") return;
  const check = window.desktopBridge?.getComputerUsePermissions;
  if (!check) return;
  checking = true;
  try {
    const next = await check();
    const changed =
      next.screenRecording !== sharedStatus.screenRecording ||
      next.accessibility !== sharedStatus.accessibility ||
      sharedError !== null;
    sharedStatus = next;
    sharedError = null;
    if (changed) {
      snapshot = { status: sharedStatus, error: sharedError };
      for (const listener of statusListeners) listener();
    }
  } catch {
    if (sharedError === null) {
      sharedError = "Could not check permissions. Trying again automatically.";
      snapshot = { status: sharedStatus, error: sharedError };
      for (const listener of statusListeners) listener();
    }
  } finally {
    checking = false;
  }
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  if (statusListeners.size === 1) {
    void refreshSharedStatus();
    pollTimer = window.setInterval(() => void refreshSharedStatus(), POLL_MS);
    window.addEventListener("focus", refreshSharedStatus);
    document.addEventListener("visibilitychange", refreshSharedStatus);
  }
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0) {
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", refreshSharedStatus);
      document.removeEventListener("visibilitychange", refreshSharedStatus);
    }
  };
}

const subscribeNothing = () => () => {};
const idleSnapshot: StatusSnapshot = { status: NONE_GRANTED, error: null };

/** Live permission status, rechecked every 1.5 s while shown, and the actions that change it. */
export function useComputerUsePermissions(enabled = true) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const available = computerUsePermissionsAvailable();
  const live = enabled && available;
  const { status, error } = useSyncExternalStore(live ? subscribeStatus : subscribeNothing, () =>
    live ? snapshot : idleSnapshot,
  );
  const [requested, setRequested] = useState<ReadonlySet<ComputerUsePermission>>(new Set());
  const [reset, setReset] = useState<ReadonlySet<ComputerUsePermission>>(new Set());
  const [resetError, setResetError] = useState<string | null>(null);
  return {
    available,
    status,
    error,
    /** Permissions the user clicked Allow for in this view. */
    requested,
    request: (permission: ComputerUsePermission) => {
      setRequested((current) => new Set(current).add(permission));
      void bridge?.requestComputerUsePermission?.(permission).then(() => refreshSharedStatus());
    },
    /** Permissions the user reset in this view. */
    resetDone: reset,
    resetError,
    reset: bridge?.resetComputerUsePermission
      ? (permission: ComputerUsePermission) => {
          setReset((current) => new Set(current).add(permission));
          setResetError(null);
          void bridge
            .resetComputerUsePermission?.(permission)
            .catch((error: unknown) => {
              setReset((current) => {
                const next = new Set(current);
                next.delete(permission);
                return next;
              });
              setResetError(
                `Could not reset ${COMPUTER_USE_PERMISSION_COPY[permission].title}: ${
                  error instanceof Error ? error.message : String(error)
                }. Remove SpecWithCode from the list with the minus button, then click Allow.`,
              );
            })
            .finally(() => void refreshSharedStatus());
        }
      : undefined,
    relaunch: bridge?.relaunchForComputerUse
      ? () => void bridge.relaunchForComputerUse?.()
      : undefined,
  };
}

/**
 * The two macOS permissions computer use needs, each with its live status and
 * an Allow button that shows the macOS prompt or opens the matching Privacy &
 * Security pane with the drag-to-allow helper.
 */
export function ComputerUsePermissionChecklist({
  permissions = ALL_PERMISSIONS,
  state,
}: {
  permissions?: readonly ComputerUsePermission[];
  state: ReturnType<typeof useComputerUsePermissions>;
}) {
  const pending = (permission: ComputerUsePermission) =>
    permissions.includes(permission) &&
    state.requested.has(permission) &&
    !state.status[COMPUTER_USE_PERMISSION_COPY[permission].key];
  const screenRecordingPending = pending("screen-recording");
  // A switch that reads as on while macOS still refuses belongs to another
  // build of the app; only a reset ties a new switch to this one.
  const stale = permissions.filter(pending);
  return (
    <div className="space-y-2">
      <PermissionChecklist
        permissions={permissions.map((permission) => {
          const copy = COMPUTER_USE_PERMISSION_COPY[permission];
          const Icon =
            permission === "accessibility" ? MacAccessibilityIcon : MacScreenRecordingIcon;
          return {
            id: permission,
            icon: <Icon className="size-8 shrink-0 drop-shadow-sm" />,
            title: copy.title,
            description: state.requested.has(permission)
              ? "Turn on SpecWithCode in the list System Settings opened."
              : copy.purpose,
            granted: state.status[copy.key],
            onAllow: () => state.request(permission),
          };
        })}
      />
      {screenRecordingPending && state.relaunch ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          Already turned it on? macOS applies Screen Recording after the app reopens.
          <Button size="xs" variant="outline" onClick={state.relaunch}>
            Quit &amp; Reopen
          </Button>
        </p>
      ) : null}
      {state.reset
        ? stale.map((permission) => (
            <p
              key={permission}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
            >
              {state.resetDone.has(permission)
                ? `Reset. Turn SpecWithCode on again in the ${COMPUTER_USE_PERMISSION_COPY[permission].title} list.`
                : `SpecWithCode already on in the ${COMPUTER_USE_PERMISSION_COPY[permission].title} list? macOS is keeping that switch for another build of the app.`}
              {state.resetDone.has(permission) ? null : (
                <Button size="xs" variant="outline" onClick={() => state.reset?.(permission)}>
                  Reset and ask again
                </Button>
              )}
            </p>
          ))
        : null}
      {state.resetError ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.resetError}
        </p>
      ) : null}
      {state.error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

function RemoteHint({
  environmentId,
  permission,
}: {
  environmentId: EnvironmentId | null;
  permission: ComputerUsePermission;
}) {
  const machine = useEnvironment(environmentId)?.label ?? "that Mac";
  return (
    <p className="text-muted-foreground">
      On {machine}, open the SpecWithCode app and allow{" "}
      {COMPUTER_USE_PERMISSION_COPY[permission].title} for it in System Settings &gt; Privacy &amp;
      Security, then ask the agent to try again.
    </p>
  );
}

const RETRY_MESSAGE: Record<ComputerUsePermission, string> = {
  "screen-recording": "Screen Recording is allowed for SpecWithCode now. Please try again.",
  accessibility: "Accessibility is allowed for SpecWithCode now. Please try again.",
};

/**
 * Shown under a `computer_*` tool that failed because SpecWithCode was missing
 * a macOS permission. Allow fixes it on this Mac; once allowed, one click asks
 * the agent to try again.
 */
export function ComputerUsePermissionCard({
  permission,
  environmentId,
}: {
  permission: ComputerUsePermission;
  environmentId: EnvironmentId | null;
}) {
  const local = useComputerUsePermissionsAreLocal(environmentId);
  const state = useComputerUsePermissions(local);
  const retry = use(ComputerUseRetryContext);
  const [retried, setRetried] = useState(false);
  const copy = COMPUTER_USE_PERMISSION_COPY[permission];
  const granted = local && state.status[copy.key];
  let body: ReactNode;
  if (!local) {
    body = <RemoteHint environmentId={environmentId} permission={permission} />;
  } else if (!granted) {
    body = (
      <>
        <p className="text-muted-foreground">
          The agent stopped waiting. Allow it here, then ask the agent to try again.
        </p>
        <ComputerUsePermissionChecklist permissions={[permission]} state={state} />
      </>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-success-foreground">
          <CircleCheckIcon className="size-4" aria-hidden="true" />
          {copy.title} is allowed.
        </span>
        {retry ? (
          <Button
            size="sm"
            variant="outline"
            disabled={retried}
            onClick={() => {
              setRetried(true);
              retry(RETRY_MESSAGE[permission]);
            }}
          >
            {retried ? "Asked the agent" : "Ask the agent to try again"}
          </Button>
        ) : (
          <span className="text-muted-foreground">Send a message to try again.</span>
        )}
      </div>
    );
  }
  return (
    <div
      role="note"
      data-testid="computer-use-permission-card"
      className="my-1 space-y-2 rounded-lg border border-warning/30 bg-warning/6 px-3 py-2 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <MonitorIcon className="size-4 shrink-0 text-warning-foreground" aria-hidden="true" />
        Computer use needs {copy.title}
      </p>
      {body}
    </div>
  );
}

/** The composer notice while a computer-use action in this thread waits for a permission. */
export function ComputerUsePermissionWaitNotice({
  permission,
}: {
  permission: ComputerUsePermission;
}) {
  const state = useComputerUsePermissions(true);
  return <ComputerUsePermissionChecklist permissions={[permission]} state={state} />;
}

/**
 * The permission check under Settings and on the Connections computer-use row.
 * Only the desktop app on the Mac being configured can read or ask for them.
 */
export function ComputerUsePermissionSetup({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const unsupported = useComputerUseUnsupportedPlatform(environmentId);
  const local = useComputerUsePermissionsAreLocal(environmentId);
  const state = useComputerUsePermissions(local && unsupported === null);
  const machine = useEnvironment(environmentId)?.label ?? "that Mac";
  if (unsupported !== null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="computer-use-unsupported">
        {computerUseUnsupportedPlatformReason(unsupported)} Agents on this machine cannot see or
        control its desktop.
      </p>
    );
  }
  if (!local) {
    return (
      <p className="text-xs text-muted-foreground">
        macOS lets agents use the screen only after you allow Screen Recording and Accessibility for
        SpecWithCode. Open the SpecWithCode app on {machine} to check them.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="computer-use-permission-setup">
      <ComputerUsePermissionChecklist state={state} />
      {state.status.screenRecording && state.status.accessibility ? (
        <p className="text-xs text-muted-foreground">Agents can see and control this Mac.</p>
      ) : null}
    </div>
  );
}

/**
 * Under the Connections `computer-use` row. Those entries are Codex's and
 * Claude Code's own helpers; agents in SpecWithCode use the app's computer use
 * whatever they say, and that only needs the two macOS permissions.
 */
export function ComputerUseConnectionNote({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        These entries are Codex&apos;s and Claude Code&apos;s own computer-use helpers, and they can
        stay as they are. Agents in SpecWithCode, with any provider, use the app&apos;s built-in
        computer use, which is on in Settings &gt; Agent computer access and only needs these macOS
        permissions.
      </p>
      <ComputerUsePermissionSetup environmentId={environmentId} />
    </div>
  );
}
