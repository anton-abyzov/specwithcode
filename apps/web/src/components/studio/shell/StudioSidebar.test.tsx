// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { buildSidebarProjectSnapshots } from "../../../sidebarProjectGrouping";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  start: vi.fn(async () => true),
  settle: vi.fn(),
  pathname: "/",
  params: {} as Record<string, string>,
  search: {} as Record<string, string>,
  shells: [] as EnvironmentThreadShell[],
  keybindings: [] as unknown[],
  primaryEnvironmentId: "host" as string | null,
  savedMachines: {} as Record<string, string>,
  scratchRoots: new Map<string, { scratchWorkspaceRoot: string }>(),
  updateProject: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: undefined })),
  groups: [] as Array<{
    projectKey: string;
    displayName: string;
    workspaceRoot?: string;
    memberProjects: Array<{
      environmentId: string;
      id: string;
      title?: string;
      workspaceRoot?: string;
      workspaceSettings?:
        | {
            kind: "code" | "personal";
            coordinatorThreadId?: string | null;
            archived?: boolean;
            revision?: number;
          }
        | undefined;
    }>;
  }>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.keybindings }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: React.PropsWithChildren<{
    to: string;
    params?: { projectKey: string };
    search?: Record<string, string>;
  }>) => (
    <a
      href={params ? `/projects/${params.projectKey}` : to}
      data-route-search={search ? JSON.stringify(search) : undefined}
      {...rest}
    >
      {children}
    </a>
  ),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: state.pathname }),
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(state.params),
  useSearch: ({ select }: { select: (search: Record<string, string>) => unknown }) =>
    select(state.search),
  useRouter: () => ({ navigate: state.navigate }),
  useNavigate: () => state.navigate,
}));
vi.mock("../../../env", () => ({ isElectron: false }));
vi.mock("../../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../../state/entities", () => ({
  useThreadShells: () => state.shells,
  readThreadShell: (ref: { environmentId: string; threadId: string }) =>
    state.shells.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  useServerConfigs: () => state.scratchRoots,
}));
vi.mock("../../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => state.updateProject,
}));
vi.mock("../../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId,
}));
vi.mock("../../../hooks/useSettings", () => ({
  useClientSettings: <T,>(
    select: (settings: { projectCoordinatorMachines: Record<string, string> }) => T,
  ) => select({ projectCoordinatorMachines: state.savedMachines }),
}));
vi.mock("../../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: (environmentId: string | null) => environmentId,
    startScratchThread: state.start,
  }),
}));
vi.mock("../../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: state.settle,
    unsettleThread: state.settle,
    archiveThread: state.settle,
  }),
}));
vi.mock("../../../lib/chatThreadActions", () => ({ startNewThreadFromContext: state.start }));
vi.mock("../../../threadRoutes", () => ({
  buildThreadRouteParams: (ref: { environmentId: string; threadId: string }) => ref,
  resolveThreadRouteTarget: (params: Record<string, string>) =>
    params.draftId
      ? { kind: "draft", draftId: params.draftId }
      : params.threadId
        ? {
            kind: "server",
            threadRef: { environmentId: params.environmentId, threadId: params.threadId },
          }
        : null,
}));
vi.mock("../../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => state.groups,
}));
vi.mock("../../sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock("../../ui/sidebar", () => ({
  SidebarContent: ({ children, ...rest }: React.PropsWithChildren) => (
    <div {...rest}>{children}</div>
  ),
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../../ProjectFavicon", () => ({
  ProjectFavicon: ({ project }: { project: EnvironmentProject }) => (
    <i
      data-project-title={project.title}
      data-project-environment={project.environmentId}
      data-project-root={project.workspaceRoot}
    />
  ),
}));
vi.mock("./ModelBadge", () => ({
  ModelBadgeMark: ({ provider }: { provider: string }) => <i data-mark={provider} />,
  useProviderEntriesByEnvironment: () => new Map(),
}));
import { DEFAULT_CHAT_LIST_OPTIONS } from "../../../studio/shellModel";
import StudioSidebar from "./StudioSidebar";

