import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  multiple: false,
  member: undefined as
    | Pick<SidebarProjectGroupMember, "environmentId" | "workspaceSettings">
    | undefined,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: state.member ? { kind: "checkout", members: [state.member] } : { kind: "environment" },
    targets: [{ environmentId: "fixture" }],
    connectedEnvironments: (state.multiple ? ["one", "two"] : ["one"]).map((environmentId) => ({
      environmentId,
      serverConfig: {
        environment: {
          capabilities: { worktreeLocationMode: true },
          defaultWorktreesDirectory: "/app/worktrees",
        },
      },
    })),
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
  useScopedSettingsMixed: () => false,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./SettingsScopeNotice", () => ({ SettingsScopeNotice: () => null }));
vi.mock("./settingsLayout", () => ({
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
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
}));
import { WorktreesDirectoryRow } from "./StorageSettings";
import { WorkspaceModeControl } from "../chat/WorkspaceModeControl";
let renderer: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.settings = { ...DEFAULT_SERVER_SETTINGS };
  state.multiple = false;
  state.member = undefined;
  state.update.mockClear();
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});
it("shows the authoritative managed path and saves explicit placement", () => {
  act(() => {
    renderer = create(<WorktreesDirectoryRow />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("/app/worktrees");
  act(() => renderer.root.findByType("select").props.onChange({ target: { value: "project" } }));
  expect(state.update).toHaveBeenCalledWith({ worktreeLocationMode: "project" });
});
it("preserves legacy custom storage and limits custom paths to one machine", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, worktreesDirectory: "/legacy" };
  state.multiple = true;
  act(() => {
    renderer = create(<WorktreesDirectoryRow />);
  });
  expect(renderer.root.findByType("select").props.value).toBe("custom");
  expect(renderer.root.findByProps({ "aria-label": "Worktree location" }).props.disabled).toBe(
    true,
  );
  act(() => renderer.root.findByType("select").props.onChange({ target: { value: "custom" } }));
  expect(state.update).not.toHaveBeenCalled();
});
it("makes opting out explicit and never changes a saved local choice on render", () => {
  const onChange = vi.fn();
  act(() => {
    renderer = create(<WorkspaceModeControl mode="local" onChange={onChange} />);
  });
  expect(renderer.root.findByType("input").props.checked).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("Current checkout");
  act(() => renderer.root.findByType("input").props.onChange({ target: { checked: true } }));
  expect(onChange).toHaveBeenCalledWith("worktree");
});

it("reads a single configured repository from the actual project member settings shape", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, worktreeLocationMode: "project" };
  state.member = {
    environmentId: EnvironmentId.make("fixture"),
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      environment: {
        additionalFolders: [],
        repositories: [
          {
            id: "application",
            url: "https://github.com/example/application.git",
            localPath: "/workspace/application",
          },
        ],
      },
    },
  } satisfies Pick<SidebarProjectGroupMember, "environmentId" | "workspaceSettings">;
  act(() => {
    renderer = create(<WorktreesDirectoryRow />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "/workspace/application/.specwithcode/worktrees",
  );
});
it("keeps the selected repository unknown when its checkout is unprepared", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, worktreeLocationMode: "project" };
  state.member = {
    environmentId: EnvironmentId.make("fixture"),
    workspaceSettings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      environment: {
        additionalFolders: [],
        repositories: [
          { id: "application", url: "https://github.com/example/application.git", localPath: null },
        ],
      },
    },
  } satisfies Pick<SidebarProjectGroupMember, "environmentId" | "workspaceSettings">;
  act(() => {
    renderer = create(<WorktreesDirectoryRow />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain(
    "<selected Git repository>/.specwithcode/worktrees",
  );
});
