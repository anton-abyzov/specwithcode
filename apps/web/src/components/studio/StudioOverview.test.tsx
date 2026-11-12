// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  createDraft: vi.fn(async () => ({
    kind: "draft",
    draftId: "owned-new-draft",
    threadId: "owned-new-thread",
  })),
  setModel: vi.fn(),
  validateDraft: vi.fn(() => true),
  /** The worker project's coordinator, which routes its other threads to its page. */
  workerCoordinator: null as string | null,
  retryNow: vi.fn(async (_environmentId: string) => ({ _tag: "Success" })),
  refreshAtom: vi.fn(),
  workerArchived: false,
  /** The worker project is a personal assistant, and whether Settings shows Aide. */
  workerPersonal: false,
  aideEnabled: true,
  shells: [] as EnvironmentThreadShell[],
  projects: [
    { id: "project-local", environmentId: "host-local", title: "Local project" },
    { id: "project-worker", environmentId: "host-worker", title: "Worker project" },
  ],
  environments: [
    { environmentId: "host-local", label: "Main Mac", connection: { phase: "connected" } },
    { environmentId: "host-worker", label: "Worker Mac", connection: { phase: "connected" } },
  ],
  providers: [
    {
      instanceId: "native-worker",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "actual-model", isDefault: true, isLegacy: false }],
    },
  ],
}));
// Attention transport is isolated; root selection and aggregation remain real.
vi.mock("./WhatYouCanDo", () => ({ WhatYouCanDo: () => null }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { retryNow: "retry-now" } }));
vi.mock("~/state/shell", () => ({
  environmentShell: { stateAtom: (environmentId: string) => `shell:${environmentId}` },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.retryNow }));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  const { createContext } = await import("react");
  return { ...actual, RegistryContext: createContext({ refresh: state.refreshAtom }) };
});
vi.mock("../../studio/fleet", () => ({ projectRemoteAttentionAtom: {} }));
vi.mock("../../studio/useProjectAttention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/useProjectAttention")>();
  return {
    ...actual,
    useAttentionMembers: (
      projects: import("../../studio/useProjectAttention").AttentionProjectMember[],
    ) =>
      actual.expandAttentionProjects(projects).map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId:
          project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
        includeUserRoots: Boolean(project.workspaceSettings?.logicalProject),
        freshness:
          state.environments.find((host) => host.environmentId === project.environmentId)
            ?.connection.phase === "connected"
            ? ("live" as const)
            : ("offline" as const),
        remoteWorkers: [],
        remoteWorkersComplete: true,
      })),
  };
});
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    {
      projectKey: "local",
      displayName: "Local project",
      memberProjectRefs: [{ environmentId: "host-local", projectId: "project-local" }],
      memberProjects: [{ environmentId: "host-local", id: "project-local" }],
    },
    {
      projectKey: "worker",
      displayName: "Worker project",
      memberProjectRefs: [{ environmentId: "host-worker", projectId: "project-worker" }],
      memberProjects: [
        {
          environmentId: "host-worker",
          id: "project-worker",
          workspaceSettings: {
            coordinatorThreadId: state.workerCoordinator,
            archived: state.workerArchived,
            ...(state.workerPersonal ? { kind: "personal" } : {}),
          },
        },
      ],
    },
  ],
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => <span /> }));
// The real pieces, without the popup machinery: what the trigger, value and items are given shows up.
vi.mock("../ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const Chosen = createContext<{ value: string; choose: (value: string) => void }>({
    value: "",
    choose: () => {},
  });
  return {
    Select: (props: {
      children: ReactNode;
      value: string;
      onValueChange: (value: string) => void;
    }) => (
      <Chosen.Provider value={{ value: props.value, choose: props.onValueChange }}>
        {props.children}
      </Chosen.Provider>
    ),
    SelectTrigger: (props: {
      children: ReactNode;
      id?: string;
      className?: string;
      autoFocus?: boolean;
    }) => (
      <button
        type="button"
        role="combobox"
        id={props.id}
        className={props.className}
        autoFocus={props.autoFocus}
        data-value={useContext(Chosen).value}
      >
        {props.children}
      </button>
    ),
    SelectValue: (props: { children: (value: string) => ReactNode }) =>
      props.children(useContext(Chosen).value),
    SelectPopup: (props: { children: ReactNode }) => <div role="listbox">{props.children}</div>,
    SelectItem: (props: { children: ReactNode; value: string; label?: string }) => {
      const { choose } = useContext(Chosen);
      return (
        <div
          role="option"
          aria-selected="false"
          data-value={props.value}
          data-label={props.label}
          onClick={() => choose(props.value)}
        >
          {props.children}
        </div>
      );
    },
  };
});
vi.mock("../../hooks/useSettings", () => ({ useAideEnabled: () => state.aideEnabled }));
vi.mock("../../state/entities", () => ({
  useProjects: () =>
    state.workerPersonal
      ? state.projects.map((project) =>
          project.id === "project-worker"
            ? { ...project, workspaceSettings: { kind: "personal" } }
            : project,
        )
      : state.projects,
  useThreadShells: () => state.shells,
  useServerConfigs: () => new Map([["host-worker", { providers: state.providers }]]),
  useAllEnvironmentShellsBootstrapped: () => true,
}));
const NO_UNREACHABLE_ENVIRONMENTS: ReadonlySet<string> = new Set();
let environmentIdsCache: { readonly key: string; readonly ids: ReadonlyArray<string> } | null =
  null;
