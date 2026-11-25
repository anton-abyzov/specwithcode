/**
 * What a screen sharing view (1490) takes from the browser: the way to the
 * machine's server, this device's key, the machine keys saved here, the clock.
 */
import { SCREEN_SHARE_VIEW_PATH, type EnvironmentId } from "@specweave-studio/contracts";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@specweave-studio/client-runtime/state/deviceHubAccess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { readStoredBrowserDpopKey, signBytesWithDeviceKey } from "../../cloud/dpop";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentSession } from "../../state/session";
import type { ScreenViewerDeps, ScreenViewerSocket } from "./screenShareClient";
import { screenShareMachineKeyStorageKey } from "./screenViewer.logic";

// A ticket is for one connection: every view asks for a new one.
const screenShareAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: SCREEN_SHARE_VIEW_PATH });
    })
    .pipe(Atom.setIdleTTL(5_000), Atom.withLabel(`screen-share-access:${environmentId}`)),
);

const readScreenShareAccess = (environmentId: EnvironmentId): Promise<DeviceHubAccess | null> => {
  const atom = screenShareAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
};

const openBrowserSocket = (url: string): ScreenViewerSocket => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let closed = false;
  const socket: ScreenViewerSocket = {
    send: (bytes) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    },
    close: () => ws.close(),
    onText: null,
    onBinary: null,
    onClose: null,
  };
  const done = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    socket.onClose?.(code, reason);
  };
  ws.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") socket.onText?.(data);
    else if (data instanceof ArrayBuffer) socket.onBinary?.(new Uint8Array(data));
  });
  ws.addEventListener("close", (event) => done(event.code, event.reason));
  ws.addEventListener("error", () => done(1006, ""));
  return socket;
};

/** The saved machine keys, in this browser profile's storage. Public keys only. */
export const browserMachineKeyPins: ScreenViewerDeps["pins"] & {
  readonly forget: (environmentId: string) => void;
} = {
  read: (environmentId) => {
    try {
      return localStorage.getItem(screenShareMachineKeyStorageKey(environmentId)) ?? undefined;
    } catch {
      return undefined;
    }
  },
  write: (environmentId, machineKey) => {
    try {
      localStorage.setItem(screenShareMachineKeyStorageKey(environmentId), machineKey);
    } catch {
      // Not kept: the next view is a first time again, with the code.
    }
  },
  forget: (environmentId) => {
    try {
      localStorage.removeItem(screenShareMachineKeyStorageKey(environmentId));
    } catch {
      // Nothing was kept.
    }
  },
};

/** What a view needs from this browser: the way to the machine, this device's key, the saved keys, the clock. */
export const browserScreenViewerDeps = (
  environmentId: EnvironmentId,
): Pick<ScreenViewerDeps, "environmentId" | "open" | "deviceKey" | "pins" | "now" | "every"> => ({
  environmentId,
  open: async () => {
    const access = await readScreenShareAccess(environmentId);
    return access === null ? null : openBrowserSocket(withDeviceHubQuery(access.wsBase, access));
  },
  deviceKey: async () => {
    const key = await Effect.runPromise(readStoredBrowserDpopKey());
    return key === null
      ? null
      : { publicJwk: key.publicJwk, sign: (data) => signBytesWithDeviceKey(key, data) };
  },
  pins: browserMachineKeyPins,
  now: () => Date.now(),
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
});
