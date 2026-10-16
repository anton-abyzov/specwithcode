import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  environment: {} as typeof DEFAULT_SERVER_SETTINGS,
  target: {} as ReturnType<typeof resolveProjectSettings>,
  mixed: false,
  update: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "worker", serverConfig: { settings: state.environment, providers: [] } },
    ],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "project", group: { displayName: "specweave" } },
    target: { environmentId: "worker", ...state.target },
    targets: [],
    connectedEnvironments: [{}],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.target.settings,
  useScopedSettingsMixed: (keys: string[]) => keys.includes("defaultThreadEnvMode") && state.mixed,
  useScopedSettingSource: () => "environment",
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./ProviderLimitSettings", () => ({ ProviderLimitSettings: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: ReactNode;
  }) => (
    <section aria-label={title}>
      {description}
      {control}
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
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
const project = ProjectId.make("project");
let renderer: ReactTestRenderer | undefined;
function render() {
  act(() => {
    renderer = create(<ProjectDefaultsSettings category="project" />);
  });
  return renderer!.root.findByProps({ "aria-label": "Workspace" }).findByType("select");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environment = DEFAULT_SERVER_SETTINGS;
  state.target = resolveProjectSettings(state.environment, project, null, null);
  state.mixed = false;
  state.update.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("web workspace default presentation", () => {
  it("shows automatic for inherited built-in local storage", () => {
    expect(state.target.settings.defaultThreadEnvMode).toBe("local");
    expect(render().props.value).toBe("automatic");
    expect(JSON.stringify(renderer!.toJSON())).toContain("non-Git folders in the current checkout");
  });
  it.each(["local", "worktree"] as const)("preserves explicit environment %s", (mode) => {
    state.environment = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: mode };
    state.target = resolveProjectSettings(state.environment, project, null, null);
    expect(render().props.value).toBe(mode);
  });
  it("shows an explicit checkout file choice", () => {
    state.target = resolveProjectSettings(state.environment, project, null, {
      defaultThreadEnvMode: "local",
    });
    expect(render().props.value).toBe("local");
  });
  it("shows an explicit project choice", () => {
    state.environment = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [project]: { defaultThreadEnvMode: "worktree" } },
    };
    state.target = resolveProjectSettings(state.environment, project, null, null);
    expect(render().props.value).toBe("worktree");
  });
  it("keeps mixed values distinct and stores automatic as null", () => {
    state.mixed = true;
    const picker = render();
    expect(picker.props.value).toBe("mixed");
    act(() => picker.props.onChange({ target: { value: "automatic" } }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({ defaultThreadEnvMode: null });
  });
  it("puts every new-thread override on the Project page", () => {
    render();
    const titles = renderer!.root
      .findAllByType("section")
      .map((section) => section.props["aria-label"]);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Model",
        "Permissions",
        "Workspace",
        "Submodules",
        "Start from origin",
      ]),
    );
  });
  it("points a category page to the Project page while a project is picked", () => {
    act(() => {
      renderer = create(<ProjectDefaultsSettings category="source-control" />);
    });
    const titles = renderer!.root
      .findAllByType("section")
      .map((section) => section.props["aria-label"]);
    expect(titles).toEqual(["Set on the Project page"]);
    act(() => renderer!.unmount());
    act(() => {
      renderer = create(<ProjectDefaultsSettings category="source-control" onProjectPage />);
    });
    expect(
      renderer!.root.findAllByType("section").map((section) => section.props["aria-label"]),
    ).toContain("Refresh upstreams at startup");
  });
});
