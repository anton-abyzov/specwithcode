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
    log: [] as string[],
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
    new Map([["env-m4", { environment: { capabilities: { deviceApproval: true } } }]]),
}));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  };
  return {
    usePrimaryEnvironmentId: () => "env-m4",
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
  const snapshot = (): ConnectDevicesSnapshot => ({
    machine: "m4",
    health: "ok",
    devices: [],
    pending: [...world.state.pending],
    needsReview: false,
    notices: [],
    canApprove: true,
    canRepair: true,
  });
  return {
    ...logic,
    connectDevices: {
      list: async () => snapshot(),
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
      deny: async (_environmentId: string, requestId: string) => {
        world.state.log.push(`deny ${requestId}`);
        world.state.pending = world.state.pending.filter((request) => request.id !== requestId);
        return { denied: true };
      },
    },
  };
});

import { DeviceApprovalPromptHost, DeviceWaitingForApprovalHost } from "./ConnectDeviceHosts";

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
  world.state.log = [];
  world.state.key = null;
  world.state.environments = [];
  // An empty list, not a cleared one: with nothing stored the store reads its session copy.
  localStorage.setItem("specwithcode:connect-device-later", "{}");
});
afterEach(unmount);

describe("a pop-up a new device reopened stays open while one put off still waits (1406)", () => {
  /** A was put off with Later, then B asked: the pop-up is back with both. */
  const putOffThenNewDevice = async () => {
    world.state.pending = [first];
    await mount(() => <DeviceApprovalPromptHost />);
    expect(rows()).toEqual(["request-a"]);
    await press("Later");
    expect(prompt()).toBeNull();
    world.state.pending = [first, second];
    await machineChanged();
    expect(rows()).toEqual(["request-a", "request-b"]);
  };

  it("names the device a code allowed and keeps the one put off listed", async () => {
    await putOffThenNewDevice();
    await type("P4R-T9W");
    await press("Allow");
    expect(world.state.log).toEqual(["approve request-b"]);
    expect(prompt()).not.toBeNull();
    expect(
      [...document.querySelectorAll("[data-device-approval-allowed]")].map(
        (line) => line.textContent,
      ),
    ).toEqual(["Allowed iPhone · ID 9229. It can now use m4."]);
    expect(rows()).toEqual(["request-a"]);
    expect(prompt()!.querySelector("[data-device-approval-count]")!.textContent).toMatch(
      /^1 device waiting/,
    );
  });

  it("closes on Later and stays closed after a restart", async () => {
    await putOffThenNewDevice();
    await type("P4RT9W");
    await press("Allow");
    await press("Later");
    expect(prompt()).toBeNull();
    await machineChanged();
    expect(prompt()).toBeNull();
    await unmount();
    await mount(() => <DeviceApprovalPromptHost />);
    expect(prompt()).toBeNull();
    expect(world.state.pending.map((request) => request.id)).toEqual(["request-a"]);
  });

  it("closes by itself once the device put off is answered too", async () => {
    await putOffThenNewDevice();
    await type("P4RT9W");
    await press("Allow");
    await type("K7QX2M");
    await press("Allow");
    expect(world.state.log).toEqual(["approve request-b", "approve request-a"]);
    expect(prompt()).toBeNull();
  });

  it("closes by itself when the device put off stops waiting", async () => {
    await putOffThenNewDevice();
    await type("P4RT9W");
    await press("Allow");
    world.state.pending = [];
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
