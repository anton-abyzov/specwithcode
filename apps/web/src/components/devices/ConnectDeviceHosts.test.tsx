// @vitest-environment jsdom
import type {
  ConnectDevice,
  ConnectDeviceRequest,
  ConnectDevicesSnapshot,
} from "@specweave-studio/contracts/connectDevices";
import * as Effect from "effect/Effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One machine's device list and this window's stored key, as the hosts see them. */
const world = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    pending: [] as ConnectDeviceRequest[],
    /** The waiting list of a second machine, for a change of primary machine. */
    otherPending: [] as ConnectDeviceRequest[],
    primary: "env-m4",
    /** A machine whose list cannot be read, and one whose answer is held back. */
    failing: null as string | null,
    held: null as { environmentId: string; release: Promise<void> } | null,
    log: [] as string[],
    /** What the machine keeps of Later; undefined for a machine that keeps none. */
    machineLater: undefined as string[] | undefined,
    laterFails: false,
    key: null as { thumbprint: string } | null,
    environments: [] as Array<{
      environmentId: string;
      label: string;
      connection: { deviceApprovalCode?: string };
    }>,
  };
  return {
    state,
    listeners,
    setEnvironments(next: typeof state.environments) {
      state.environments = next;
      for (const listener of listeners) listener();
    },
    setPrimary(next: string) {
      state.primary = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@clerk/react", () => ({ useUser: () => ({ user: null }) }));
vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: async () => false }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: () => undefined },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map(
      ["env-m4", "env-m5"].map((id) => [
        id,
        { environment: { capabilities: { deviceApproval: true } } },
      ]),
    ),
}));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  };
  return {
    usePrimaryEnvironmentId: () => useSyncExternalStore(subscribe, () => world.state.primary),
    useEnvironments: () => ({
      environments: useSyncExternalStore(subscribe, () => world.state.environments),
    }),
  };
});
vi.mock("../../cloud/dpop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/dpop")>()),
  readStoredBrowserDpopKey: () => Effect.succeed(world.state.key),
}));
vi.mock("../../studio/connectDevices", async () => {
  const logic = await import("../../studio/connectDevices.logic");
  const CODES: Record<string, string> = { K7QX2M: "request-a", P4RT9W: "request-b" };
  const snapshot = (environmentId: string): ConnectDevicesSnapshot => ({
    machine: environmentId === "env-m4" ? "m4" : "m5",
    health: "ok",
    devices: [],
    pending: [...(environmentId === "env-m4" ? world.state.pending : world.state.otherPending)],
    needsReview: false,
    notices: [],
    canApprove: true,
    canRepair: true,
    ...(environmentId === "env-m4" && world.state.machineLater !== undefined
      ? { later: [...world.state.machineLater] }
      : {}),
  });
  return {
    ...logic,
    connectDevices: {
      list: async (environmentId: string) => {
        if (world.state.failing === environmentId) throw new Error(`${environmentId} is offline`);
        if (world.state.held?.environmentId === environmentId) await world.state.held.release;
        return snapshot(environmentId);
      },
      approve: async (_environmentId: string, code: string) => {
        const id = CODES[code.replace(/[\s-]/g, "").toUpperCase()];
        const match = world.state.pending.find((request) => request.id === id);
        if (match === undefined) return { status: "not-found" };
        world.state.log.push(`approve ${match.id}`);
        world.state.pending = world.state.pending.filter((request) => request.id !== match.id);
        const device: ConnectDevice = {
          key: `jkt:${match.id}`,
          kind: match.kind,
          label: match.label,
          named: true,
          deviceType: "mobile",
          system: "iOS",
          app: "SpecWithCode",
          ...(match.shortId === undefined ? {} : { shortId: match.shortId }),
          approvedAt: "2026-11-19T06:00:00.000Z",
          approvedBy: "this machine",
          keptByUpdate: false,
        };
        return { status: "approved", device };
      },
      later: async (_environmentId: string, devices: ReadonlyArray<string>) => {
        if (world.state.laterFails) throw new Error("offline");
        world.state.log.push(`later ${devices.join(" ")}`);
        world.state.machineLater = [...(world.state.machineLater ?? []), ...devices];
        return { done: true };
      },
      deny: async (_environmentId: string, requestId: string) => {
        world.state.log.push(`deny ${requestId}`);
        world.state.pending = world.state.pending.filter((request) => request.id !== requestId);
        return { denied: true };
      },
    },
  };
});

