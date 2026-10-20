import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProviderLimitMachineTarget,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  machines: [] as unknown[],
  providers: [] as unknown[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: { machines: state.machines } }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "project" }, target: { environmentId: "mac" } }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={props["aria-label"]}
      checked={props.checked}
      onChange={(e) => props.onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; "aria-label"?: string }) => (
    <button aria-label={props["aria-label"]} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsRow: (props: {
    title: string;
    control: ReactNode;
    status?: string;
    children?: ReactNode;
  }) => (
    <section aria-label={props.title} data-status={props.status}>
      {props.control}
      {props.children}
    </section>
  ),
  SettingResetButton: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: (props: {
    children: ReactNode;
    value: string | null;
    onValueChange: (v: string) => void;
  }) => (
    <select value={props.value ?? ""} onChange={(e) => props.onValueChange(e.target.value)}>
      {props.children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import {
  addMachineTarget,
  MachineFallbackSettings,
  machineTargetLabel,
  moveMachineTarget,
} from "./MachineFallbackSettings";

const claude = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null }],
};
const minis = { environmentId: "env-minis", label: "Minis", status: "reachable" };
const m3 = { environmentId: "env-m3", label: "M3", status: "unreachable" };
const target = (environmentId: string, label: string) =>
  ({
    environmentId,
    label,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    modelLabel: "Claude · Opus 5.5",
  }) as unknown as ProviderLimitMachineTarget;

let renderer: ReactTestRenderer | undefined;
const section = (title: string) =>
  renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === title);
const render = () =>
  act(() => {
    renderer = create(<MachineFallbackSettings />);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = resolveProjectSettings(
    DEFAULT_SERVER_SETTINGS,
    ProjectId.make("p"),
    null,
    null,
  ).settings;
  state.update.mockReset();
  state.machines = [minis, m3, { environmentId: "mac", label: "M4", status: "reachable" }];
  state.providers = [claude];
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("MachineFallbackSettings", () => {
  it("defaults to this machine only, other machines first, unknown usage off", () => {
    render();
    expect(section("Other machines").props["data-status"]).toBe("This machine only");
    expect(section("Try first").findByType("select").props.value).toBe("other-machine-first");
    expect(section("Use machines with unknown usage").findByType("input").props.checked).toBe(
      false,
    );
  });
  it("offers the paired machines except this one, marking offline ones", () => {
    render();
    const options = section("Other machines")
      .findAllByType("option")
      .map((option) => [option.props.value, option.props.children]);
    expect(options).toEqual([
      ["env-minis", "Minis"],
      ["env-m3", "M3 (offline)"],
    ]);
  });
  it("adds a machine with the default model and its label", () => {
    render();
    act(() =>
      section("Other machines")
        .findByType("select")
        .props.onChange({ target: { value: "env-minis" } }),
    );
    expect(state.update).toHaveBeenCalledWith({
      providerLimitMachineTargets: [
        {
          environmentId: "env-minis",
          label: "Minis",
          modelSelection: expect.objectContaining({
            instanceId: "claudeAgent",
            model: "claude-opus-5-5",
          }),
          modelLabel: "Claude · Opus 5.5",
        },
      ],
    });
  });
  it("lists targets in order with the full try order", () => {
    state.settings = {
      ...state.settings,
      providerLimitMachineTargets: [target("env-minis", "Minis"), target("env-m3", "M3")],
    };
    render();
    const rows = section("Other machines").findAll((node) => node.type === "li");
    expect(
      rows.map((row) => row.findAll((node) => node.type === "span")[1]!.props.children[0]),
    ).toEqual(["Minis · Claude · Opus 5.5", "M3 · Claude · Opus 5.5"]);
    const order = renderer!.root.find((node) => node.props["aria-label"] === "Order tried");
    expect(order.props.children).toBe(
      "Tried in this order: Minis · Claude · Opus 5.5, then M3 · Claude · Opus 5.5.",
    );
    act(() =>
      renderer!.root
        .find(
          (node) =>
            node.type === "button" && node.props["aria-label"] === "Move M3 · Claude · Opus 5.5 up",
        )
        .props.onClick(),
    );
    expect(state.update).toHaveBeenCalledWith({
      providerLimitMachineTargets: [target("env-m3", "M3"), target("env-minis", "Minis")],
    });
  });
  it("writes the order and the unknown-usage policy", () => {
    render();
    act(() =>
      section("Try first")
        .findByType("select")
        .props.onChange({ target: { value: "same-machine-first" } }),
    );
    expect(state.update).toHaveBeenCalledWith({ providerLimitTargetOrder: "same-machine-first" });
    act(() =>
      section("Use machines with unknown usage")
        .findByType("input")
        .props.onChange({ target: { checked: true } }),
    );
    expect(state.update).toHaveBeenCalledWith({ providerLimitUnknownUsageEligible: true });
  });
});

describe("machine target helpers", () => {
  const machines = [minis] as never;
  it("keeps the saved names while a machine is gone", () => {
    expect(machineTargetLabel(target("env-gone", "Minis old"), [], [])).toBe(
      "Minis old · Claude · Opus 5.5",
    );
    expect(machineTargetLabel(target("env-minis", "Old"), machines, [claude] as never)).toBe(
      "Minis · Claude · Opus 5.5",
    );
  });
  it("adds once, caps at eight and moves within bounds", () => {
    const one = addMachineTarget([], target("env-minis", "Minis"));
    expect(addMachineTarget(one, target("env-minis", "Minis"))).toBe(one);
    const full = Array.from({ length: 8 }, (_, at) => target(`env-${at}`, `M${at}`));
    expect(addMachineTarget(full, target("env-minis", "Minis"))).toBe(full);
    expect(moveMachineTarget(one, 0, -1)).toBe(one);
  });
});
