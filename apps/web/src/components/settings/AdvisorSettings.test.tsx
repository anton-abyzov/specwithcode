import {
  DEFAULT_ADVISOR_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  update: vi.fn(),
  runPlan: vi.fn(),
  // Per-machine settings for the per-field "Mixed" check; empty: one machine.
  targetSettings: [] as Record<string, unknown>[],
  scope: "environment" as "environment" | "project",
  advisorCapability: true as boolean | undefined,
  providers: [] as unknown[],
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: state.scope, members: [], environmentIds: ["mac"] },
    target: { environmentId: "mac" },
    targets: (state.targetSettings.length > 0 ? state.targetSettings : [state.settings]).map(
      (settings) => ({ settings }),
    ),
    environments: [],
    connectedEnvironments: [
      {
        environmentId: "mac",
        serverConfig: {
          providers: state.providers,
          environment: {
            capabilities:
              state.advisorCapability === undefined ? {} : { advisor: state.advisorCapability },
          },
        },
      },
    ],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
  useRunScopedPlan: () => state.runPlan,
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerAriaLabel: string;
    triggerLabel?: string;
    triggerClassName?: string;
    disabled?: boolean;
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button
      aria-label={props.triggerAriaLabel}
      data-trigger-label={props.triggerLabel}
      data-trigger-class={props.triggerClassName}
      disabled={props.disabled}
      onClick={() => props.onInstanceModelChange("codex", "gpt-6.1-sol")}
    />
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (v: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={props["aria-label"]}
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
    "aria-label"?: string;
  }) => (
    <button aria-label={props["aria-label"]} onClick={onClick}>
      {children}
    </button>
  ),
}));
// The number field reports what a person commits; the row decides what is saved.
vi.mock("../ui/number-field", () => ({
  NumberField: (props: {
    children: ReactNode;
    value: number | null;
    disabled?: boolean;
    onValueCommitted: (value: number | null) => void;
  }) => (
    <input
      type="number"
      data-number-field
      value={props.value ?? ""}
      disabled={props.disabled}
      onChange={(e) =>
        props.onValueCommitted(e.target.value === "" ? null : Number(e.target.value))
      }
    />
  ),
  NumberFieldGroup: () => null,
  NumberFieldDecrement: () => null,
  NumberFieldIncrement: () => null,
  NumberFieldInput: () => null,
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  PolicyTooltip: ({ label, children }: { label?: string; children: string }) => (
    <span data-note-label={label}>{children}</span>
  ),
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <div role="group" aria-label={title}>
      {children}
    </div>
  ),
  SettingsRow: ({
    title,
    control,
    resetAction,
    settingKeys,
    settingField,
    mixed,
    onResetOverride,
    serverScoped,
    titleInfo,
    "aria-disabled": disabled,
  }: {
    title: string;
    titleInfo?: ReactNode;
    control?: ReactNode;
    resetAction?: ReactNode;
    settingKeys?: readonly string[];
    settingField?: string;
    mixed?: boolean;
    onResetOverride?: () => void;
    serverScoped?: boolean;
    "aria-disabled"?: boolean;
  }) => (
    <section
      aria-label={title}
      data-keys={settingKeys?.join(" ")}
      data-field={settingField}
      data-mixed={mixed}
      data-on-reset-override={onResetOverride}
      data-server-scoped={serverScoped}
      data-disabled={disabled === true}
    >
      {titleInfo}
      {control}
      {resetAction}
    </section>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button aria-label={`Reset ${label} to default`} onClick={onClick} />
  ),
}));

import { advisorSettingsAvailable, AdvisorSettings, clampAdvisorNumber } from "./AdvisorSettings";

const codex = ProviderInstanceId.make("codex");
const providerList = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    displayName: "Codex",
    models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
  },
] as unknown as ServerProvider[];

let renderer: ReactTestRenderer | undefined;
const row = (title: string) =>
  renderer!.root.find((node) => node.type === "section" && node.props["aria-label"] === title);
