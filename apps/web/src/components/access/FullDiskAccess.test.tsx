// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PrivacyAccess } from "@specweave-studio/contracts";

import {
  FirstRunFullDiskAccess,
  FullDiskAccessRow,
  settingsRequestFor,
} from "./FullDiskAccess";

const state = vi.hoisted(() => ({
  access: null as unknown,
  primary: "env-local" as string | null,
  opened: [] as unknown[],
  closed: 0,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primary,
  usePrimaryEnvironment: () =>
    state.primary === null ? null : { environmentId: state.primary, label: "M5" },
}));
vi.mock("../../studio/machineHandoff", () => ({ machineHandoff: { privacyAccess: "privacy" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: state.access }),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({
    shell: {
      openSystemSettings: async (request: unknown) => {
        state.opened.push(request);
      },
    },
  }),
}));

const access = (overrides: Partial<PrivacyAccess>): PrivacyAccess => ({
  checkedAt: "2026-11-18T00:00:00.000Z",
  fullDiskAccess: "not-allowed",
  agentHost: { kind: "executable", path: "/opt/node/bin/node", name: "node" },
  runningAgentsNeedRestart: false,
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.opened = [];
  state.closed = 0;
  state.primary = "env-local";
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
  (window as unknown as { desktopBridge: unknown }).desktopBridge = {
    openSystemSettings: async () => true,
    closeSystemSettingsHelper: async () => {
      state.closed += 1;
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
});

const render = async (node: React.ReactNode) => {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {});
};

it("asks System Settings to offer the agents' executable, or the app itself", () => {
  expect(settingsRequestFor(access({}))).toEqual({
    pane: "full-disk-access",
    agentHost: { path: "/opt/node/bin/node", name: "node" },
  });
  expect(
    settingsRequestFor(
      access({ agentHost: { kind: "app", path: "/Applications/SpecWithCode.app", name: "SpecWithCode" } }),
    ),
  ).toBe("full-disk-access");
  expect(
    settingsRequestFor(
      access({ agentHost: { kind: "app", path: "/System/Applications/Utilities/Terminal.app", name: "Terminal" } }),
    ),
  ).toEqual({
    pane: "full-disk-access",
    agentHost: { path: "/System/Applications/Utilities/Terminal.app", name: "Terminal" },
  });
});

it("shows an off row with the risk and an Open System Settings button on this Mac", async () => {
  state.access = access({});
  await render(<FullDiskAccessRow environmentId={"env-local" as never} environmentLabel="M5" />);
  const row = container.querySelector('[data-slot="fda-row"]');
  expect(row?.getAttribute("data-state")).toBe("not-allowed");
  expect(container.textContent).toContain("Full Disk Access for agents: off");
  expect(container.textContent).toContain(
    "Every agent on M5, in every project and with every provider, gets this until you turn it off in System Settings.",
  );
  expect(container.textContent).toContain("/opt/node/bin/node");
  const open = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Open System Settings",
  );
  await act(async () => open!.click());
  expect(state.opened).toEqual([
    { pane: "full-disk-access", agentHost: { path: "/opt/node/bin/node", name: "node" } },
  ]);
});

it("names the step to take on another machine instead of a deep link", async () => {
  state.access = access({});
  await render(<FullDiskAccessRow environmentId={"env-m1" as never} environmentLabel="M1" />);
  expect(container.textContent).toContain("Open SpecWithCode on M1 to allow it there.");
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Open System Settings",
    ),
  ).toBe(false);
});

it("says running threads need a restart when only new runs have it", async () => {
  state.access = access({ fullDiskAccess: "allowed", runningAgentsNeedRestart: true });
  await render(<FullDiskAccessRow environmentId={"env-local" as never} environmentLabel="M5" />);
  expect(container.textContent).toContain("allowed, restart running threads");
});

it("renders nothing off macOS", async () => {
  state.access = access({ fullDiskAccess: "not-applicable", agentHost: null });
  await render(<FullDiskAccessRow environmentId={"env-local" as never} environmentLabel="L" />);
  expect(container.innerHTML).toBe("");
});

it("first run mentions it closed and optional, on this Mac only", async () => {
  state.access = access({});
  await render(<FirstRunFullDiskAccess />);
  const details = container.querySelector<HTMLDetailsElement>('[data-slot="first-run-fda"]');
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
  expect(details!.textContent).toContain("Full Disk Access for agents (optional)");
  expect(details!.textContent).toContain("You can skip this.");

  state.primary = null;
  await render(<FirstRunFullDiskAccess />);
  expect(container.querySelector('[data-slot="first-run-fda"]')).toBeNull();
});

it("first run says nothing in the Windows or Linux desktop app", async () => {
  state.access = access({});
  for (const platform of ["Win32", "Linux x86_64"]) {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
    await render(<FirstRunFullDiskAccess />);
    expect(container.querySelector('[data-slot="first-run-fda"]')).toBeNull();
  }
});