import {
  DeviceApprovalPromptHost,
  DeviceWaitingForApprovalHost,
  useConnectDevices,
} from "./ConnectDeviceHosts";
import { usePrimaryEnvironmentId } from "../../state/environments";

const phone = (id: string, shortId: string, askedAt: string): ConnectDeviceRequest => ({
  id,
  kind: "connect",
  label: "iPhone",
  named: true,
  deviceType: "mobile",
  system: "iOS",
  app: "SpecWithCode",
  shortId,
  device: `reference-of-${id}`,
  askedAt,
  expiresAt: "2026-11-19T06:30:00.000Z",
});
const first = phone("request-a", "TSKR", "2026-11-19T06:00:00.000Z");
const second = phone("request-b", "9229", "2026-11-19T06:01:00.000Z");

let root: Root | null = null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const mount = async (host: () => React.ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(host());
    await settle();
  });
};
const unmount = async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
};
/** The host reads the machine again when the window comes back into view. */
const machineChanged = async () => {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
  });
};

const prompt = () => document.querySelector<HTMLElement>("[data-device-approval-prompt]");
const rows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-device-approval-row]")].map(
    (row) => row.dataset.deviceApprovalRow,
  );
const button = (name: string) =>
  [...prompt()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const press = async (name: string) => {
  await act(async () => {
    button(name).click();
    await settle();
    await settle();
  });
};
const type = async (code: string) => {
  const box = prompt()!.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, code);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  world.state.pending = [];
  world.state.otherPending = [];
  world.state.primary = "env-m4";
  world.state.failing = null;
  world.state.held = null;
  world.state.log = [];
  world.state.machineLater = undefined;
  world.state.laterFails = false;
  world.state.key = null;
  world.state.environments = [];
  // An empty list, not a cleared one: with nothing stored the store reads its session copy.
  localStorage.setItem("specwithcode:connect-device-later", "{}");
});
afterEach(unmount);

describe("a new device opens the pop-up for itself, not for the ones put off", () => {
  /** A was put off with Later, then B asked: the pop-up is back with B only. */
  const putOffThenNewDevice = async () => {
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    expect(rows()).toEqual(["request-a"]);
    await press("Later");
    expect(prompt()).toBeNull();
    world.state.pending = [first, second];
    await machineChanged();
    expect(rows()).toEqual(["request-b"]);
  };

  it("lists only the new device and closes once it is allowed", async () => {
    await putOffThenNewDevice();
    await type("P4R-T9W");
    await press("Allow");
    expect(world.state.log).toEqual(["approve request-b"]);
    // The one put off still waits, quietly.
    expect(world.state.pending.map((request) => request.id)).toEqual(["request-a"]);
    expect(prompt()).toBeNull();
  });

  it("still takes the code of a device put off: the code picks the device", async () => {
    await putOffThenNewDevice();
    await type("K7QX2M");
    await press("Allow");
    expect(world.state.log).toEqual(["approve request-a"]);
    expect(rows()).toEqual(["request-b"]);
  });

  it("puts the new device off too and stays closed after a restart", async () => {
    await putOffThenNewDevice();
    await press("Later");
    expect(prompt()).toBeNull();
    await machineChanged();
    expect(prompt()).toBeNull();
    await unmount();
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()).toBeNull();
    expect(world.state.pending.map((request) => request.id)).toEqual(["request-a", "request-b"]);
  });

  it("stays closed when a device put off asks again with a new request and code", async () => {
    await putOffThenNewDevice();
    await press("Later");
    world.state.pending = [
      { ...first, id: "request-a2" },
      { ...second, id: "request-b2" },
    ];
    await machineChanged();
    expect(prompt()).toBeNull();
    await unmount();
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()).toBeNull();
  });

  it("opens once for a device put off that comes back with a new key", async () => {
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    await press("Later");
    // Same name and short ID, another key: the machine sees a new device.
    const rekeyed = { ...first, id: "request-a3", device: "reference-of-a-new-key" };
    world.state.pending = [rekeyed, second];
    await machineChanged();
    expect(rows()).toEqual(["request-a3", "request-b"]);
    await press("Later");
    world.state.pending = [{ ...rekeyed, id: "request-a4" }, second];
    await machineChanged();
    expect(prompt()).toBeNull();
  });

  it("closes by itself when the new device stops waiting", async () => {
    await putOffThenNewDevice();
    world.state.pending = [first];
    await machineChanged();
    expect(prompt()).toBeNull();
  });

  it("never opens on one machine from the last machine's list", async () => {
    // m5 has A waiting, put off with Later.
    world.state.otherPending = [first];
    world.state.primary = "env-m5";
    await mount(() => <DeviceApprovalPromptHost />);
    await press("Later");
    expect(prompt()).toBeNull();
    // On m4 another device waits, and its pop-up opens.
    world.state.pending = [second];
    await act(async () => {
      world.setPrimary("env-m4");
      await settle();
    });
    expect(rows()).toEqual(["request-b"]);
    // Back on m5 nothing new asked: A stays put off.
    await act(async () => {
      world.setPrimary("env-m5");
      await settle();
    });
    await machineChanged();
    expect(prompt()).toBeNull();
  });

  it("still stays shut for a device put off when nothing new asks", async () => {
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    await press("Later");
    // The same device asks again with a new request: still put off.
    world.state.pending = [{ ...first, id: "request-a2" }];
    await machineChanged();
    expect(prompt()).toBeNull();
  });
});

