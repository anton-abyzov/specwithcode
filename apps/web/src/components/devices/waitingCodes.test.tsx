// @vitest-environment jsdom
import * as Effect from "effect/Effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The machines this device waits on, as the hosts read them. */
const world = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    environments: [] as Array<{
      environmentId: string;
      label: string;
      connection: { deviceApprovalCode?: string; phase?: string };
    }>,
    /** This window's proof key; a new one makes this a new device. */
    thumbprint: "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
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
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: async () => false }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: () => undefined },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    world.listeners.add(listener);
    return () => world.listeners.delete(listener);
  };
  return {
    usePrimaryEnvironmentId: () => "env-m5",
    useEnvironments: () => ({
      environments: useSyncExternalStore(subscribe, () => world.state.environments),
    }),
  };
});
vi.mock("../../cloud/dpop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/dpop")>()),
  readStoredBrowserDpopKey: () => Effect.succeed({ thumbprint: world.state.thumbprint }),
}));

import { SidebarJoinCodePill } from "../sidebar/SidebarJoinCodePill";
import { WaitingJoinCodes } from "../settings/WaitingJoinCodes";
import { DeviceWaitingForApprovalHost } from "./ConnectDeviceHosts";
import { requestAccountMachineConnect } from "../../studio/grantedAccountMachines";
import { CLOSED_JOIN_CODES_STORAGE_KEY, restartClosedJoinCodesForTest } from "./closedJoinCodes";

const WAITING = [
  {
    environmentId: "env-prcty",
    label: "PRCTY-AABYZOV",
    connection: { deviceApprovalCode: "UN5MBB" },
  },
];

let root: Root | null = null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(element);
    await settle();
  });
  await act(settle);
}
const card = () => document.querySelector<HTMLElement>("[data-device-waiting-layer]");
const closeButton = () => document.querySelector<HTMLButtonElement>("[data-device-waiting-close]");
const showCode = () => document.querySelector<HTMLButtonElement>("[data-sidebar-join-code-show]");
const run = async (step: () => void) => {
  await act(async () => {
    step();
    await settle();
  });
};

/** The floating card next to the sidebar row and an unrelated button, as in the app. */
function Shell() {
  return (
    <>
      <button type="button" data-outside>
        Project settings
      </button>
      <SidebarJoinCodePill />
      <DeviceWaitingForApprovalHost />
    </>
  );
}

const FIRST_KEY = world.state.thumbprint;
const OTHER_KEY = "Q0FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
const OTHER = {
  environmentId: "env-m4",
  label: "m4",
  connection: { deviceApprovalCode: "K7QX2M" } as { deviceApprovalCode?: string; phase?: string },
};
const codes = () =>
  [...(card()?.querySelectorAll("[data-device-waiting-code]") ?? [])].map(
    (code) => code.textContent,
  );
/** The app quits and starts again: memory is gone, storage is not. */
async function restart() {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  restartClosedJoinCodesForTest();
  await mount(<Shell />);
}

