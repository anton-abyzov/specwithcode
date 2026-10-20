import { RegistryContext } from "@effect/atom-react";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@specweave-studio/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ThreadId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@specweave-studio/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "../../types";
import { toastManager } from "../ui/toast";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  providers: null as Atom.Atom<ReadonlyArray<ServerProvider>> | null,
  config: null as Atom.Atom<{ keybindings: ResolvedKeybindingsConfig }> | null,
  projects: [] as Project[],
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void> | AsyncResult.Failure<void, Error>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  confirm: vi.fn<() => Promise<boolean>>(),
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  updateClientSettings: vi.fn(),
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
  copy: vi.fn(),
  navigate: vi.fn(),
  machinesMounts: 0,
  machinesUnmounts: 0,
  machinesHold: false,
}));

vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@specweave-studio/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments }),
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock("~/state/entities", () => ({
  readProjects: () => state.projects,
  useProjects: () => state.projects,
  useThreadShells: () => [],
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { update: "update", delete: "delete" },
}));
vi.mock("~/state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => state.providers!,
    configValueAtom: () => state.config!,
    updateSettings: "updateSettings",
    upsertKeybinding: "upsertKeybinding",
    removeKeybinding: "removeKeybinding",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (
    command: "update" | "delete" | "updateSettings" | "upsertKeybinding" | "removeKeybinding",
  ) => state[command],
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => state.updateClientSettings,
  usePrimarySettings: () => DEFAULT_SERVER_SETTINGS,
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
}));
vi.mock("~/hooks/useStudioProjectFileScripts", () => ({
  useStudioProjectFileState: () => ({
    status: "valid",
    file: null,
    scripts: [{ name: "Imported", command: "vp test" }],
  }),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: state.copy }),
}));
vi.mock("../studio/useProjectDeletionConfirmation", () => ({
  useProjectDeletionConfirmation: () => ({
    confirmDeletion: async (target: { title: string }) =>
      (await state.confirm()) ? target.title : null,
    deletionDialog: null,
  }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: () => null,
      clearProjectDraftThreadId: state.clearDraft,
    }),
  },
}));
vi.mock("~/lib/composerDraftUploads", () => ({ releaseProjectDraftUploads: state.releaseUploads }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useLocation: () => "/settings/projects",
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("./ProjectOverrides", () => ({ ProjectOverrides: () => null }));
vi.mock("../studio/ProjectMachinesSettings", async () => {
  const { useEffect } = await import("react");
  const { useHoldProjectKeyFollow } = await import("./projectKeyFollow");
  return {
    ProjectMachinesSettings: () => {
      useHoldProjectKeyFollow(state.machinesHold);
      useEffect(() => {
        state.machinesMounts += 1;
        return () => {
          state.machinesUnmounts += 1;
        };
      }, []);
      return null;
    },
  };
});
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/switch", () => ({ Switch: "input" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "button",
  SelectValue: "span",
}));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuGroup: "div",
  MenuGroupLabel: "div",
  MenuItem: "button",
  MenuPopup: "div",
  MenuSeparator: "hr",
  MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "div",
  TooltipPopup: "span",
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsPageContainer: "div",
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ control, resetAction }: { control?: ReactNode; resetAction?: ReactNode }) => (
    <div>
      {resetAction}
      {control}
    </div>
  ),
  SettingResetButton: ({
    label,
    ...props
  }: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }) => <button {...props} aria-label={`Reset ${label} to default`} />,
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./ProjectActionsSettings", () => ({ ProjectActionsSettings: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: "model-picker" }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: "traits-picker" }));
vi.mock("./ProjectFaviconPickerDialog", () => ({
  canPickExternalProjectFavicon: () => false,
  ProjectFaviconPickerDialog: "favicon-picker",
}));
vi.mock("./ProjectIconPicker", () => ({
  ProjectIconPicker: "icon-picker",
  useLatestIconSave: (save: unknown) => save,
}));
vi.mock("../projectScriptEditor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectScriptEditor")>()),
  ProjectScriptEditorDialog: "script-editor",
}));

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: { keybindings: DEFAULT_RESOLVED_KEYBINDINGS },
}));
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "studio_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.machinesMounts = 0;
  state.machinesUnmounts = 0;
  state.machinesHold = false;
  state.registry = AtomRegistry.make();
  state.sessions.clear();
  for (const id of [primaryId, remoteId])
    state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
  for (const environment of environments) environment.connection.phase = "connected";
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  state.config = Atom.make({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS });
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  vi.unstubAllGlobals();
});

