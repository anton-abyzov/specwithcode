// @vitest-environment jsdom
import { EnvironmentId, type MachineToolsCheck } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ check: null as unknown }));
vi.mock("./machineToolsUi", async (original) => ({
  ...(await original<typeof import("./machineToolsUi")>()),
  useMachineTools: () => ({
    state: state.check === null ? { kind: "checking" } : { kind: "ready", check: state.check },
  }),
}));
vi.mock("../onboarding/MachineBasics", () => ({
  MachineBasicsOn: ({ environmentId }: { readonly environmentId: string }) => (
    <div data-machine-basics-on={environmentId} />
  ),
}));

import { DestinationReadiness } from "./DestinationReadiness";

const ENV = EnvironmentId.make("win");
let renderer: ReactTestRenderer;
const check = (node: "present" | "missing"): MachineToolsCheck => ({
  git: "present",
  node,
  gh: "missing",
  packageManager: "winget",
  installable: node === "missing" ? ["node", "gh"] : ["gh"],
  tools: [
    {
      tool: "git",
      presence: "present",
      version: null,
      managed: false,
      outdated: false,
      canInstall: false,
    },
    {
      tool: "node",
      presence: node,
      version: node === "present" ? "22.20.0" : null,
      managed: false,
      outdated: false,
      canInstall: node === "missing",
    },
    {
      tool: "gh",
      presence: "missing",
      version: null,
      managed: false,
      outdated: false,
      canInstall: true,
    },
    {
      tool: "specweave",
      presence: node,
      version: node === "present" ? "3.1.22" : null,
      managed: false,
      outdated: false,
      canInstall: true,
    },
  ],
});
const render = () =>
  act(() => {
    renderer = create(<DestinationReadiness environmentId={ENV} machineName="win" />);
  });

afterEach(() => {
  act(() => renderer?.unmount());
  state.check = null;
});

describe("DestinationReadiness", () => {
  it("shows the destination's rows when Node.js and SpecWeave are missing there", () => {
    state.check = check("missing");
    render();
    expect(renderer.root.findByProps({ "data-machine-basics-on": "win" })).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain("Tools stay on each machine");
  });

  it("stays out of the way when the destination has what agents need (gh is optional)", () => {
    state.check = check("present");
    render();
    expect(renderer.toJSON()).toBeNull();
  });

  it("shows nothing while the check runs or for an older machine that cannot answer", () => {
    render();
    expect(renderer.toJSON()).toBeNull();
  });
});