let root: Root, container: HTMLDivElement;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
function shell(
  id: string,
  overrides: Partial<Omit<EnvironmentThreadShell, "id">> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "host",
    projectId: "p1",
    title: `Chat ${id}`,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    createdAt: iso(40),
    updatedAt: iso(0),
    modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
    ...overrides,
  } as EnvironmentThreadShell;
}
const headings = () =>
  [...container.querySelectorAll(".sws-side-subheading button")].map((b) => b.textContent);
const chats = () =>
  [...container.querySelectorAll(".sws-chat-row .sws-side-row-label")].map((b) => b.textContent);
async function render() {
  await act(async () => root.render(<StudioSidebar />));
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.navigate.mockReset();
  state.start.mockClear();
  state.pathname = "/";
  state.params = {};
  state.search = {};
  state.keybindings = [];
  state.primaryEnvironmentId = "host";
  state.savedMachines = {};
  state.scratchRoots = new Map();
  state.updateProject.mockClear();
  state.groups = [
    {
      projectKey: "host:/a",
      displayName: "Atlas",
      memberProjects: [{ environmentId: "host", id: "p1" }],
    },
    {
      projectKey: "host:/b",
      displayName: "Borealis",
      memberProjects: [{ environmentId: "host", id: "p2" }],
    },
  ];
  state.shells = [
    shell("today"),
    shell("ask", {
      hasPendingUserInput: true,
      projectId: "p2" as EnvironmentThreadShell["projectId"],
    }),
    shell("old", { updatedAt: iso(45) }),
    shell("done", { settledOverride: "settled" }),
    shell("project-coordinator:p1"),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("projects and chats sidebar", () => {
  it("lists projects, marks the open one and counts what waits on the person", async () => {
    state.params = { projectKey: "host:/b" };
    state.shells = state.shells.map((thread) =>
      thread.id === "ask" ? { ...thread, createdBy: "agent" } : thread,
    );
    await render();
    const rows = [...container.querySelectorAll('a[href^="/projects/"]')];
    expect(rows.map((row) => row.querySelector(".sws-side-row-label")?.textContent)).toEqual([
      "Atlas",
      "Borealis",
    ]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([null, "page"]);
    expect(rows[1]!.querySelector(".sws-count")?.textContent).toBe("1 waiting on you");
    expect(rows[0]!.querySelector(".sws-count")).toBeNull();
  });
  it("groups active chats by date and keeps coordinators and resolved chats out", async () => {
    await render();
    expect(headings()).toEqual(["Today, 2 chats", "Older, 1 chat"]);
    expect(chats().sort()).toEqual(["Chat ask", "Chat old", "Chat today"]);
    expect(container.querySelectorAll("[data-mark='Codex']")).toHaveLength(3);
  });
  it("collapses a date heading without losing the others", async () => {
    await render();
    const today = container.querySelector<HTMLButtonElement>(".sws-side-subheading button")!;
    await act(async () => today.click());
    expect(today.getAttribute("aria-expanded")).toBe("false");
    expect(chats()).toEqual(["Chat old"]);
  });
  it("puts chats in their own section after Projects, with dates as subheadings", async () => {
    await render();
    const sections = [...container.querySelectorAll(".sws-side-section")];
    expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
      "Projects",
      "Chats",
    ]);
    const chatSection = sections[1]!;
    expect(chatSection.classList.contains("sws-side-chats")).toBe(true);
    expect(chatSection.getAttribute("aria-labelledby")).toBe("sws-side-chats");
    // The filter belongs to the Chats heading, not to the first date group.
    expect(
      chatSection
        .querySelector(":scope > .sws-side-heading")
        ?.querySelector('[aria-label="Filter and sort chats"]'),
    ).not.toBeNull();
    expect(
      [...chatSection.querySelectorAll(".sws-side-group h3")].map(
        (heading) => heading.firstElementChild?.firstChild?.textContent,
      ),
    ).toEqual(["Today", "Older"]);
    // No chat row sits inside the Projects section.
    expect(sections[0]!.querySelector(".sws-chat-row")).toBeNull();
  });
  it("leaves threads a project started to the project, and keeps the person's own chats", async () => {
    state.groups[0]!.memberProjects[0]!.workspaceSettings = {
      kind: "code",
      coordinatorThreadId: "project-coordinator:p1",
    };
    state.shells = [
      shell("project-coordinator:p1", { createdBy: "agent" }),
      shell("thread:delegated-task:abc", {
        title: "Worker",
        createdBy: "agent",
        hasPendingUserInput: true,
      }),
      shell("fork", {
        title: "Fork",
        createdBy: "user",
        forkedFrom: { type: "run", threadId: "thread:delegated-task:abc", runId: "run-1" },
      } as never),
      // Started with New chat in a project that has a coordinator: still a chat.
      shell("mine", { createdBy: "user", updatedAt: iso(1) }),
      shell("plain", { projectId: "p2" as EnvironmentThreadShell["projectId"] }),
    ];
    await render();
    expect(chats()).toEqual(["Chat plain", "Chat mine"]);
    // The project row still counts what its threads need from the person.
    const atlas = container.querySelector('a[href="/projects/host:/a"]')!;
    expect(atlas.querySelector(".sws-count")?.textContent).toBe("1 waiting on you");
    // The person's own chat remains independent even in the same directory.
    const mine = [...container.querySelectorAll<HTMLButtonElement>(".sws-chat-row > button")].find(
      (button) => button.textContent?.includes("Chat mine"),
    )!;
    await act(async () => mine.click());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "mine" },
    });
    // Only project threads left: the empty line says where they are.
    state.shells = state.shells.filter((thread) => thread.id !== "plain" && thread.id !== "mine");
    await render();
    expect(chats()).toEqual([]);
    const empty = container.querySelector(".sws-side-chats .sws-side-empty");
    expect(empty?.textContent).toBe(
      "No chats yet. Threads agents started are on their project page.",
    );
    expect(container.querySelector(".sws-side-chats h2")?.textContent).toBe("Chats");
    // Nothing at all: no chats yet.
    state.shells = [];
    await render();
    expect(container.querySelector(".sws-side-chats .sws-side-empty")?.textContent).toBe(
      "No chats yet.",
    );
  });
  it("keeps threads of a checkout the project page does not show in the chat list", async () => {
    state.groups[0]!.memberProjects = [
      {
        environmentId: "host",
        id: "p1",
        workspaceSettings: { kind: "code", coordinatorThreadId: "project-coordinator:p1" },
      },
      {
        environmentId: "laptop",
        id: "p1",
        workspaceSettings: { kind: "code", coordinatorThreadId: "project-coordinator:p1" },
      },
    ];
    state.shells = [
      shell("host-worker", { title: "Host worker", createdBy: "agent" }),
      shell("laptop-worker", {
        title: "Laptop worker",
        environmentId: "laptop",
        createdBy: "agent",
      } as never),
    ];
    await render();
    // The page shows this computer's checkout, so only its worker is left to the page.
    expect(chats()).toEqual(["Laptop worker"]);
    // With the laptop picked as the coordinator machine, the other way round.
    state.savedMachines = { "host:/a": "laptop:p1" };
    await render();
    expect(chats()).toEqual(["Host worker"]);
  });
  it("moves through the visible chats with the keyboard, skipping project threads", async () => {
    state.groups[0]!.memberProjects[0]!.workspaceSettings = {
      kind: "code",
      coordinatorThreadId: "project-coordinator:p1",
    };
    state.groups[1]!.memberProjects[0]!.workspaceSettings = { kind: "code" };
    state.shells = [
      shell("worker", { title: "Worker", createdBy: "agent", updatedAt: iso(0) }),
      shell("first", { projectId: "p2" as EnvironmentThreadShell["projectId"], updatedAt: iso(0) }),
      shell("second", {
        projectId: "p2" as EnvironmentThreadShell["projectId"],
        updatedAt: iso(3),
      }),
    ];
    state.keybindings = [
      {
        command: "thread.next",
        shortcut: {
          key: "]",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      },
    ];
    state.params = { environmentId: "host", threadId: "first" };
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", ctrlKey: true }));
    });
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "second" },
    });
  });
  it("jumps to the nth visible chat, not counting project threads", async () => {
    state.groups[0]!.memberProjects[0]!.workspaceSettings = {
      kind: "code",
      coordinatorThreadId: "project-coordinator:p1",
    };
    state.shells = [
      // The newest thread is the project's: it must not take the first slot.
      shell("worker", { title: "Worker", createdBy: "agent", updatedAt: iso(0) }),
      shell("first", {
        projectId: "p2" as EnvironmentThreadShell["projectId"],
        updatedAt: iso(0.5),
      }),
      shell("second", {
        projectId: "p2" as EnvironmentThreadShell["projectId"],
        updatedAt: iso(1),
      }),
    ];
    state.keybindings = [
      {
        command: "thread.jump.1",
        shortcut: {
          key: "1",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      },
    ];
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true }));
    });
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "first" },
    });
  });
  it("opens a chat on its own route", async () => {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-chat-row > button")!.click(),
    );
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: expect.any(String) },
    });
  });
  it("opens a project workspace's chats in that project's right panel", async () => {
    state.groups[0]!.memberProjects[0]!.workspaceSettings = {
      kind: "code",
      coordinatorThreadId: "project-coordinator:p1",
    };
    state.shells = [
      shell("thread:mcp:scope:req:0", { title: "Worker", createdBy: "agent" }),
      // A fork of a worker, and a thread started from inside the panel: the project lists both.
      shell("fork", {
        title: "Fork",
        forkedFrom: { type: "run", threadId: "thread:mcp:scope:req:0", runId: "run-1" },
      } as never),
      shell("plain", { projectId: "p2" as EnvironmentThreadShell["projectId"] }),
    ];
    // The project's own threads only join the chat list when the filter asks for them.
    localStorage.setItem(
      "studio:sidebar-chats:v1",
      JSON.stringify({ ...DEFAULT_CHAT_LIST_OPTIONS, projectThreads: "show" }),
    );
    await render();
    const row = (title: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".sws-chat-row > button")].find((button) =>
        button.textContent?.includes(title),
      )!;
    await act(async () => row("Worker").click());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "host:/a" },
      search: { thread: "thread:mcp:scope:req:0", checkout: "host:p1" },
    });
    await act(async () => row("Fork").click());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "host:/a" },
      search: { thread: "fork", checkout: "host:p1" },
    });
    await act(async () => row("Chat plain").click());
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "plain" },
    });
    // The project page's open thread is the current chat row.
    state.params = { projectKey: "host:/a" };
    state.search = { thread: "thread:mcp:scope:req:0" };
    await render();
    expect(row("Worker").getAttribute("aria-current")).toBe("page");
    expect(row("Chat plain").getAttribute("aria-current")).toBeNull();
  });
  it("remembers a saved filter and says so when nothing matches it", async () => {
    localStorage.setItem(
      "studio:sidebar-chats:v1",
      JSON.stringify({ status: "resolved", activity: "any", groupBy: "none", sortBy: "title" }),
    );
    await render();
    expect(chats()).toEqual(["Chat done"]);
    expect(
      container.querySelector('[aria-label="Filter and sort chats, filter active"]'),
    ).not.toBeNull();
    state.shells = [shell("today")];
    await render();
    expect(container.textContent).toContain("No chats match this filter.");
  });
  it("keeps one personal assistant entry outside projects before and after setup", async () => {
    const opened: unknown[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("studio:open-command-palette", listen);
    await render();
    const offer = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Personal assistant"),
    )!;
    await act(async () => offer.click());
    expect(opened).toEqual([{ open: "new-assistant" }]);
    state.groups = [
      ...state.groups,
      {
        projectKey: "host:/aide",
        displayName: "Aide",
        memberProjects: [
          { environmentId: "host", id: "p3", workspaceSettings: { kind: "personal" } },
        ],
      },
    ];
    await render();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        b.textContent?.startsWith("Personal assistant"),
      ),
    ).toBe(true);
    expect(container.querySelector('[aria-labelledby="sws-side-projects"]')?.textContent).not.toContain("Aide");
    expect(container.querySelector('[aria-labelledby="sws-side-projects"]')?.textContent).not.toContain("Personal assistant");
    window.removeEventListener("studio:open-command-palette", listen);
  });
  it("starts an independent chat even when several projects are available", async () => {
    const opened: unknown[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("studio:open-command-palette", listen);
    await render();
    const newChat = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("New chat"),
    )!;
    await act(async () => newChat.click());
    expect(opened).toEqual([]);
    expect(state.start).toHaveBeenCalledWith("host");
    state.groups = state.groups.slice(0, 1);
    await render();
    await act(async () => newChat.click());
    expect(state.start).toHaveBeenCalledTimes(2);
    window.removeEventListener("studio:open-command-palette", listen);
  });
  it("keeps independent chat attention out of the project's badge", async () => {
    state.shells = [
      shell("mine", { createdBy: "user", hasPendingUserInput: true }),
      shell("unknown", { hasPendingUserInput: true }),
      shell("project-coordinator:p1", { hasPendingUserInput: true }),
      shell("project-coordinator:p1-old", { createdBy: "agent", hasPendingUserInput: true }),
      shell("worker", { createdBy: "agent", hasPendingUserInput: true }),
    ];
    await render();
    expect(container.querySelector('a[href="/projects/host:/a"] .sws-count')?.textContent).toBe(
      "2 waiting on you",
    );
    expect(chats()).toContain("Chat mine");
  });
  it.each([false, true])(
    "starts New chat on the project's selected checkout (explicit URL: %s)",
    async (explicit) => {
      state.params = { projectKey: "host:/a" };
      state.groups[0]!.memberProjects.push({ environmentId: "laptop", id: "remote-p1" });
      if (explicit) state.search = { checkout: "laptop:remote-p1" };
      else state.savedMachines = { "host:/a": "laptop:remote-p1" };
      await render();
      const button = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("New chat"),
      )!;
      await act(async () => button.click());
      expect(state.start).toHaveBeenCalledWith("laptop");
    },
  );
  it("does not substitute another machine for a missing explicit project checkout", async () => {
    state.params = { projectKey: "host:/a" };
    state.search = { checkout: "missing:remote-p1" };
    await render();
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("New chat"),
    )!;
    await act(async () => button.click());
    expect(state.start).not.toHaveBeenCalled();
  });
  it("starts New chat on the open draft's machine", async () => {
    state.params = { draftId: "remote-draft" };
    vi.spyOn(useComposerDraftStore.getState(), "getDraftSession").mockReturnValue({
      environmentId: "laptop",
    } as never);
    await render();
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("New chat"),
    )!;
    await act(async () => button.click());
    expect(state.start).toHaveBeenCalledWith("laptop");
  });
});