beforeEach(() => {
  localStorage.clear();
  restartClosedJoinCodesForTest();
  world.state.thumbprint = FIRST_KEY;
  world.state.environments = [...WAITING];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the floating join code card can be closed and found again", () => {
  it("has a close button that hides the card while the join stays pending", async () => {
    await mount(<Shell />);
    expect(card()?.textContent).toContain("UN5MBB");
    expect(closeButton()?.getAttribute("aria-label")).toBe("Close");
    await run(() => closeButton()!.click());
    expect(card()).toBeNull();
    // Still waiting: the sidebar says so and offers the code again.
    expect(document.querySelector("[data-sidebar-join-code]")?.textContent).toContain(
      "Waiting for PRCTY-AABYZOV",
    );
    await run(() => showCode()!.click());
    expect(card()?.textContent).toContain("UN5MBB");
  });

  it("closes on Escape", async () => {
    await mount(<Shell />);
    await run(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(card()).toBeNull();
  });

  it("leaves Escape to a dialog that already handled it", async () => {
    await mount(<Shell />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    await run(() => document.dispatchEvent(event));
    expect(card()).not.toBeNull();
  });

  it("closes on a click outside and stays open on a click inside", async () => {
    await mount(<Shell />);
    const inside = card()!.querySelector("[data-device-waiting-code]")!;
    await run(() => inside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(card()).not.toBeNull();
    const outside = document.querySelector("[data-outside]")!;
    await run(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(card()).toBeNull();
  });

  it("sits below the top bar so the project header stays in reach", async () => {
    await mount(<Shell />);
    expect(card()!.className).toContain("var(--workspace-topbar-height");
    expect(card()!.className).not.toMatch(/(^|\s)top-3(\s|$)/);
  });

  it("drops the sidebar row once no machine waits", async () => {
    await mount(<Shell />);
    await run(() => world.setEnvironments([]));
    expect(document.querySelector("[data-sidebar-join-code]")).toBeNull();
    expect(card()).toBeNull();
  });
});

describe("a closed join code card stays closed until something real changes", () => {
  const close = async () => {
    await mount(<Shell />);
    expect(codes()).toEqual(["UN5MBB"]);
    await run(() => closeButton()!.click());
    expect(card()).toBeNull();
  };
  const rotate = (code: string) =>
    run(() =>
      world.setEnvironments([{ ...WAITING[0]!, connection: { deviceApprovalCode: code } }]),
    );

  it("stays closed when the machine gives a new code", async () => {
    await close();
    await rotate("Q8LM3D");
    await rotate("T2VN6H");
    expect(card()).toBeNull();
    // The new code is one press away, and in Settings.
    await run(() => showCode()!.click());
    expect(codes()).toEqual(["T2VN6H"]);
  });

  it("stays closed across a reload or a restart of the app", async () => {
    await close();
    await restart();
    expect(card()).toBeNull();
    expect(document.querySelector("[data-sidebar-join-code]")?.textContent).toContain(
      "Waiting for PRCTY-AABYZOV",
    );
    // Also with a new code after the restart.
    await rotate("Q8LM3D");
    expect(card()).toBeNull();
  });

  it("stays closed across an ordinary reconnect", async () => {
    await close();
    // The connection drops, then the same wait is back with another code.
    await run(() => world.setEnvironments([{ ...WAITING[0]!, connection: {} }]));
    await rotate("Q8LM3D");
    expect(card()).toBeNull();
  });

  it("never stores the code", async () => {
    await close();
    await rotate("Q8LM3D");
    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? "");
    expect(localStorage.getItem(CLOSED_JOIN_CODES_STORAGE_KEY)).toContain("env-prcty");
    expect(stored.join(" ")).not.toMatch(/UN5MBB|Q8LM3D/);
  });

  it("shows another machine's card without bringing the closed one back", async () => {
    await close();
    await run(() => world.setEnvironments([...WAITING, OTHER]));
    expect(codes()).toEqual(["K7QX2M"]);
  });

  it("shows again once when this device has a new key", async () => {
    await close();
    world.state.thumbprint = OTHER_KEY;
    // A new key is a new device to the machine, which gives it a new code.
    await rotate("Q8LM3D");
    await act(settle);
    expect(codes()).toEqual(["Q8LM3D"]);
    await run(() => closeButton()!.click());
    await rotate("T2VN6H");
    expect(card()).toBeNull();
    await restart();
    expect(card()).toBeNull();
  });

  it("stays closed when the machine connects another way while Connect still waits", async () => {
    await close();
    // Connected over the local network; the Connect route was never approved.
    await run(() =>
      world.setEnvironments([{ ...WAITING[0]!, connection: { phase: "connected" } }]),
    );
    await rotate("Q8LM3D");
    expect(card()).toBeNull();
  });

  it("shows again when the owner presses Connect for that machine", async () => {
    await close();
    await run(() => world.setEnvironments([...WAITING, OTHER]));
    await run(() => closeButton()!.click());
    expect(card()).toBeNull();
    await run(() => void requestAccountMachineConnect(["env-prcty"]));
    expect(codes()).toEqual(["UN5MBB"]);
  });

  it("brings every closed card back on Show code", async () => {
    await close();
    await run(() => world.setEnvironments([...WAITING, OTHER]));
    await run(() => closeButton()!.click());
    await restart();
    expect(card()).toBeNull();
    await run(() => showCode()!.click());
    expect(codes()).toEqual(["UN5MBB", "K7QX2M"]);
  });
});

describe("Settings > Machines shows the pending join", () => {
  it("lists the code, this device's ID and Copy", async () => {
    await mount(<WaitingJoinCodes />);
    const section = document.querySelector<HTMLElement>("[data-waiting-join-codes]")!;
    expect(section.textContent).toContain("Open SpecWithCode on PRCTY-AABYZOV and type this code:");
    expect(section.querySelector("[data-device-waiting-code]")?.textContent).toBe("UN5MBB");
    expect(section.querySelector("[data-own-device-id]")).not.toBeNull();
    expect(
      [...section.querySelectorAll("button")].some((button) => button.textContent === "Copy"),
    ).toBe(true);
  });

  it("shows nothing when no join is pending", async () => {
    world.state.environments = [];
    await mount(<WaitingJoinCodes />);
    expect(document.querySelector("[data-waiting-join-codes]")).toBeNull();
  });
});
