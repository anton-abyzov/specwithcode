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
          workspaceSettings: { coordinatorThreadId: state.workerCoordinator },
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
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShells: () => state.shells,
  useServerConfigs: () => new Map([["host-worker", { providers: state.providers }]]),
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.environments,
    isReady: true,
    networkStatus: "online",
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(["host-local", "host-worker"]),
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
    search,
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
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text.trim(),
  );
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
    expect(container.querySelector("h1")?.textContent).toContain("Control desk");
    expect(state.createDraft).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(state.createDraft).not.toHaveBeenCalled();
  });
  it("renders actual title-shaped project, session and attention labels", async () => {
    state.shells = [shell("needs-review", { hasPendingApprovals: true })];
    await render();
    expect([...container.querySelectorAll("h3")].map((node) => node.textContent)).toContain(
      "Local project",
    );
    expect([...container.querySelectorAll("h3")].map((node) => node.textContent)).toContain(
      "Worker project",
    );
    expect(container.querySelector(".studio-session-item")?.textContent).toContain(
      "Worker project",
    );
    expect(container.querySelector(".studio-attention-item")?.textContent).toContain(
      "Worker project",
    );
  });
  it("opens chooser from an explicit click and creates only the chosen scoped draft", async () => {
    await render();
    await click(" New session");
    expect(state.createDraft).not.toHaveBeenCalled();
    const field = container.querySelector<HTMLElement>("#studio-project")!;
    expect(field.getAttribute("role")).toBe("combobox");
    expect(container.querySelector('label[for="studio-project"]')?.textContent).toBe(
      "Project and host",
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
    await click(" New session");
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
      shell("working", { runtime: { status: "running" } as EnvironmentThreadShell["runtime"] }),
      shell("approval", { hasPendingApprovals: true }),
    ];
    const setWorkerConnection = (phase: string) => {
      state.environments = state.environments.map((environment) =>
        environment.environmentId === "host-worker"
          ? { ...environment, connection: { phase } }
          : environment,
      );
    };
    const count = (label: string) =>
      [...container.querySelectorAll(".studio-stat")]
        .find((stat) => stat.querySelector("span")?.textContent === label)
        ?.querySelector("strong")?.textContent;

    setWorkerConnection("offline");
    await render();
    expect(count("Sessions working")).toBe("0");
    expect(count("Need attention")).toBe("0");
    expect(container.textContent).toContain("Disconnected · Last observed: Working");
    expect(container.textContent).toContain("Disconnected · Last observed: Approval requested");
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(2);
    expect(container.querySelector('a[href="/host-worker/approval"]')).not.toBeNull();
    expect(
      container.querySelectorAll(".studio-state-dot.working, .studio-state-dot.attention"),
    ).toHaveLength(0);
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(0);

    setWorkerConnection("connected");
    await render();
    expect(count("Sessions working")).toBe("1");
    expect(count("Need attention")).toBe("1");
    expect(container.querySelectorAll(".studio-attention-item")).toHaveLength(1);
    expect(container.textContent).not.toContain("Disconnected · Last observed:");
    expect(state.createDraft).not.toHaveBeenCalled();
  });
  it("advances the displayed session age without new session observations or work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T18:00:00Z"));
    state.shells = [shell("saved")];
    const savedShells = state.shells;
    await render();
    expect(container.querySelector(".studio-session-state time")?.textContent).toBe("Just now");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(container.querySelector(".studio-session-state time")?.textContent).toBe("1m ago");
    expect(state.shells).toBe(savedShells);
    expect(state.createDraft).not.toHaveBeenCalled();
    expect(state.setModel).not.toHaveBeenCalled();
  });
  it("pages long session lists and filters to the sessions that need a decision", async () => {
    state.shells = [
      ...Array.from({ length: 10 }, (_, index) =>
        shell(`ready-${index}`, { updatedAt: `2026-10-07T17:${String(10 + index)}:00Z` }),
      ),
      shell("blocked", { hasPendingApprovals: true }),
    ];
    await render();
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(8);
    expect(container.querySelector('nav[aria-label="Session pages"]')?.textContent).toContain(
      "1–8 of 11",
    );
    const next = container.querySelector<HTMLButtonElement>(
      'nav[aria-label="Session pages"] button[aria-label="Next page"]',
    )!;
    await act(async () => next.click());
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(3);
    const needsYou = [...container.querySelectorAll<HTMLButtonElement>(".studio-filter")].find(
      (button) => button.textContent?.startsWith("Needs you"),
    )!;
    await act(async () => needsYou.click());
    expect(container.querySelectorAll(".studio-session-item")).toHaveLength(1);
    expect(container.querySelector(".studio-session-item")?.getAttribute("href")).toBe(
      "/host-worker/blocked",
    );
    expect(container.querySelector('nav[aria-label="Session pages"]')).toBeNull();
  });
  it("orders project cards by what needs attention and links each to its workspace", async () => {
    state.shells = [shell("needs-review", { hasPendingApprovals: true })];
    await render();
    const cards = [...container.querySelectorAll(".studio-project")];
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
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
    expect(href("Cached worker-thread")).toEqual(["/projects/worker", "/projects/worker"]);
    expect(href("Cached coordinator")).toEqual(["/projects/worker"]);
    expect(href("Cached loose")).toEqual(["/host-local/loose"]);
  });
  it("keeps real project, provider and connection destinations", async () => {
    await render();
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("/settings/projects");
    expect(links).toContain("/settings/providers");
    expect(links).toContain("/settings/connections");
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
