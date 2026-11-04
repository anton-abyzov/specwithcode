import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  clear: vi.fn(),
  providers: [] as unknown[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "project" }, target: { environmentId: "mac" } }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => state.clear,
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    triggerAriaLabel: string;
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button
      aria-label={props.triggerAriaLabel}
      onClick={() => props.onInstanceModelChange("codex", "gpt-6.1-sol")}
    />
  ),
}));
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
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  PolicyTooltip: () => null,
  useRelativeTimeTick: () => Date.now(),
  SettingsRow: ({
    title,
    control,
    status,
    resetAction,
    children,
  }: {
    title: string;
    control?: ReactNode;
    status?: string;
    resetAction?: ReactNode;
    children?: ReactNode;
  }) => (
    <section aria-label={title} data-status={status}>
      {control}
      {resetAction}
      {children}
    </section>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button aria-label={`Reset ${label} to default`} onClick={onClick} />
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (v: string) => void;
  }) => (
    <select value={value ?? "mixed"} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import { AdversarialReviewSettings } from "./AdversarialReviewSettings";
import {
  ProviderModelTiersSettings,
  resetProviderTierModels,
  setProviderTierModel,
} from "./ProviderModelTiersSettings";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const providerList = [
  {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    displayName: "Claude",
    models: [
      { slug: "claude-opus-5-5", name: "Opus 5.5" },
      { slug: "claude-fable-5-1", name: "Fable 5.1" },
    ],
  },
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    displayName: "Codex",
    models: [
      { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { slug: "gpt-6-astra", name: "GPT-6 Astra" },
    ],
  },
] as unknown as ServerProvider[];

let renderer: ReactTestRenderer | undefined;
const byLabel = (label: string) =>
  renderer!.root.find((node) => node.props["aria-label"] === label);
const render = (element: ReactNode) =>
  act(() => {
    renderer = create(<>{element}</>);
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
  state.clear.mockReset();
  state.providers = providerList;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("AdversarialReviewSettings", () => {
  it("is off by default and writes only the switch when turned on", () => {
    render(<AdversarialReviewSettings />);
    const toggle = byLabel("Review finished features automatically").findByType("input");
    expect(toggle.props.checked).toBe(false);
    act(() => toggle.props.onChange({ target: { checked: true } }));
    expect(state.update).toHaveBeenCalledWith({
      adversarialReview: { autoOnFeatureComplete: true },
    });
  });

  it("writes only the review depth", () => {
    state.settings = {
      ...state.settings,
      adversarialReview: { autoOnFeatureComplete: true, reviewers: [], tier: "regular" },
    };
    render(<AdversarialReviewSettings />);
    const depth = byLabel("Review depth").findByType("select");
    expect(depth.props.value).toBe("regular");
    act(() => depth.props.onChange({ target: { value: "frontier" } }));
    expect(state.update).toHaveBeenCalledWith({ adversarialReview: { tier: "frontier" } });
  });

  it("shows the default order as steps, other families first, and customizes it", () => {
    render(<AdversarialReviewSettings />);
    const order = byLabel("Reviewer order");
    expect(
      order.find((node) => node.props["data-reviewer-order"] !== undefined).props[
        "data-reviewer-order"
      ],
    ).toBe("default");
    const steps = byLabel("Reviewer order steps").findAllByType("li");
    expect(
      steps.map(
        (step) =>
          step.findAll((node) => node.props["data-label"] !== undefined)[0]!.props["data-label"],
      ),
    ).toEqual(["Codex · GPT-6.1 Sol", "Claude · Opus 5.5"]);
    // A default order cannot be edited in place until it is customized.
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Move Claude · Opus 5.5 up"),
    ).toHaveLength(0);
    act(() => byLabel("Customize reviewer order").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({
      adversarialReview: {
        reviewers: [
          { instanceId: codex, model: "gpt-6.1-sol" },
          { instanceId: claude, model: "claude-opus-5-5" },
        ],
      },
    });
  });

  it("adds, moves and clears the whole reviewer list", () => {
    const first = { instanceId: claude, model: "claude-opus-5-5" };
    state.settings = {
      ...state.settings,
      adversarialReview: { autoOnFeatureComplete: false, reviewers: [first], tier: "frontier" },
    };
    render(<AdversarialReviewSettings />);
    act(() => byLabel("Add a reviewer model").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({
      adversarialReview: { reviewers: [first, { instanceId: codex, model: "gpt-6.1-sol" }] },
    });

    state.settings = {
      ...state.settings,
      adversarialReview: {
        autoOnFeatureComplete: false,
        reviewers: [first, { instanceId: codex, model: "gpt-6.1-sol" }],
        tier: "frontier",
      },
    };
    render(<AdversarialReviewSettings />);
    act(() => byLabel("Move Codex · GPT-6.1 Sol up").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({
      adversarialReview: { reviewers: [{ instanceId: codex, model: "gpt-6.1-sol" }, first] },
    });
    act(() => byLabel("Reset reviewer order to default").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({ adversarialReview: { reviewers: [] } });
  });
});

describe("AdversarialReviewSettings stored duplicates", () => {
  it("shows a repeated model once and saves the list without the repeat", () => {
    const opus = { instanceId: claude, model: "claude-opus-5-5" };
    const sol = { instanceId: codex, model: "gpt-6.1-sol" };
    state.settings = {
      ...state.settings,
      adversarialReview: {
        autoOnFeatureComplete: false,
        reviewers: [opus, opus, sol],
        tier: "regular",
      },
    };
    render(<AdversarialReviewSettings />);
    expect(byLabel("Reviewer order steps").findAllByType("li")).toHaveLength(2);
    act(() => byLabel("Move Codex · GPT-6.1 Sol up").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({
      adversarialReview: { reviewers: [sol, opus] },
    });
  });
});

describe("ProviderModelTiersSettings", () => {
  it("shows the built-in tier models of each provider", () => {
    render(<ProviderModelTiersSettings />);
    expect(
      byLabel("Claude")
        .findAllByType("select")
        .map((select) => select.props.value),
    ).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
    expect(
      byLabel("Codex")
        .findAllByType("select")
        .map((select) => select.props.value),
    ).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
  });

  it("writes the whole tiers object for one provider and resets it", () => {
    state.settings = { ...state.settings, modelTiers: { codex: { regular: "gpt-6-astra" } } };
    render(<ProviderModelTiersSettings />);
    const [regular, frontier] = byLabel("Claude").findAllByType("select");
    expect(regular?.props.value).toBe("claude-opus-5-5");
    act(() => frontier!.props.onChange({ target: { value: "claude-opus-5-5" } }));
    expect(state.update).toHaveBeenLastCalledWith({
      modelTiers: {
        codex: { regular: "gpt-6-astra" },
        claudeAgent: { frontier: "claude-opus-5-5" },
      },
    });
    act(() => byLabel("Reset Codex tier models to default").props.onClick());
    expect(state.update).toHaveBeenLastCalledWith({ modelTiers: { codex: {} } });
    const resetAll = byLabel("Inherited tier models").find(
      (node) => node.type === "button" && node.props.children === "Use machine settings",
    );
    act(() => resetAll.props.onClick());
    expect(state.clear).toHaveBeenCalledWith(["modelTiers"]);
  });

  it("merges and empties one provider's choices", () => {
    expect(setProviderTierModel({ a: { regular: "x" } }, "a", "frontier", "y")).toEqual({
      a: { regular: "x", frontier: "y" },
    });
    expect(resetProviderTierModels({ a: { regular: "x" }, b: { regular: "z" } }, "a")).toEqual({
      a: {},
      b: { regular: "z" },
    });
  });
});