// A control, not the row or section that shares its name.
const byLabel = (label: string) =>
  renderer!.root.find(
    (node) =>
      (node.type === "input" || node.type === "button") && node.props["aria-label"] === label,
  );
const numberIn = (title: string) =>
  row(title).find((node) => node.type === "input" && node.props["data-number-field"] === true);
const commit = (title: string, value: number | null) =>
  act(() => numberIn(title).props.onChange({ target: { value: value === null ? "" : value } }));
const render = () =>
  act(() => {
    renderer?.unmount();
    renderer = create(<AdvisorSettings id="advisor" />);
  });
const withAdvisor = (advisor: Partial<typeof DEFAULT_ADVISOR_SETTINGS>) => {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    advisor: { ...DEFAULT_ADVISOR_SETTINGS, ...advisor },
  };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  withAdvisor({});
  state.update.mockReset();
  state.runPlan.mockReset();
  state.targetSettings = [];
  state.scope = "environment";
  state.advisorCapability = true;
  state.providers = providerList;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("AdvisorSettings", () => {
  it("notes beside the switch how much longer consults make the work", () => {
    render();
    const note = row("Let threads ask a stronger model").findByProps({
      "data-note-label": "How much longer work takes with Let threads ask a stronger model",
    });
    expect(note.children.join("")).toContain("about 1.1 times as long");
  });

  it("renders the defaults, off, with the other rows waiting for the switch", () => {
    render();
    expect(renderer!.root.findByProps({ role: "group", "aria-label": "Advisor" })).toBeDefined();
    expect(byLabel("Let threads ask a stronger model").props.checked).toBe(false);
    expect(byLabel("Claude's own advisor").props.checked).toBe(true);
    expect(numberIn("Context limit for Claude's advisor").props.value).toBe(200_000);
    expect(numberIn("Consults per run").props.value).toBe(3);
    expect(numberIn("Brief size").props.value).toBe(24_000);
    for (const title of [
      "Advisor model",
      "Claude's own advisor",
      "Context limit for Claude's advisor",
      "Consults per run",
      "Brief size",
    ])
      expect(row(title).props["data-disabled"], title).toBe(true);
    expect(row("Let threads ask a stronger model").props["data-disabled"]).toBe(false);
    expect(numberIn("Consults per run").props.disabled).toBe(true);
  });

  it("writes only the switch when turned on", () => {
    render();
    act(() =>
      byLabel("Let threads ask a stronger model").props.onChange({ target: { checked: true } }),
    );
    expect(state.update).toHaveBeenCalledWith({ advisor: { enabled: true } });
  });

  it("writes only the limit that changed", () => {
    withAdvisor({ enabled: true });
    render();
    expect(numberIn("Consults per run").props.disabled).toBe(false);
    commit("Consults per run", 5);
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { maxConsultsPerRun: 5 } });
    commit("Brief size", 32_000);
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { briefTokenBudget: 32_000 } });
    commit("Context limit for Claude's advisor", 400_000);
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { builtInContextLimit: 400_000 } });
    expect(state.update).toHaveBeenCalledTimes(3);
  });

  it("clamps out-of-range numbers and ignores an empty or unchanged one", () => {
    withAdvisor({ enabled: true });
    render();
    commit("Consults per run", 50);
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { maxConsultsPerRun: 10 } });
    commit("Brief size", 100);
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { briefTokenBudget: 4_000 } });
    commit("Context limit for Claude's advisor", 2_000_000);
    expect(state.update).toHaveBeenLastCalledWith({
      advisor: { builtInContextLimit: 1_000_000 },
    });
    state.update.mockReset();
    commit("Consults per run", null);
    commit("Consults per run", 3);
    commit("Consults per run", 3.2);
    expect(state.update).not.toHaveBeenCalled();
    expect(clampAdvisorNumber(2.6, 1, 10)).toBe(3);
    expect(clampAdvisorNumber(Number.NaN, 1, 10)).toBeNull();
  });

  it("names the default model and returns to it", () => {
    withAdvisor({ enabled: true });
    render();
    expect(byLabel("Advisor model").props["data-trigger-label"]).toBe("The Complex track");
    act(() => byLabel("Advisor model").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({
      advisor: { model: { instanceId: "codex", model: "gpt-6.1-sol" } },
    });

    withAdvisor({ enabled: true, model: { instanceId: codex, model: "gpt-6.1-sol" } });
    render();
    expect(byLabel("Advisor model").props["data-trigger-label"]).toBeUndefined();
    act(() => byLabel("Use the default advisor order").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { model: null } });
  });

  it("keeps the context limit waiting while Claude's own advisor is off", () => {
    withAdvisor({ enabled: true, claudeBuiltIn: false });
    render();
    expect(numberIn("Context limit for Claude's advisor").props.disabled).toBe(true);
    expect(numberIn("Brief size").props.disabled).toBe(false);
  });

  it("restores one field's default at machine scope", () => {
    withAdvisor({ enabled: true, maxConsultsPerRun: 7 });
    render();
    act(() => byLabel("Reset consults per run to default").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({ advisor: { maxConsultsPerRun: 3 } });
  });

  it("leaves the project reset to the row, one advisor field per row", () => {
    state.scope = "project";
    withAdvisor({ enabled: true, maxConsultsPerRun: 7 });
    render();
    // Each row is server-scoped on "advisor" and names its own field, so the
    // row shows Inherited or Overridden for that field alone.
    for (const [title, field] of [
      ["Let threads ask a stronger model", "enabled"],
      ["Advisor model", "model"],
      ["Claude's own advisor", "claudeBuiltIn"],
      ["Context limit for Claude's advisor", "builtInContextLimit"],
      ["Consults per run", "maxConsultsPerRun"],
      ["Brief size", "briefTokenBudget"],
    ] as const) {
      expect(row(title).props["data-keys"], title).toBe("advisor");
      expect(row(title).props["data-field"], title).toBe(field);
      expect(row(title).props["data-server-scoped"], title).toBe(true);
    }
    expect(
      renderer!.root.findAll(
        (node) =>
          typeof node.props["aria-label"] === "string" &&
          node.props["aria-label"].startsWith("Reset "),
      ),
    ).toEqual([]);
  });

  it("resets only its own field of the project override", () => {
    state.scope = "project";
    withAdvisor({ enabled: true, maxConsultsPerRun: 7 });
    render();
    act(() => row("Consults per run").props["data-on-reset-override"]());
    expect(state.runPlan).toHaveBeenCalledTimes(1);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("marks only the field that differs between machines as mixed", () => {
    withAdvisor({ enabled: true });
    state.targetSettings = [
      { advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: true } },
      { advisor: { ...DEFAULT_ADVISOR_SETTINGS, enabled: true, maxConsultsPerRun: 5 } },
    ];
    render();
    expect(row("Consults per run").props["data-mixed"]).toBe(true);
    expect(row("Brief size").props["data-mixed"]).toBe(false);
    expect(row("Let threads ask a stronger model").props["data-mixed"]).toBe(false);
    // The rest of the section still follows the shared switch, which is on.
    expect(numberIn("Brief size").props.disabled).toBe(false);
  });

  it("draws the unset model picker with a border so it reads as a control", () => {
    withAdvisor({ enabled: true });
    render();
    expect(byLabel("Advisor model").props["data-trigger-class"]).toContain("border");
    withAdvisor({ enabled: true, model: { instanceId: codex, model: "gpt-6.1-sol" } });
    render();
    expect(byLabel("Advisor model").props["data-trigger-class"]).not.toContain("border");
  });

  it("is hidden on a server that does not offer the advisor", () => {
    state.advisorCapability = undefined;
    render();
    expect(renderer!.toJSON()).toBeNull();
    expect(advisorSettingsAvailable([])).toBe(false);
    expect(
      advisorSettingsAvailable([
        { serverConfig: { environment: { capabilities: { advisor: true } } } },
        { serverConfig: { environment: { capabilities: {} } } },
      ]),
    ).toBe(false);
  });
});