describe("saved project names across grouped checkouts", () => {
  function groupFor(repository: string, title: string) {
    const project = (id: string, name: string, environmentId = "host"): EnvironmentProject => ({
      environmentId: EnvironmentId.make(environmentId),
      id: ProjectId.make(id),
      title: name,
      workspaceRoot: `/${environmentId}/${id}`,
      repositoryIdentity: {
        canonicalKey: `github.com/anton-abyzov/${repository}`,
        displayName: `anton-abyzov/${repository}`,
        name: repository,
        rootPath: `/${environmentId}/${id}`,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://github.com/anton-abyzov/${repository}.git`,
        },
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: iso(2),
      updatedAt: iso(0),
    });
    // Proof projects can precede the regular checkout, as on the actual host.
    const group = buildSidebarProjectSnapshots({
      projects: [
        project("proof", `${repository} M4 handoff proof`),
        project("canonical", title),
        project("product-proof", `${repository} product handoff 0907`),
        project("remote", `${title} on M3`, "laptop"),
      ],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId: EnvironmentId.make("host"),
      resolveEnvironmentLabel: (id) => id,
    })[0]!;
    return { ...group, memberProjects: [...group.memberProjects] };
  }

  it.each([
    ["sw-easychamp", "EasyChamp"],
    ["specweave-umb", "SpecWeave umbrella"],
    ["jobweave-umb", "JobWeave"],
  ])(
    "shows %s's saved checkout name despite conflicting proof titles",
    async (repository, title) => {
      const group = groupFor(repository, title);
      expect(group.displayName).toBe(`anton-abyzov/${repository}`);
      const before = JSON.stringify(group);
      state.groups = [group];
      state.savedMachines = { [group.projectKey]: "host:canonical" };
      state.params = { projectKey: group.projectKey };
      await render();
      const row = container.querySelector('a[href^="/projects/"]')!;
      expect(row.querySelector(".sws-side-row-label")?.textContent).toBe(title);
      expect(row.getAttribute("href")).toBe(`/projects/${group.projectKey}`);
      expect(row.getAttribute("aria-current")).toBe("page");
      expect(container.querySelector(`[aria-label="Actions for ${title}"]`)).not.toBeNull();
      expect(JSON.stringify(group)).toBe(before);
    },
  );

  it.each([false, true])(
    "keeps the name, icon and tooltip on the selected remote checkout (explicit: %s)",
    async (explicit) => {
      const group = groupFor("sw-easychamp", "EasyChamp");
      state.groups = [group];
      state.params = { projectKey: group.projectKey };
      state.savedMachines = {
        [group.projectKey]: explicit ? "host:canonical" : "laptop:remote",
      };
      if (explicit) state.search = { checkout: "laptop:remote", thread: "old-panel-thread" };
      await render();
      const row = container.querySelector<HTMLAnchorElement>('a[href^="/projects/"]')!;
      expect(row.querySelector(".sws-side-row-label")?.textContent).toBe("EasyChamp on M3");
      expect(JSON.parse(row.getAttribute("data-route-search")!)).toEqual({
        checkout: "laptop:remote",
      });
      const icon = row.querySelector("[data-project-title]")!;
      expect(icon.getAttribute("data-project-title")).toBe("EasyChamp on M3");
      expect(icon.getAttribute("data-project-environment")).toBe("laptop");
      expect(icon.getAttribute("data-project-root")).toBe("/laptop/remote");
      expect(container.querySelector('[aria-label="Actions for EasyChamp on M3"]')).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        row.focus();
      });
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
          "EasyChamp on M3 · /laptop/remote",
        );
      });
    },
  );

  it.each(["missing:remote", "laptop:missing-project"])(
    "does not label a missing explicit checkout %s as another selected machine",
    async (checkout) => {
      const group = groupFor("sw-easychamp", "EasyChamp");
      state.groups = [group];
      state.params = { projectKey: group.projectKey };
      state.savedMachines = { [group.projectKey]: "laptop:remote" };
      state.search = { checkout };
      await render();
      expect(container.querySelector(".sws-project-row .sws-side-row-label")?.textContent).toBe(
        group.displayName,
      );
      const newChat = [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("New chat"),
      )!;
      await act(async () => newChat.click());
      expect(state.start).not.toHaveBeenCalled();
    },
  );

  it.each(["", " \n ", "bad\ncheckout", "malformed"])(
    "uses the saved checkout when URL parsing rejects %j, as the workspace does",
    async (checkout) => {
      const group = groupFor("sw-easychamp", "EasyChamp");
      state.groups = [group];
      state.params = { projectKey: group.projectKey };
      state.savedMachines = { [group.projectKey]: "laptop:remote" };
      state.search = { checkout };
      await render();
      expect(container.querySelector(".sws-project-row .sws-side-row-label")?.textContent).toBe(
        "EasyChamp on M3",
      );
    },
  );
});

