import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  environment: {} as typeof DEFAULT_SERVER_SETTINGS,
  target: {} as ReturnType<typeof resolveProjectSettings>,
  mixed: false,
  scope: "environment" as "environment" | "project",
  update: vi.fn(),
  folderCheck: null as unknown,
  checkedProject: undefined as unknown,
}));
vi.mock("../../studio/useProjectFolderHealth", () => ({
  useProjectFolderCheck: (project: unknown) => {
    state.checkedProject = project;
    return state.folderCheck;
  },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "worker", serverConfig: { settings: state.environment, providers: [] } },
    ],
  }),
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (_environmentId: string, label?: string | null) => label ?? "",
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope:
      state.scope === "project"
        ? {
            kind: "project",
            group: { displayName: "specweave" },
            members: [{ id: "project", environmentId: "worker", workspaceRoot: "/w/umbrella" }],
          }
        : { kind: "environment" },
    target: { environmentId: "worker", projectId: "project", ...state.target },
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
vi.mock("./TaskRoutingSettings", () => ({ TaskRoutingSettings: () => null }));
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
vi.mock("../ui/switch", () => ({
  Switch: (props: { checked: boolean; onCheckedChange: (checked: boolean) => void }) => (
    <input type="checkbox" onChange={() => undefined} {...props} />
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
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
const project = ProjectId.make("project");
let renderer: ReactTestRenderer | undefined;
function render() {
  act(() => {
    renderer = create(<ProjectDefaultsSettings category="project" />);
  });
  return renderer!;
}
function renderUseWorktrees() {
  act(() => {
    renderer = create(<ProjectDefaultsSettings category="project" />);
  });
  return renderer!.root.findByProps({ "aria-label": "Use worktrees", type: "checkbox" });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environment = DEFAULT_SERVER_SETTINGS;
  state.target = resolveProjectSettings(state.environment, project, null, null);
  state.mixed = false;
  state.scope = "environment";
  state.update.mockClear();
  state.folderCheck = null;
  state.checkedProject = undefined;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("web workspace default presentation", () => {
  it("offers no machine-wide workspace choice and points at Projects", () => {
    expect(state.target.settings.defaultThreadEnvMode).toBe("local");
    render();
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Set per project");
    expect(text).toContain("Open Projects");
    expect(text).not.toContain("Automatic (Git worktree)");
    // Environment defaults read no project folder.
    expect(state.checkedProject).toBeNull();
  });
  it.each(["local", "worktree"] as const)(
    "ignores a stored environment workspace value of %s",
    (mode) => {
      state.environment = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: mode };
      state.target = resolveProjectSettings(state.environment, project, null, null);
      expect(state.target.settings.defaultThreadEnvMode).toBe("local");
      render();
      expect(JSON.stringify(renderer!.toJSON())).toContain("Set per project");
    },
  );
  it("puts every new-thread override on the Project page", () => {
    state.scope = "project";
    renderUseWorktrees();
    const titles = renderer!.root
      .findAllByType("section")
      .map((section) => section.props["aria-label"]);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Model",
        "Permissions",
        "Use worktrees",
        "Submodules",
        "Start from origin",
      ]),
    );
  });
  it("points a category page to the Project page while a project is picked", () => {
    state.scope = "project";
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
describe("project Use worktrees switch", () => {
  beforeEach(() => {
    state.scope = "project";
  });
  it("is off unless the project itself chose worktrees", () => {
    expect(renderUseWorktrees().props.checked).toBe(false);
    // An environment-wide worktree default does not turn on the project's switch.
    state.environment = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" };
    state.target = resolveProjectSettings(state.environment, project, null, null);
    act(() => renderer?.unmount());
    expect(renderUseWorktrees().props.checked).toBe(false);
  });
  it("shows and stores the project's choice", () => {
    state.environment = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [project]: { defaultThreadEnvMode: "worktree" } },
    };
    state.target = resolveProjectSettings(state.environment, project, null, null);
    const toggle = renderUseWorktrees();
    expect(toggle.props.checked).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("including ones the coordinator starts");
    act(() => toggle.props.onCheckedChange(false));
    expect(state.update).toHaveBeenLastCalledWith({ defaultThreadEnvMode: "local" });
    act(() => toggle.props.onCheckedChange(true));
    expect(state.update).toHaveBeenLastCalledWith({ defaultThreadEnvMode: "worktree" });
  });
});

describe("Use worktrees recommendation", () => {
  const layout = (overrides: Record<string, unknown>) => ({
    layout: {
      kind: "single",
      rootIsRepository: true,
      repositories: [],
      repositoryCount: 0,
      truncated: false,
      separateClones: false,
      ...overrides,
    },
  });
  const text = () => JSON.stringify(renderer!.toJSON());

  it("recommends off for an umbrella without changing the switch", () => {
    state.scope = "project";
    state.folderCheck = layout({
      kind: "umbrella",
      repositories: ["repositories/acme/api", "repositories/acme/web"],
      repositoryCount: 2,
      separateClones: true,
    });
    const toggle = renderUseWorktrees();
    expect(state.checkedProject).toMatchObject({ id: "project", environmentId: "worker" });
    expect(text()).toContain("Recommended for this folder: off.");
    expect(text()).toContain("an umbrella holding 2 repositories");
    expect(toggle.props.checked).toBe(false);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("recommends on for one Git repository", () => {
    state.scope = "project";
    state.folderCheck = layout({});
    renderUseWorktrees();
    expect(text()).toContain("Recommended for this folder: on.");
  });

  it("says nothing before the folder is checked", () => {
    state.scope = "project";
    renderUseWorktrees();
    expect(text()).not.toContain("Recommended for this folder");
  });
});