function group() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
}

async function mountPanel(environmentId: EnvironmentId | null = null) {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <ProjectSettingsPanel projectKey={group().projectKey} environmentId={environmentId} />
      </RegistryContext.Provider>,
    );
  });
  return renderer!.root;
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
}

async function grant(id: EnvironmentId, result: SessionResult) {
  await act(() => state.registry!.set(state.sessions.get(id)!, result));
}

describe("project settings selection", () => {
  it("follows the projects to their new key when a link gives them a shared identity", async () => {
    const before = group();
    await mountPanel();
    expect(state.machinesMounts).toBe(1);
    const logicalProject = {
      id: "logical:shared",
      title: "Shared repo",
      coordinatorId: "coordinator:logical:shared",
      members: state.projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId: `project-coordinator:${project.id}`,
      })),
    };
    state.projects = state.projects.map((project) => ({
      ...project,
      workspaceSettings: { ...project.workspaceSettings, logicalProject },
    })) as unknown as typeof state.projects;
    const after = group();
    expect(after.projectKey).not.toBe(before.projectKey);
    await act(() =>
      renderer!.update(
        <RegistryContext.Provider value={state.registry!}>
          <ProjectSettingsPanel projectKey={before.projectKey} environmentId={null} />
        </RegistryContext.Provider>,
      ),
    );
    expect(
      renderer!.root.findAll((node) =>
        node.children.includes("This project is no longer available."),
      ),
    ).toHaveLength(0);
    expect(state.machinesUnmounts).toBe(0);
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
    const search = state.navigate.mock.calls.at(-1)![0].search();
    expect(search.project).toBe(after.projectKey);
  });

  it("keeps the address until an open link dialog releases the page", async () => {
    const before = group();
    state.machinesHold = true;
    await mountPanel();
    const logicalProject = {
      id: "logical:shared",
      title: "Shared repo",
      coordinatorId: "coordinator:logical:shared",
      members: state.projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId: `project-coordinator:${project.id}`,
      })),
    };
    state.projects = state.projects.map((project) => ({
      ...project,
      workspaceSettings: { ...project.workspaceSettings, logicalProject },
    })) as unknown as typeof state.projects;
    const after = group();
    const render = () =>
      act(() =>
        renderer!.update(
          <RegistryContext.Provider value={state.registry!}>
            <ProjectSettingsPanel projectKey={before.projectKey} environmentId={null} />
          </RegistryContext.Provider>,
        ),
      );
    state.navigate.mockClear();
    await render();
    await render();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.machinesUnmounts).toBe(0);
    state.machinesHold = false;
    await render();
    expect(state.navigate.mock.calls.at(-1)![0].search().project).toBe(after.projectKey);
  });
});

