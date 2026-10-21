import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TASK_ROUTING_SETTINGS,
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
  providers: [] as unknown[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "project" }, target: { environmentId: "mac" } }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={props["aria-label"]}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    control,
    status,
    children,
  }: {
    title: string;
    control?: ReactNode;
    status?: string;
    children?: ReactNode;
  }) => (
    <section aria-label={title} data-status={status}>
      {control}
      {children}
    </section>
  ),
  SettingResetButton: () => null,
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

import {
  routingProviderEntries,
  routingProviderState,
  TaskRoutingSettings,
  tierOptionsFor,
} from "./TaskRoutingSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...over,
});

const PROVIDERS = [
  provider("claudeAgent", "claudeAgent", "Claude Code"),
  provider("acpRegistry_copilot", "acpRegistry", "GitHub Copilot (ACP)"),
  provider("codex", "codex", "Codex"),
  provider("copilot-0889", "copilot", "GitHub Copilot", {
    status: "warning",
    auth: { status: "unknown" },
  }),
];

let renderer: ReactTestRenderer | undefined;
const byLabel = (label: string) =>
  renderer!.root.find((node) => node.props["aria-label"] === label);
const select = (label: string) => byLabel(label).findByType("select");
const render = () =>
  act(() => {
    renderer = create(<TaskRoutingSettings />);
  });
const withPolicy = (change: Partial<typeof DEFAULT_TASK_ROUTING_SETTINGS>) => {
  state.settings = {
    ...state.settings,
    taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, ...change },
  };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = resolveProjectSettings(
    DEFAULT_SERVER_SETTINGS,
    ProjectId.make("p"),
    null,
    null,
  ).settings;
  state.update.mockReset();
  state.providers = PROVIDERS;
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("TaskRoutingSettings", () => {
  it("is off by default and shows nothing else until turned on", () => {
    render();
    const toggle = byLabel("Auto model routing").findByType("input");
    expect(toggle.props.checked).toBe(false);
    expect(byLabel("Auto model routing").props["data-status"]).toBe(
      "Off: workers keep their usual model",
    );
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "Quality preference"),
    ).toHaveLength(0);
    act(() => toggle.props.onChange({ target: { checked: true } }));
    // The whole policy is written, so a project override never half-inherits.
    expect(state.update).toHaveBeenCalledWith({
      taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, mode: "auto" },
    });
  });

  it("explains the long-audio pipeline once Auto is on", () => {
    withPolicy({ mode: "auto" });
    render();
    const notes = renderer!.root.find((node) => node.props["data-routing-notes"] !== undefined);
    const text = JSON.stringify(notes.findAllByType("p").map((p) => p.props.children));
    expect(text).toContain("Long audio is transcribed first");
    expect(text).toContain("split into chunks");
  });

  it("sets a per-class tier and never offers Economy for high-risk classes", () => {
    withPolicy({ mode: "auto" });
    render();
    const tierSelect = (taskClass: string) =>
      renderer!.root
        .find((node) => node.type === "li" && node.props["data-task-class"] === taskClass)
        .findByType("select");
    const code = tierSelect("code");
    const codeOptions = code.findAllByType("option").map((option) => option.props.value);
    expect(codeOptions).toEqual(["default", "standard", "frontier"]);
    const translation = tierSelect("translation");
    act(() => translation.props.onChange({ target: { value: "economy" } }));
    expect(state.update).toHaveBeenLastCalledWith({
      taskRouting: {
        ...DEFAULT_TASK_ROUTING_SETTINGS,
        mode: "auto",
        classTiers: { translation: "economy" },
      },
    });
  });

  it("asks before allowing paid API models and saves nothing on cancel", () => {
    withPolicy({ mode: "auto" });
    render();
    act(() => select("Paid API models").props.onChange({ target: { value: "economy" } }));
    expect(state.update).not.toHaveBeenCalled();
    const dialog = renderer!.root.find((node) => node.props.role === "alertdialog");
    expect(JSON.stringify(dialog.findByType("p").props.children)).toContain("API rates");
    const allow = dialog
      .findAllByType("button")
      .find((button) => button.props.children === "Allow paid API");
    act(() => allow!.props.onClick());
    expect(state.update).toHaveBeenCalledWith({
      taskRouting: { ...DEFAULT_TASK_ROUTING_SETTINGS, mode: "auto", paidApi: "economy" },
    });
  });

  it("lists both Copilot providers side by side, each with its own state, and excludes one", () => {
    withPolicy({ mode: "auto" });
    render();
    const rows = renderer!.root
      .findAll((node) => node.type === "li" && node.props["data-routing-provider"] !== undefined)
      .map((node) => node.props["data-routing-provider"]);
    const first = rows.indexOf("acpRegistry_copilot");
    expect(rows[first + 1]).toBe("copilot-0889");
    act(() =>
      byLabel("Auto may use GitHub Copilot (copilot-0889)")
        .findByType("input")
        .props.onChange({ target: { checked: false } }),
    );
    expect(state.update).toHaveBeenCalledWith({
      taskRouting: {
        ...DEFAULT_TASK_ROUTING_SETTINGS,
        mode: "auto",
        excludedProviders: ["copilot-0889"],
      },
    });
  });

  it("flags a project worker model Auto may move work below", () => {
    withPolicy({ mode: "auto" });
    state.settings = {
      ...state.settings,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    };
    render();
    const conflicts = byLabel("Routing conflicts");
    expect(JSON.stringify(conflicts.findAllByType("li").map((li) => li.props.children))).toContain(
      "This project's workers start on claude-opus-5-5",
    );
  });
});

describe("routing provider helpers", () => {
  it("groups Copilot harnesses and keeps the rest in order", () => {
    const entries = routingProviderEntries(deriveProviderInstanceEntries(PROVIDERS));
    expect(entries.map((entry) => entry.instanceId)).toEqual([
      "claudeAgent",
      "acpRegistry_copilot",
      "copilot-0889",
      "codex",
    ]);
  });

  it("names ready, unknown and unavailable states", () => {
    const [claude, , , copilot] = deriveProviderInstanceEntries(PROVIDERS);
    expect(routingProviderState(claude!)).toBe("Ready");
    expect(routingProviderState(copilot!)).toBe("State unknown");
    const [gone] = deriveProviderInstanceEntries([
      provider("copilot-0889", "copilot", "GitHub Copilot", { availability: "unavailable" }),
    ]);
    expect(routingProviderState(gone!)).toBe("Unavailable");
  });

  it("keeps high-risk classes at Standard or above", () => {
    expect(tierOptionsFor("review")).toEqual(["standard", "frontier"]);
    // Unclassified work stays on the strongest tier.
    expect(tierOptionsFor("general")).toEqual(["frontier"]);
    expect(tierOptionsFor("translation")).toEqual(["economy", "standard", "frontier"]);
  });
});
