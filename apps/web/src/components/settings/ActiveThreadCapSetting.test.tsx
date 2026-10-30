import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { planScopedSettingsPatch } from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";
const state = vi.hoisted(() => ({ cap: 200 as number | null, mixed: false, update: vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ keepActiveThreadsPerProject: state.cap }),
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
    resetAction,
    settingKeys,
  }: {
    title: string;
    description: string;
    control: ReactNode;
    resetAction: ReactNode;
    settingKeys: readonly string[];
  }) => (
    <div data-keys={settingKeys.join(",")}>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Reset</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
import { ActiveThreadCapSetting } from "./ActiveThreadCapSetting";
let view: ReactTestRenderer;
beforeEach(() => {
  state.cap = 200;
  state.mixed = false;
  state.update.mockClear();
});
afterEach(async () => {
  await act(async () => view?.unmount());
});
const render = async () => {
  await act(async () => {
    view = create(<ActiveThreadCapSetting />);
  });
};
const choose = async (value: string) => {
  await act(async () => view.root.findByType("select").props.onChange({ target: { value } }));
};
it("defaults to 200 chats and explains what is archived and what is protected", async () => {
  await render();
  expect(view.root.findByType("h3").children).toEqual(["Keep active chats per project"]);
  expect(view.root.findByType("select").props.value).toBe("default");
  expect(view.root.findAllByType("input")).toHaveLength(0);
  expect(view.root.findAllByType("button")).toHaveLength(0);
  const help = view.root.findByType("p").children.join(" ");
  expect(help).toContain("oldest finished ones are archived");
  expect(help).toContain("Unarchive brings a chat back");
  expect(help).toContain("Running, waiting, pinned or recently active chats are never archived");
});
it("saves a custom value from 20 to 5000 and rejects anything else", async () => {
  state.cap = 500;
  await render();
  expect(view.root.findByType("select").props.value).toBe("custom");
  const input = view.root.findByType("input");
  expect(input.props).toMatchObject({ defaultValue: 500, min: 20, max: 5000 });
  for (const value of ["", "0", "19", "-20", "20.5", "5001", "abc"]) {
    const target = { value };
    await act(async () => input.props.onBlur({ target }));
    expect(target.value).toBe("500");
  }
  expect(state.update).not.toHaveBeenCalled();
  await act(async () => input.props.onBlur({ target: { value: "20" } }));
  await act(async () => input.props.onBlur({ target: { value: "5000" } }));
  expect(state.update.mock.calls).toEqual([
    [{ keepActiveThreadsPerProject: 20 }],
    [{ keepActiveThreadsPerProject: 5000 }],
  ]);
});
it("turns the cap off with No limit and back on through Custom and Reset", async () => {
  await render();
  await choose("none");
  expect(state.update).toHaveBeenLastCalledWith({ keepActiveThreadsPerProject: null });
  state.cap = null;
  await render();
  expect(view.root.findByType("select").props.value).toBe("none");
  await choose("custom");
  expect(state.update).toHaveBeenLastCalledWith({ keepActiveThreadsPerProject: 200 });
  await act(async () => view.root.findByType("button").props.onClick());
  expect(state.update).toHaveBeenLastCalledWith({ keepActiveThreadsPerProject: 200 });
});
it("shows Mixed across targets and applies a picked value to all of them", async () => {
  state.mixed = true;
  await render();
  expect(view.root.findByType("select").props.value).toBe("mixed");
  await choose("default");
  expect(state.update).toHaveBeenLastCalledWith({ keepActiveThreadsPerProject: 200 });
});

const projectId = ProjectId.make("project");
const environment = (settings: Partial<ServerSettings> = {}) => ({
  environmentId: EnvironmentId.make("Server"),
  label: "Server",
  connection: { phase: "connected" as const },
  serverConfig: {
    settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    environment: { capabilities: { projectSettingsOverrides: true } },
  },
});
const member = {
  id: projectId,
  environmentId: EnvironmentId.make("Server"),
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: "Server:/repo",
  environmentLabel: "Server",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member],
  memberProjectRefs: [{ environmentId: member.environmentId, projectId }],
  groupedProjectCount: 1,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: ["Server"],
};
it("writes a per-project override that wins over the environment default", async () => {
  const environments = [environment({ keepActiveThreadsPerProject: 1000 })];
  const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
  for (const keepActiveThreadsPerProject of [50, null]) {
    const plan = planScopedSettingsPatch(project, environments, { keepActiveThreadsPerProject });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: member.environmentId,
        label: "Server",
        patch: { projectSettingsOverrides: { [projectId]: { keepActiveThreadsPerProject } } },
      },
    ]);
  }
  const overridden = environment({
    keepActiveThreadsPerProject: 1000,
    projectSettingsOverrides: { [projectId]: { keepActiveThreadsPerProject: 50 } },
  }).serverConfig.settings;
  expect(resolveProjectSettings(overridden, projectId).settings.keepActiveThreadsPerProject).toBe(
    50,
  );
  expect(resolveProjectSettings(overridden, null).settings.keepActiveThreadsPerProject).toBe(1000);
  // The project's effective value drives the row, so the override shows as its custom count.
  state.cap = 50;
  await render();
  expect(view.root.findAllByProps({ "data-keys": "keepActiveThreadsPerProject" })).toHaveLength(1);
  expect(view.root.findByType("select").props.value).toBe("custom");
  expect(view.root.findByType("input").props.defaultValue).toBe(50);
});