describe("project settings permissions", () => {
  it("preflights every member before any shared field update", async () => {
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    const root = await mountPanel();
    const name = root.findByProps({ "aria-label": "Project name" });

    await act(async () => {
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "Renamed" } });
      root.findByType(ProjectFaviconPickerDialog).props.onSelect("/work/icon.png");
    });

    expect(state.update).not.toHaveBeenCalled();
    expect(state.projects.every((project) => project.title === "Shared repo")).toBe(true);
    expect(name.props.disabled).toBe(true);
    expect(button("Remove all entries").props.disabled).toBe(true);
  });

  it("updates every member when all have project access without settings access", async () => {
    const root = await mountPanel();
    await act(async () => {
      const name = root.findByProps({ "aria-label": "Project name" });
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "Renamed" } });
    });
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(state.projects.map((project) => project.title)).toEqual(["Renamed", "Renamed"]);
  });

  it("stops before the next member if its grant is revoked during an earlier update", async () => {
    const firstUpdate = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(firstUpdate.promise);
    const root = await mountPanel();
    await act(async () => {
      const name = root.findByProps({ "aria-label": "Project name" });
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "Renamed" } });
    });
    expect(state.update).toHaveBeenCalledOnce();

    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      firstUpdate.resolve(AsyncResult.success(undefined));
      await firstUpdate.promise;
    });
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });

  it("disables removal for a checkout whose project grant is missing", async () => {
    await grant(remoteId, AsyncResult.success(session([])));
    const root = await mountPanel();
    const denied = root.findByProps({ "aria-label": "Remove checkout /work/remote" });
    expect(denied.props.disabled).toBe(true);
    await act(async () => denied.props.onClick());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    expect(root.findByProps({ "aria-label": "Remove checkout /work/primary" }).props.disabled).toBe(
      false,
    );
  });

  it("allows removing a writable checkout while denying removal of the mixed group", async () => {
    await grant(remoteId, AsyncResult.success(session([])));
    await mountPanel();
    await act(async () => button("Remove all entries").props.onClick());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "Remove checkout /work/primary" }).props.onClick(),
    );
    expect(state.delete).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: {
        projectId: state.projects[0]!.id,
        force: true,
        confirmationTitle: state.projects[0]!.title,
      },
    });
    expect(state.releaseUploads).toHaveBeenCalledOnce();
    expect(state.clearDraft).toHaveBeenCalledOnce();
  });

  it("rechecks every removal target after confirmation before deleting or clearing drafts", async () => {
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await mountPanel();
    await act(async () => button("Remove all entries").props.onClick());
    expect(state.confirm).toHaveBeenCalledOnce();
    await grant(remoteId, AsyncResult.success(session([])));
    await act(async () => {
      confirmed.resolve(true);
      await confirmed.promise;
    });
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });

  it("reacts to another member's revoked and restored grant and guards a stale handler", async () => {
    await grant(
      primaryId,
      AsyncResult.success(session([AuthOrchestrationOperateScope, AuthSettingsWriteScope])),
    );
    const root = await mountPanel();
    const name = () => root.findByProps({ "aria-label": "Project name" });
    const staleSave = name().props.onBlur;
    await act(async () => {
      state.registry!.set(state.sessions.get(remoteId)!, AsyncResult.success(session([])));
      name().props.onChange();
      staleSave({ currentTarget: { value: "Renamed" } });
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(name().props.disabled).toBe(true);

    await grant(remoteId, writable());
    expect(name().props.disabled).toBe(false);
    await act(async () => {
      name().props.onChange();
      name().props.onBlur({ currentTarget: { value: "Renamed" } });
    });
    expect(state.projects.map((project) => project.title)).toEqual(["Renamed", "Renamed"]);
  });

  it.each([
    ["loading", () => AsyncResult.initial<AuthSessionState, Error>(), false],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Disconnected"))),
      false,
    ],
    ["refreshing", () => AsyncResult.waiting(writable()), true],
  ] as const)(
    "uses the current grant while a member's session is %s",
    async (_state, result, allowed) => {
      await grant(remoteId, result());
      const root = await mountPanel();
      const name = root.findByProps({ "aria-label": "Project name" });
      expect(name.props.disabled).toBe(!allowed);
      await act(async () => {
        name.props.onChange();
        name.props.onBlur({ currentTarget: { value: "Renamed" } });
      });
      expect(state.update).toHaveBeenCalledTimes(allowed ? 2 : 0);
    },
  );
});