describe("cleaning up the projects list", () => {
  const projectNames = () =>
    [...container.querySelectorAll('a[href^="/projects/"] .sws-side-row-label')].map(
      (label) => label.textContent,
    );
  const scratch = (environmentId: string, root: string) => ({
    projectKey: `${environmentId}:${root}`,
    displayName: "No project",
    workspaceRoot: root,
    memberProjects: [{ environmentId, id: `scratch-${environmentId}`, workspaceRoot: root }],
  });
  const archivedSample = {
    projectKey: "remote:/srv/samples",
    displayName: "Routing samples",
    workspaceRoot: "/srv/samples",
    memberProjects: [
      {
        environmentId: "remote",
        id: "samples",
        workspaceRoot: "/srv/samples",
        workspaceSettings: { kind: "code" as const, archived: true, revision: 2 },
      },
    ],
  };

  it("leaves every machine's No project folder out of Projects but keeps its chats", async () => {
    state.scratchRoots = new Map([
      ["host", { scratchWorkspaceRoot: "/home/user/scratch" }],
      ["remote", { scratchWorkspaceRoot: "/srv/scratch" }],
    ]);
    state.groups.push(scratch("host", "/home/user/scratch"), scratch("remote", "/srv/scratch"));
    state.shells = [
      shell("loose", { projectId: "scratch-host" as EnvironmentThreadShell["projectId"] }),
    ];
    await render();
    expect(projectNames()).toEqual(["Atlas", "Borealis"]);
    expect(chats()).toEqual(["Chat loose"]);
  });

  it("folds archived projects under Archived (N) and lists them again on request", async () => {
    state.groups.push(archivedSample);
    await render();
    expect(projectNames()).toEqual(["Atlas", "Borealis"]);
    const toggle = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Archived (1)",
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide archived");
    const archivedList = container.querySelector('[aria-label="Archived projects"]')!;
    expect(archivedList.textContent).toContain("Routing samples");
    expect(archivedList.querySelector(".sws-side-row-hint")?.textContent).toBe("Archived");
  });

  it("keeps an archived project's row while its page is open", async () => {
    state.groups.push(archivedSample);
    state.params = { projectKey: "remote:/srv/samples" };
    await render();
    expect(projectNames()).toEqual(["Atlas", "Borealis", "Routing samples"]);
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Archived")),
    ).toBe(false);
  });

  it("archives and restores a project through its row menu", async () => {
    state.groups.push(archivedSample);
    await render();
    const openMenu = async (name: string) => {
      const trigger = container.querySelector<HTMLButtonElement>(
        `[aria-label="Actions for ${name}"]`,
      )!;
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger.click();
      });
    };
    const clickItem = async (label: string) => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find(
        (entry) => entry.textContent === label,
      ) as HTMLElement;
      await act(async () => item.click());
    };
    await openMenu("Atlas");
    await clickItem("Archive project");
    expect(state.updateProject).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "p1", workspaceSettings: { expectedRevision: 0, archived: true } },
    });
    const toggle = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Archived (1)",
    )!;
    await act(async () => toggle.click());
    await openMenu("Routing samples");
    await clickItem("Restore project");
    expect(state.updateProject).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: {
        projectId: "samples",
        workspaceSettings: { expectedRevision: 2, archived: false },
      },
    });
  });
});