// One array per set of ids, as the real atom gives, so effects keyed on it do not re-run.
function mockedEnvironmentIds(): ReadonlyArray<string> {
  const ids = state.environments.map((environment) => environment.environmentId);
  const key = ids.join("\n");
  if (environmentIdsCache?.key !== key) environmentIdsCache = { key, ids };
  return environmentIdsCache.ids;
}
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.environments,
    isReady: true,
    networkStatus: "online",
  }),
  usePrimaryEnvironmentId: () => "host-local",
  useEnvironmentIds: () => mockedEnvironmentIds(),
  useUnreachableEnvironmentIds: () => NO_UNREACHABLE_ENVIRONMENTS,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(["host-local", "host-worker"]),
  // Increment progress needs file access; these sessions show their todo lists only.
  useEnvironmentScope: () => false,
  useEnvironmentScopeAccess: () => "denied",
}));
vi.mock("../../hooks/useNewChatDestination", () => ({
  useNewChatDestination: () => state.createDraft,
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setModelSelection: state.setModel }) },
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../branding", () => ({ APP_DISPLAY_NAME: "SpecWithCode" }));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    search: _search,
    children,
    ...props
  }: {
    to: string;
    params?: { environmentId?: string; threadId?: string; projectKey?: string };
    search?: unknown;
    children: React.ReactNode;
  }) => (
    <a
      href={
        params?.projectKey
          ? `/projects/${params.projectKey}`
          : params
            ? `/${params.environmentId}/${params.threadId}`
            : to
      }
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock("./CapacityFleet", () => ({
  CapacityFleet: ({
    onNewDraft,
  }: {
    onNewDraft: (
      env: string,
      model: { instanceId: string; model: string },
      validate?: () => boolean,
    ) => void;
  }) => (
    <>
      <button
        onClick={() =>
          onNewDraft("host-worker", { instanceId: "native-worker", model: "actual-model" })
        }
      >
        Choose verified worker profile
      </button>
      <button
        onClick={() =>
          onNewDraft(
            "host-worker",
            { instanceId: "native-worker", model: "actual-model" },
            state.validateDraft,
          )
        }
      >
        Choose policy draft
      </button>
    </>
  ),
}));

import { StudioOverview } from "./StudioOverview";
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.createDraft.mockClear();
  state.setModel.mockClear();
  state.validateDraft.mockReset();
  state.validateDraft.mockReturnValue(true);
  state.shells = [];
  state.workerCoordinator = null;
  state.workerArchived = false;
  state.workerPersonal = false;
  state.aideEnabled = true;
  state.createDraft.mockResolvedValue({
    kind: "draft",
    draftId: "owned-new-draft",
    threadId: "owned-new-thread",
  });
  state.environments[1]!.connection.phase = "connected";
  state.providers[0]!.installed = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function render() {
  await act(async () => root.render(<StudioOverview />));
}
async function click(text: string) {
  // A shortcut hint inside a button is not part of its name.
  const name = (b: HTMLButtonElement) => {
    const copy = b.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("kbd").forEach((kbd) => kbd.remove());
    return copy.textContent?.trim();
  };
  const button = [...container.querySelectorAll("button")].find((b) => name(b) === text.trim());
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function option(value: string) {
  return container.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
}
async function select(value: string) {
  expect(option(value)).not.toBeNull();
  await act(async () => option(value)!.click());
}
function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "host-worker",
    projectId: "project-worker",
    title: `Cached ${id}`,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceId: "native-worker",
    updatedAt: "2026-10-07T18:00:00Z",
    createdAt: "2026-10-07T18:00:00Z",
    settledOverride: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("deliberate native session entry", () => {
  it("keeps overview on mount, rerender and reload without creating a draft", async () => {
    await render();
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Nothing needs you");
    expect(state.createDraft).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(state.createDraft).not.toHaveBeenCalled();
  });
  it("does not claim partial observations for an empty workspace", async () => {
    const projects = state.projects;
    state.projects = [];
    state.shells = [];
    try {
      await render();
      expect(container.querySelector(".studio-stale-notice")).toBeNull();
      expect(container.querySelector("h1")?.textContent).toBe("Nothing needs you");
    } finally {
      state.projects = projects;
    }
  });
  it("keeps partial observations when an empty workspace has an offline host", async () => {
    const { projects, environments } = state;
    state.projects = [];
    state.shells = [];
    state.environments = [
      environments[0]!,
      { ...environments[1]!, connection: { phase: "disconnected" } },
    ];
    try {
      await render();
      // The notice names the machine that is behind and links to its connection.
      const notice = container.querySelector(".studio-stale-notice");
      expect(notice?.textContent).toContain("Worker Mac is offline");
      // Check connection retries the offline machine now instead of only opening settings.
      const check = [...(notice?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "Check connection",
      );
      await act(async () => check?.click());
      expect(state.retryNow).toHaveBeenCalledWith("host-worker");
      expect(state.refreshAtom).not.toHaveBeenCalled();
    } finally {
      state.projects = projects;
      state.environments = environments;
    }
  });
  it("renders actual title-shaped project, session and attention labels", async () => {
    state.shells = [shell("needs-review", { hasPendingApprovals: true })];
    await render();
    const projectNames = [...container.querySelectorAll(".studio-project .studio-row-title")].map(
      (node) => node.textContent,
    );
    expect(projectNames).toContain("Local project");
    expect(projectNames).toContain("Worker project");
    expect(container.querySelector(".studio-session-item")?.textContent).toContain(
      "Worker project",
    );
    expect(container.querySelector(".studio-attention-item")?.textContent).toContain(
      "Worker project",
    );
  });
  it("opens chooser from an explicit click and creates only the chosen scoped draft", async () => {
    await render();
    await click("New chat");
    expect(state.createDraft).not.toHaveBeenCalled();
    const field = container.querySelector<HTMLElement>("#studio-project")!;
    expect(field.getAttribute("role")).toBe("combobox");
    expect(container.querySelector('label[for="studio-project"]')?.textContent).toBe(
      "Project and machine",
    );
    expect(document.activeElement).toBe(field);
    expect(field.textContent).toBe("Choose a registered project…");
    expect(field.dataset.value).toBe("");
    const worker = option("host-worker:project-worker")!;
    expect(worker.querySelector(".studio-project-choice-title")?.textContent).toBe(
      "Worker project",
    );
    expect(worker.querySelector(".studio-project-choice-host")?.textContent).toBe("Worker Mac");
    // Typing matches the name and host, not the icon's letters run together with them.
    expect(worker.dataset.label).toBe("Worker project / Worker Mac");
    await select("host-worker:project-worker");
    expect(field.dataset.value).toBe("host-worker:project-worker");
    expect(field.querySelector(".studio-project-choice-title")?.textContent).toBe("Worker project");
    expect(field.querySelector(".studio-project-choice-host")?.textContent).toBe("Worker Mac");
    await click("Open native draft");
    expect(state.createDraft).toHaveBeenCalledTimes(1);
    expect(state.createDraft).toHaveBeenCalledWith(
      {
        environmentId: "host-worker",
        projectId: "project-worker",
      },
      {
        environmentSelection: "manual",
        model: undefined,
      },
    );
    expect(state.setModel).not.toHaveBeenCalled();
  });
  it("clears the choice when the chosen project is no longer offered", async () => {
    await render();
    await click("New chat");
    await select("host-worker:project-worker");
    const open = () =>
      [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Open native draft"),
      )!;
    expect(open().disabled).toBe(false);
    const environments = state.environments;
    try {
      // A new list, as the store hands over when a host drops.
      state.environments = environments.map((environment) =>
        environment.environmentId === "host-worker"
          ? { ...environment, connection: { phase: "disconnected" } }
          : environment,
      );
      await render();
      const field = container.querySelector<HTMLElement>("#studio-project")!;
      expect(option("host-worker:project-worker")).toBeNull();
      expect(field.textContent).toBe("Choose a registered project…");
      expect(field.dataset.value).toBe("");
      expect(open().disabled).toBe(true);
      await act(async () => open().click());
      expect(state.createDraft).not.toHaveBeenCalled();
    } finally {
      state.environments = environments;
    }
  });
  it("applies a configured native model only to the returned owned new draft", async () => {
    await render();
    await click("Choose verified worker profile");
    await select("host-worker:project-worker");
    await click("Open native draft");
    expect(state.createDraft).toHaveBeenCalledWith(
      {
        environmentId: "host-worker",
        projectId: "project-worker",
      },
      {
        environmentSelection: "manual",
        model: { instanceId: "native-worker", model: "actual-model" },
      },
    );
    expect(state.setModel).toHaveBeenCalledWith(
      "owned-new-draft",
      { instanceId: "native-worker", model: "actual-model" },
      { explicit: true },
    );
  });
  it("pins a valid policy-selected host before applying its native model", async () => {
    await render();
    await click("Choose policy draft");
    await select("host-worker:project-worker");
    await click("Open native draft");
    expect(state.validateDraft).toHaveBeenCalled();
    expect(state.createDraft).toHaveBeenCalledWith(
      {
        environmentId: "host-worker",
        projectId: "project-worker",
      },
      {
        environmentSelection: "manual",
        model: { instanceId: "native-worker", model: "actual-model" },
      },
    );
    expect(state.createDraft.mock.invocationCallOrder[0]).toBeLessThan(
      state.setModel.mock.invocationCallOrder[0]!,
    );
  });
  it("hands a workers-only copy to the coordinator handoff, which names the copy", async () => {
    const projects = state.projects;
    const domain = { id: "one", title: "Atlas", coordinatorId: "c", members: [] };
    // "Copy files only" left the worker's copy transferred to the main Mac's coordinator.
    state.projects = [
      {
        ...projects[0]!,
        workspaceSettings: {
          logicalProject: domain,
          coordinatorBinding: { epoch: 1, state: "active" },
        },
      },
      {
        ...projects[1]!,
        workspaceSettings: {
          logicalProject: domain,
          coordinatorBinding: {
            epoch: 1,
            state: "transferred",
            successor: {
              environmentId: "host-local",
              projectId: "project-local",
              coordinatorThreadId: "project-coordinator:project-local",
            },
          },
        },
      },
    ] as unknown as typeof projects;
    try {
      await render();
      await click("Choose verified worker profile");
      await select("host-worker:project-worker");
      await click("Open native draft");
      // The handoff opens the coordinator and names this copy; the model stays for a
      // standalone draft on the worker's own machine.
      expect(state.createDraft).toHaveBeenCalledWith(
        { environmentId: "host-worker", projectId: "project-worker" },
        {
          environmentSelection: "manual",
          model: { instanceId: "native-worker", model: "actual-model" },
        },
      );
    } finally {
      state.projects = projects;
    }
  });
  it("rejects an instance that became unavailable before the click", async () => {
    await render();
    await click("Choose verified worker profile");
    state.providers[0]!.installed = false;
    await render();
    await select("host-worker:project-worker");
    await click("Open native draft");
    expect(state.createDraft).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be opened");
  });
  it("rechecks the selected capacity policy before opening its chosen project draft", async () => {
    await render();
    await click("Choose policy draft");
    await select("host-worker:project-worker");
    state.validateDraft.mockReturnValue(false);
    await click("Open native draft");
    expect(state.validateDraft).toHaveBeenCalled();
    expect(state.createDraft).not.toHaveBeenCalled();
    expect(state.setModel).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("no longer available");
  });
  it("keeps a disconnected worker out of new-session choices", async () => {
    state.environments[1]!.connection.phase = "offline";
    await render();
    await click("Choose verified worker profile");
    expect(container.textContent).toContain("No connected project is available");
    expect(state.createDraft).not.toHaveBeenCalled();
  });
  it("retains disconnected cached sessions without reporting current work or attention", async () => {
    state.shells = [
      // Active just now, so the run reads as working rather than stalled.
      shell("working", {
        runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
        updatedAt: new Date().toISOString(),
      }),
      shell("approval", { hasPendingApprovals: true }),
    ];
    const setWorkerConnection = (phase: string) => {
      state.environments = state.environments.map((environment) =>
        environment.environmentId === "host-worker"
          ? { ...environment, connection: { phase } }
          : environment,
      );
    };
    const heading = () => container.querySelector("h1")?.textContent;
    const summary = () => container.querySelector(".studio-intro")?.textContent;

    setWorkerConnection("offline");
    await render();
    expect(summary()).toContain("None working");
    expect(heading()).toBe("Nothing needs you");
    expect(container.textContent).toContain("Disconnected · Last observed: Working");
    expect(container.textContent).toContain("Disconnected · Last observed: Approval requested");
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(2);
    expect(container.querySelector('a[href="/host-worker/approval"]')).not.toBeNull();
    expect(
      container.querySelectorAll(".studio-session-item .studio-state-dot:is(.moss, .amber, .red)"),
    ).toHaveLength(0);
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(0);

    setWorkerConnection("connected");
    await render();
    // The running chat that also asks for approval is listed under Needs you, not Working.
    expect(summary()).toContain("1 working");
    expect(heading()).toBe("1 chat needs you");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    expect(container.textContent).not.toContain("Disconnected · Last observed:");
    expect(state.createDraft).not.toHaveBeenCalled();
  });
  it("leaves out the threads and sessions of archived projects, as the sidebar does", async () => {
    state.shells = [
      shell("archived-ask", { hasPendingApprovals: true }),
      shell("local-ask", {
        environmentId: "host-local" as EnvironmentThreadShell["environmentId"],
        projectId: "project-local" as EnvironmentThreadShell["projectId"],
        hasPendingApprovals: true,
      }),
    ];
    state.workerArchived = true;
    await render();
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(1);
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    expect(container.textContent).toContain("Cached local-ask");
    expect(container.textContent).not.toContain("Cached archived-ask");
    expect(container.textContent).not.toContain("Worker project");

    state.workerArchived = false;
    await render();
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(2);
  });
  it("leaves out a hidden personal assistant, its chats and its draft choice", async () => {
    state.shells = [
      shell("aide-ask", { hasPendingApprovals: true }),
      shell("local-ask", {
        environmentId: "host-local" as EnvironmentThreadShell["environmentId"],
        projectId: "project-local" as EnvironmentThreadShell["projectId"],
        hasPendingApprovals: true,
      }),
    ];
    state.workerPersonal = true;
    state.aideEnabled = false;
    await render();
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(1);
    expect(container.textContent).toContain("Cached local-ask");
    expect(container.textContent).not.toContain("Cached aide-ask");
    expect(container.textContent).not.toContain("Worker project");
    await click("New chat");
    expect(option("host-local:project-local")).not.toBeNull();
    expect(option("host-worker:project-worker")).toBeNull();

    // Turned back on, the same assistant and its chat return: nothing was deleted.
    state.aideEnabled = true;
    await render();
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(2);
    expect(container.textContent).toContain("Worker project");
  });
  it("advances the displayed session age without new session observations or work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T18:00:00Z"));
    state.shells = [shell("saved")];
    const savedShells = state.shells;
    await render();
    expect(container.querySelector(".studio-row-age")?.textContent).toBe("Just now");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(container.querySelector(".studio-row-age")?.textContent).toBe("1m ago");
    expect(state.shells).toBe(savedShells);
    expect(state.createDraft).not.toHaveBeenCalled();
    expect(state.setModel).not.toHaveBeenCalled();
  });
  it("lists recent chats without repeating the ones that need you, and shows more on request", async () => {
    state.shells = [
      ...Array.from({ length: 25 }, (_, index) =>
        shell(`ready-${index}`, {
          updatedAt: `2026-10-07T17:${String(10 + index).padStart(2, "0")}:00Z`,
        }),
      ),
      shell("blocked", { hasPendingApprovals: true }),
      shell("finished", { settledOverride: "settled" } as Partial<EnvironmentThreadShell>),
    ];
    await render();
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    const recent = () =>
      [...container.querySelectorAll('[role="tabpanel"] .studio-session-item')].map((row) =>
        row.getAttribute("href"),
      );
    expect(recent()).toHaveLength(20);
    expect(recent()).not.toContain("/host-worker/blocked");
    await click("Show 5 more20 of 25");
    expect(recent()).toHaveLength(25);
    const done = container.querySelector<HTMLButtonElement>("#studio-recent-tab-done")!;
    expect(done.textContent).toBe("Done1");
    await act(async () => done.click());
    expect(recent()).toEqual(["/host-worker/finished"]);
  });
  it("filters recent chats by name", async () => {
    state.shells = [shell("alpha", { title: "Fix login" }), shell("beta", { title: "Ship docs" })];
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "login");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(1);
    expect(container.querySelector(".studio-session-item")?.textContent).toContain("Fix login");
  });
  it("groups Needs you by what each chat needs, the most blocking first", async () => {
    state.shells = [
      shell("plan", { hasActionableProposedPlan: true, updatedAt: "2026-10-07T17:59:00Z" }),
      shell("approval", { hasPendingApprovals: true, updatedAt: "2026-10-06T17:00:00Z" }),
    ];
    await render();
    const groups = [...container.querySelectorAll(".studio-attention .studio-group-label")].map(
      (label) => label.textContent,
    );
    expect(groups).toEqual(["Approval requested · 1", "Plan ready to review · 1"]);
  });
  it("shows eight chats that need you, then the rest on request", async () => {
    state.shells = Array.from({ length: 11 }, (_, index) =>
      shell(`ask-${index}`, { hasPendingApprovals: true }),
    );
    await render();
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(8);
    await click("Show 3 more");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(11);
    await click("Show fewer");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(8);
  });
  it("narrows every list to a machine, and back", async () => {
    state.shells = [
      shell("worker-ask", { hasPendingApprovals: true }),
      shell("local-ask", {
        environmentId: "host-local" as EnvironmentThreadShell["environmentId"],
        projectId: "project-local" as EnvironmentThreadShell["projectId"],
        hasPendingApprovals: true,
      }),
    ];
    await render();
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(2);
    const machine = [
      ...container.querySelectorAll<HTMLButtonElement>(".studio-machine button"),
    ].find((button) => button.textContent?.startsWith("Worker Mac"))!;
    expect(machine.getAttribute("aria-pressed")).toBe("false");
    await act(async () => machine.click());
    expect(machine.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    expect(container.querySelector(".studio-attention-item")?.getAttribute("href")).toBe(
      "/host-worker/worker-ask",
    );
    expect(container.querySelector(".studio-scope")?.textContent).toContain(
      "Showing chats on Worker Mac",
    );
    // The rail keeps only that machine's projects.
    expect(
      [...container.querySelectorAll(".studio-project .studio-row-title")].map(
        (n) => n.textContent,
      ),
    ).toEqual(["Worker project"]);
    await click("Show all");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(2);
  });
  it("filters Needs you to a project from its count", async () => {
    state.shells = [
      shell("worker-ask", { hasPendingApprovals: true }),
      shell("local-ask", {
        environmentId: "host-local" as EnvironmentThreadShell["environmentId"],
        projectId: "project-local" as EnvironmentThreadShell["projectId"],
        hasPendingApprovals: true,
      }),
    ];
    await render();
    const count = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show only chats that need you in Local project"]',
    )!;
    await act(async () => count.click());
    expect(count.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    expect(container.querySelector(".studio-scope")?.textContent).toContain(
      "Showing chats in Local project",
    );
  });
  it("walks chat rows with J and K and starts a chat with N", async () => {
    state.shells = [shell("one", { hasPendingApprovals: true }), shell("two")];
    await render();
    const press = (key: string, target: EventTarget = document.body) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    const rows = [...container.querySelectorAll<HTMLElement>("[data-overview-row]")];
    expect(rows).toHaveLength(2);
    await press("j");
    expect(document.activeElement).toBe(rows[0]);
    await press("j", rows[0]);
    expect(document.activeElement).toBe(rows[1]);
    await press("k", rows[1]);
    expect(document.activeElement).toBe(rows[0]);
    // Typing in the filter never moves the selection.
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.focus();
    await press("j", input);
    expect(document.activeElement).toBe(input);
    rows[0]!.focus();
    await press("/", rows[0]);
    expect(document.activeElement).toBe(input);
    rows[0]!.focus();
    await press("n", rows[0]);
    const picker = container.querySelector<HTMLElement>("#studio-project")!;
    expect(picker).not.toBeNull();
    expect(state.createDraft).not.toHaveBeenCalled();
    // The chooser's project field keeps typed letters for its own search.
    picker.focus();
    await press("j", picker);
    await press("n", picker);
    expect(document.activeElement).toBe(picker);
  });
  it("moves between Open and Done with the arrow keys", async () => {
    await render();
    const open = container.querySelector<HTMLButtonElement>("#studio-recent-tab-open")!;
    expect(open.tabIndex).toBe(0);
    await act(async () => {
      open.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const done = container.querySelector<HTMLButtonElement>("#studio-recent-tab-done")!;
    expect(done.getAttribute("aria-selected")).toBe("true");
    expect(done.tabIndex).toBe(0);
    expect(document.activeElement).toBe(done);
  });
  it("orders project cards by what needs attention and links each to its workspace", async () => {
    state.shells = [shell("needs-review", { hasPendingApprovals: true })];
    await render();
    const cards = [...container.querySelectorAll(".studio-project")];
    expect(cards.map((card) => card.querySelector(".studio-row-title")?.textContent)).toEqual([
      "Worker project",
      "Local project",
    ]);
    expect(cards[0]?.classList.contains("needs-you")).toBe(true);
    expect(cards[0]?.querySelector('a[href="/projects/worker"]')).not.toBeNull();
  });
  it("opens a project's thread in the project's right panel, as the sidebar does", async () => {
    state.shells = [
      shell("worker-thread", { createdBy: "agent", hasPendingApprovals: true }),
      shell("coordinator"),
      shell("loose", { environmentId: "host-local", projectId: "elsewhere" } as never),
    ];
    state.workerCoordinator = "coordinator";
    await render();
    const href = (title: string) =>
      [...container.querySelectorAll("a")]
        .filter((a) => a.textContent?.includes(title))
        .map((a) => a.getAttribute("href"));
    expect(href("Cached worker-thread")).toEqual(["/projects/worker"]);
    expect(href("Cached coordinator")).toEqual(["/projects/worker"]);
    expect(href("Cached loose")).toEqual(["/host-local/loose"]);
  });
  it("keeps real project, provider and connection destinations", async () => {
    await render();
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/settings/projects");
    expect(links).toContain("/settings/connections");
    expect(links).toContain("/projects/worker");
  });
});

it("opens a modern project coordinator with the chosen native model and no false draft failure", async () => {
  state.createDraft.mockResolvedValueOnce({ kind: "coordinator", threadId: "retained" } as any);
  await render();
  await click("Choose verified worker profile");
  await select("host-worker:project-worker");
  await click("Open native draft");
  expect(state.createDraft).toHaveBeenCalledWith(
    { environmentId: "host-worker", projectId: "project-worker" },
    {
      environmentSelection: "manual",
      model: { instanceId: "native-worker", model: "actual-model" },
    },
  );
  expect(state.setModel).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
