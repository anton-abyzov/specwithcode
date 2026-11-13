// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type MachineToolsCheck } from "@specweave-studio/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { MachineToolInstallState } from "../../studio/machineTools";

const state = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  installAtom: null as unknown,
  configAtom: null as unknown,
}));

vi.mock("../../studio/machineTools", () => ({
  machineTools: { check: "check", install: "install" },
  machineToolInstallAtom: () => state.installAtom,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "check" | "install") => state[command],
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.configAtom },
}));
// The real dialog animates in a portal. Here only its contents matter.
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogPanel: Part,
    DialogPopup: Part,
    DialogTitle: Part,
  };
});

import { MachineToolInstallDialogHost } from "./MachineToolInstallDialog";
import {
  closeMachineToolInstall,
  readMachineToolInstallRequest,
  requestMachineToolInstall,
} from "./machineToolInstallRequest";

const ENV = EnvironmentId.make("env-worker");
const NO_NODE: MachineToolsCheck = {
  git: "present",
  node: "missing",
  gh: "present",
  packageManager: "apt",
  installable: ["node"],
};

let host: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;

async function mount() {
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <MachineToolInstallDialogHost />
      </RegistryContext.Provider>,
    );
  });
}

const buttonNamed = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  state.installAtom = Atom.make<MachineToolInstallState>({
    tool: null,
    status: "idle",
    lines: [],
    detail: null,
    handedOff: false,
  }).pipe(Atom.keepAlive);
  state.configAtom = Atom.make({ environment: { platform: { os: "linux" } } }).pipe(Atom.keepAlive);
  state.check.mockReset();
  state.install.mockReset();
  state.install.mockResolvedValue({ _tag: "Success", value: undefined });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  closeMachineToolInstall();
});

describe("the install dialog where a tool turned out missing", () => {
  it("opens from a request, names the machine and installs Node.js there", async () => {
    state.check.mockResolvedValue({ _tag: "Success", value: NO_NODE });
    await mount();
    expect(host.textContent).toBe("");
    await act(async () =>
      requestMachineToolInstall({ environmentId: ENV, tool: "node", machineLabel: "Build box" }),
    );
    expect(host.textContent).toContain("Install Node.js on Build box");
    expect(host.textContent).toContain("set SpecWeave up again");
    expect(state.check).toHaveBeenCalledWith({ environmentId: ENV, input: {} });
    await act(async () => buttonNamed("Install Node.js")!.click());
    expect(state.install).toHaveBeenCalledWith({ environmentId: ENV, input: { tool: "node" } });
    await act(async () => buttonNamed("Done")!.click());
    expect(readMachineToolInstallRequest()).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("says so when the tool is already there", async () => {
    state.check.mockResolvedValue({
      _tag: "Success",
      value: { ...NO_NODE, node: "present", installable: [] },
    });
    await mount();
    await act(async () =>
      requestMachineToolInstall({ environmentId: ENV, tool: "node", machineLabel: null }),
    );
    expect(host.textContent).toContain("Node.js is already on this machine.");
    expect(buttonNamed("Install Node.js")).toBeUndefined();
  });

  it("gives Linux the command for Git instead of a button", async () => {
    state.check.mockResolvedValue({
      _tag: "Success",
      value: { ...NO_NODE, git: "missing", node: "present", installable: [] },
    });
    await mount();
    await act(async () =>
      requestMachineToolInstall({ environmentId: ENV, tool: "git", machineLabel: null }),
    );
    expect(host.textContent).toContain("sudo apt install git");
    expect(buttonNamed("Install Git")).toBeUndefined();
  });

  it("explains an older machine that cannot answer", async () => {
    state.check.mockResolvedValue({ _tag: "Failure", cause: new Error("unknown method") });
    await mount();
    await act(async () =>
      requestMachineToolInstall({ environmentId: ENV, tool: "git", machineLabel: null }),
    );
    expect(host.textContent).toContain("older SpecWithCode");
  });
});