describe("the waiting card reads this device's ID once a machine waits (1406)", () => {
  it("reads the ID when a machine starts waiting, without a reload", async () => {
    // The window opens before sign-in: no key yet, nothing waiting.
    await mount(() => <DeviceWaitingForApprovalHost />);
    expect(document.querySelector("[data-device-waiting]")).toBeNull();
    // Sign-in makes the key, then a machine asks this device to wait for approval.
    world.state.key = { thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs" };
    await act(async () => {
      world.setEnvironments([
        { environmentId: "env-m4", label: "m4", connection: { deviceApprovalCode: "K7QX2M" } },
      ]);
      await settle();
    });
    await act(settle);
    expect(document.body.textContent).toContain("This device's ID is TSKR.");
  });
});

describe("a machine's device list and error stay with that machine (1406)", () => {
  /** What Settings > Machines reads from the hook for the primary machine. */
  function ListState() {
    const { snapshot, error } = useConnectDevices(usePrimaryEnvironmentId(), true);
    return (
      <p data-list-state>
        {snapshot?.machine ?? "loading"} / {error ?? "no error"}
      </p>
    );
  }
  const state = () => document.querySelector("[data-list-state]")!.textContent;

  it("shows neither the last machine's list nor its error while the next one loads", async () => {
    let release = () => {};
    await mount(() => <ListState />);
    expect(state()).toBe("m4 / no error");
    world.state.failing = "env-m4";
    await machineChanged();
    expect(state()).toBe("m4 / env-m4 is offline");
    world.state.held = {
      environmentId: "env-m5",
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    await act(async () => {
      world.setPrimary("env-m5");
      await settle();
    });
    expect(state()).toBe("loading / no error");
    await act(async () => {
      release();
      await settle();
    });
    expect(state()).toBe("m5 / no error");
  });
});

describe("Later kept by the machine (1447)", () => {
  const forgetThisWindow = () => localStorage.setItem("specwithcode:connect-device-later", "{}");

  it("tells the machine, so another window of it stays closed too", async () => {
    world.state.machineLater = [];
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()!.querySelector("[data-device-approval-count]")!.textContent).toBe(
      "Deny turns it away for a day. Later hides it in every window of this machine.",
    );
    await press("Later");
    expect(world.state.log).toEqual(["later reference-of-request-a"]);
    expect(prompt()).toBeNull();
    // Another window of the same machine: nothing in its own storage.
    await unmount();
    forgetThisWindow();
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()).toBeNull();
    // The device still waits on the machine; a new device still opens the pop-up for itself.
    expect(world.state.pending.map((request) => request.id)).toEqual(["request-a"]);
    world.state.pending = [first, second];
    await machineChanged();
    expect(rows()).toEqual(["request-b"]);
  });

  it("keeps Later in this window when the machine keeps none or cannot be told", async () => {
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()!.querySelector("[data-device-approval-count]")!.textContent).toBe(
      "Deny turns it away for a day.",
    );
    await press("Later");
    // An older machine is never asked.
    expect(world.state.log).toEqual([]);
    expect(prompt()).toBeNull();
    await unmount();

    world.state.machineLater = [];
    world.state.laterFails = true;
    world.state.pending = [second];
    await mount(() => <DeviceApprovalPromptHost />);
    await press("Later");
    expect(prompt()).toBeNull();
    await machineChanged();
    expect(prompt()).toBeNull();
  });
});
