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
  groups: [] as unknown[],
  providers: [] as unknown[],
  picker: null as null | {
    onInstanceModelChange: (instanceId: string, model: string) => void;
  },
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("../../teamRules/useFolderTeamRules", () => ({
  useFolderTeamRulesSummary: () => undefined,
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
      {
        environmentId: "worker",
        serverConfig: { settings: state.environment, providers: state.providers },
      },
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
vi.mock("../chat/ProviderModelPicker", () => ({
  // The Model row renders the first picker; Model lanes below render their own.
  ProviderModelPicker: (props: NonNullable<typeof state.picker>) => {
    state.picker ??= props;
    return null;
  },
}));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("./ProviderLimitSettings", () => ({ ProviderLimitSettings: () => null }));
vi.mock("./TaskRoutingSettings", () => ({ TaskRoutingSettings: () => null }));
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toastAdd } }));
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
import { ProjectDefaultsSettings, UseWorktreesSetting } from "./ProjectDefaultsSettings";
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
  state.groups = [];
  state.providers = [];
  state.picker = null;
  toastAdd.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("web workspace default presentation", () => {
  it("offers only a default for new projects and points at Projects", () => {
    expect(state.target.settings.defaultThreadEnvMode).toBe("local");
    render();
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Use worktrees for new projects");
    expect(text).toContain("existing projects keep theirs");
    expect(text).toContain("Open Projects");
    expect(text).not.toContain("Automatic (Git worktree)");
    // Environment defaults read no project folder.
    expect(state.checkedProject ?? null).toBeNull();
    const toggle = renderer!.root.findByProps({
      "aria-label": "Use worktrees for new projects",
      type: "checkbox",
    });
    expect(toggle.props.checked).toBe(false);
    act(() => toggle.props.onCheckedChange(true));
    // Only the environment's new-project default changes, never a project's switch.
    expect(state.update).toHaveBeenCalledWith({ newProjectThreadEnvMode: "worktree" });
  });
  it("lists the projects that have Use worktrees on when projects differ", () => {
    const code = (id: string) => ({ id, environmentId: "worker", workspaceSettings: undefined });
    state.environment = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [ProjectId.make("p-atlas")]: { defaultThreadEnvMode: "worktree" },
        [ProjectId.make("p-beacon")]: { defaultThreadEnvMode: "local" },
      },
    } as typeof DEFAULT_SERVER_SETTINGS;
    state.groups = [
      { displayName: "Atlas", memberProjects: [code("p-atlas")] },
      { displayName: "Beacon", memberProjects: [code("p-beacon")] },
      { displayName: "Comet", memberProjects: [code("p-comet")] },
      {
        displayName: "Aide",
        memberProjects: [{ ...code("p-aide"), workspaceSettings: { kind: "personal" } }],
      },
    ];
    const summary = () => {
      const node = renderer!.root.find(
        (candidate) => candidate.props["data-project-worktrees-summary"] !== undefined,
      );
      const textOf = (value: unknown): string =>
        typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.map(textOf).join("")
            : value && typeof value === "object" && "children" in value
              ? textOf((value as { children: unknown }).children)
              : "";
      return node.children.map(textOf).join("");
    };
    render();
    expect(summary()).toBe("On in Atlas; off in the other 2.");
    // When every project agrees, it says so instead of listing them.
    state.groups = state.groups.slice(1, 3);
    render();
    expect(summary()).toBe("Every project has it off.");
  });
  it.each(["local", "worktree"] as const)(
    "ignores a stored environment workspace value of %s",
    (mode) => {
      state.environment = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: mode };
      state.target = resolveProjectSettings(state.environment, project, null, null);
      expect(state.target.settings.defaultThreadEnvMode).toBe("local");
      render();
      expect(JSON.stringify(renderer!.toJSON())).toContain("Use worktrees for new projects");
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
  it("is the same switch on its own, as the project General tab renders it", () => {
    state.environment = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [project]: { defaultThreadEnvMode: "worktree" } },
    };
    state.target = resolveProjectSettings(state.environment, project, null, null);
    act(() => {
      renderer = create(<UseWorktreesSetting />);
    });
    const toggle = renderer!.root.findByProps({ "aria-label": "Use worktrees", type: "checkbox" });
    expect(toggle.props.checked).toBe(true);
    act(() => toggle.props.onCheckedChange(false));
    expect(state.update).toHaveBeenLastCalledWith({ defaultThreadEnvMode: "local" });
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

const provider = (instanceId: string, driver: string, displayName: string, models: unknown[]) => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-08T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
});
const level = (id: string, label = id) => ({ id, label });
const CLAUDE = provider("claudeAgent", "claudeAgent", "Claude Code", [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [level("high", "High"), level("xhigh", "Extra High"), level("max", "Max")],
        },
        { id: "fastMode", label: "Fast Mode", type: "boolean" },
        { id: "ultracode", label: "Ultracode", type: "boolean" },
      ],
    },
  },
]);
const COPILOT = provider("acpRegistry_copilot", "acpRegistry", "GitHub Copilot", [
  {
    slug: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoning_effort",
          label: "Reasoning effort",
          type: "select",
          options: [level("medium"), level("high"), level("xhigh")],
        },
      ],
    },
  },
]);

describe("default model options", () => {
  const unsupportedLine = () =>
    renderer!.root.findAll((node) => node.props["data-default-model-unsupported"] !== undefined);
  const withDefault = (selection: unknown) => {
    state.providers = [CLAUDE, COPILOT];
    state.environment = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: selection,
    } as typeof DEFAULT_SERVER_SETTINGS;
    state.target = resolveProjectSettings(state.environment, project, null, null);
  };

  it("keeps effort and names Ultracode and Fast mode when the default moves to Copilot", () => {
    withDefault({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "ultracode", value: true },
      ],
    });
    render();
    // Claude offers every common option, so nothing is named as missing.
    expect(unsupportedLine()).toHaveLength(0);
    act(() => state.picker!.onInstanceModelChange("acpRegistry_copilot", "claude-opus-5.5"));
    expect(state.update).toHaveBeenCalledWith({
      defaultModelSelection: {
        instanceId: "acpRegistry_copilot",
        model: "claude-opus-5.5",
        options: [{ id: "reasoning_effort", value: "xhigh" }],
      },
    });
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        description: "GitHub Copilot has no Ultracode or Fast mode, so they were left off.",
      }),
    );
  });

  it("names the options the chosen provider lacks on the row", () => {
    withDefault({
      instanceId: "acpRegistry_copilot",
      model: "claude-opus-5.5",
      options: [{ id: "reasoning_effort", value: "high" }],
    });
    render();
    const [line] = unsupportedLine();
    expect(line?.children.join("")).toBe("GitHub Copilot has no Fast mode or Ultracode.");
  });
});