describe("logical project name ownership", () => {
  function bindEasyChamp() {
    const members = state.projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      coordinatorThreadId: ThreadId.make(`project-coordinator:${project.id}`),
    }));
    state.projects = state.projects.map((project, index) => ({
      ...project,
      title: index ? "EasyChamp handoff folder" : "Original EasyChamp folder",
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        logicalProject: {
          id: "easychamp",
          title: "EasyChamp",
          coordinatorId: "easychamp-coordinator",
          members,
        },
        coordinatorBinding: {
          epoch: index,
          state: index ? "active" : "transferred",
          ...(index ? { predecessor: members[0]! } : {}),
        },
      },
    }));
  }
  it("renames only the active owner from predecessor-scoped settings, without requiring predecessor write access", async () => {
    bindEasyChamp();
    await grant(primaryId, AsyncResult.success(session([])));
    const root = await mountPanel(primaryId);
    const name = root.findByProps({ "aria-label": "Project name" });
    expect(name.props.defaultValue).toBe("EasyChamp");
    expect(name.props.disabled).toBe(false);
    await act(async () => {
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "EasyChamp Sports" } });
    });
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        projectId: ProjectId.make("project-remote"),
        title: "EasyChamp Sports",
        workspaceSettings: { expectedRevision: 0 },
      },
    });
    expect(state.projects[0]?.title).toBe("Original EasyChamp folder");
  });
  it("rejects a stale rename handler after ownership moves, without writing either physical name", async () => {
    bindEasyChamp();
    const root = await mountPanel(primaryId);
    const name = root.findByProps({ "aria-label": "Project name" });
    state.projects = state.projects.map((project) => ({
      ...project,
      workspaceSettings: {
        ...project.workspaceSettings!,
        coordinatorBinding: {
          epoch: 2,
          state: project.environmentId === primaryId ? "active" : "transferred",
        },
      },
    }));
    await act(async () => {
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "EasyChamp Sports" } });
    });
    expect(state.update).not.toHaveBeenCalled();
    expect(state.projects.map((project) => project.title)).toEqual([
      "Original EasyChamp folder",
      "EasyChamp handoff folder",
    ]);
    expect(toastManager.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Coordinator ownership changed. Reopen project settings before renaming.",
      }),
    );
  });
  it("binds a rename to the owner's revision and surfaces rejection if handoff wins the race", async () => {
    bindEasyChamp();
    state.projects[1] = {
      ...state.projects[1]!,
      workspaceSettings: { ...state.projects[1]!.workspaceSettings!, revision: 7 },
    };
    state.update.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Project settings changed during handoff."))),
    );
    const root = await mountPanel(primaryId);
    const name = root.findByProps({ "aria-label": "Project name" });
    await act(async () => {
      name.props.onChange();
      name.props.onBlur({ currentTarget: { value: "EasyChamp Sports" } });
    });
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        projectId: ProjectId.make("project-remote"),
        title: "EasyChamp Sports",
        workspaceSettings: { expectedRevision: 7 },
      },
    });
    expect(state.projects.map((project) => project.title)).toEqual([
      "Original EasyChamp folder",
      "EasyChamp handoff folder",
    ]);
    expect(toastManager.add).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        description: "Project settings changed during handoff.",
      }),
    );
  });
  it.each(["offline", "unknown", "conflicting", "denied", "transferring"] as const)(
    "refuses a logical rename when the active owner is %s",
    async (condition) => {
      bindEasyChamp();
      if (condition === "offline") environments[1]!.connection.phase = "disconnected";
      if (condition === "unknown") state.projects = state.projects.slice(0, 1);
      if (condition === "conflicting")
        state.projects[0] = {
          ...state.projects[0]!,
          workspaceSettings: {
            ...state.projects[0]!.workspaceSettings!,
            coordinatorBinding: { epoch: 1, state: "active" },
          },
        };
      if (condition === "denied") await grant(remoteId, AsyncResult.success(session([])));
      if (condition === "transferring")
        state.projects[1] = {
          ...state.projects[1]!,
          workspaceSettings: {
            ...state.projects[1]!.workspaceSettings!,
            coordinatorBinding: { epoch: 1, state: "transferring" },
          },
        };
      const root = await mountPanel(primaryId);
      const name = root.findByProps({ "aria-label": "Project name" });
      expect(name.props.disabled).toBe(true);
      expect(root.findAllByProps({ role: "alert" }).length).toBeGreaterThan(0);
      // A stale blur callback must enforce the same admission as the disabled field.
      await act(async () => {
        name.props.onChange();
        name.props.onBlur({ currentTarget: { value: "Do not claim success" } });
      });
      expect(state.update).not.toHaveBeenCalled();
      expect(state.projects[0]?.title).toBe("Original EasyChamp folder");
    },
  );
});
