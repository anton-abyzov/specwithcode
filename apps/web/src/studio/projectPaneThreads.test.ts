import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  chatNavigationTarget,
  chatProjectPaneTarget,
  currentSidebarChatKey,
  isProjectOwnedChat,
  paneSelectionCorrection,
  parseProjectWorkspaceSearch,
  projectPaneTargetForChat,
  projectPaneThread,
  threadBelongsToProject,
} from "./projectPaneThreads";

type Shell = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "deletedAt" | "lineage" | "forkedFrom" | "createdBy"
>;

function shell(id: string, overrides: Partial<Record<keyof Shell, unknown>> = {}): Shell {
  return {
    id,
    environmentId: "host",
    projectId: "atlas",
    deletedAt: null,
    createdBy: "agent",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    ...overrides,
  } as Shell;
}
const scope = { environmentId: "host", projectId: "atlas" };
const subagentOf = (parent: string, root = parent) => ({
  parentThreadId: parent,
  relationshipToParent: "subagent",
  rootThreadId: root,
});

describe("projectPaneThread", () => {
  it("opens the project's own threads", () => {
    const decision = projectPaneThread([shell("worker")], scope, "worker");
    expect(decision).toEqual({ kind: "pane", thread: shell("worker") });
  });
  it("opens subagents and forks whose lineage leads to the project, whatever their project id", () => {
    const threads = [
      shell("worker"),
      shell("native", { projectId: "scratch", lineage: subagentOf("worker") }),
      shell("grandchild", { projectId: "scratch", lineage: subagentOf("native", "worker") }),
      shell("fork", {
        projectId: "scratch",
        forkedFrom: { type: "run", threadId: "worker", runId: "run-1" },
        lineage: { parentThreadId: null, relationshipToParent: "fork", rootThreadId: "fork" },
      }),
    ];
    for (const id of ["native", "grandchild", "fork"])
      expect(projectPaneThread(threads, scope, id).kind).toBe("pane");
  });
  it("leaves another project's thread, another environment's, and its subagents outside", () => {
    const threads = [
      shell("foreign", { projectId: "other" }),
      shell("foreign-child", { projectId: "other", lineage: subagentOf("foreign") }),
      shell("remote", { environmentId: "laptop" }),
    ];
    expect(projectPaneThread(threads, scope, "foreign")).toEqual({
      kind: "elsewhere",
      environmentId: "host",
    });
    expect(projectPaneThread(threads, scope, "foreign-child").kind).toBe("elsewhere");
    expect(projectPaneThread(threads, scope, "worker", "laptop")).toEqual({
      kind: "elsewhere",
      environmentId: "laptop",
    });
  });
  it("sends a link with no machine to the one machine that has the thread", () => {
    const threads = [shell("remote", { environmentId: "laptop" })];
    expect(projectPaneThread(threads, scope, "remote")).toEqual({
      kind: "elsewhere",
      environmentId: "laptop",
    });
    const gone = [shell("remote", { environmentId: "laptop", deletedAt: "2026-10-11T00:00:00Z" })];
    expect(projectPaneThread(gone, scope, "remote").kind).toBe("unknown");
  });
  it("tells deleted and not-yet-loaded threads apart", () => {
    const threads = [shell("gone", { deletedAt: "2026-10-11T00:00:00Z" })];
    expect(projectPaneThread(threads, scope, "gone").kind).toBe("deleted");
    expect(projectPaneThread(threads, scope, "later").kind).toBe("unknown");
  });
  it("stops on a lineage cycle", () => {
    const threads = [
      shell("a", { projectId: "x", lineage: subagentOf("b") }),
      shell("b", { projectId: "x", lineage: subagentOf("a") }),
    ];
    const byId = new Map(threads.map((t) => [t.id as string, t]));
    expect(threadBelongsToProject(threads[0]!, scope, (id) => byId.get(id))).toBe(false);
  });
});

describe("the coordinator in projectPaneThread", () => {
  const withCoordinator = { ...scope, coordinatorThreadId: "coord" };
  it("never opens the coordinator in the panel, loaded or not", () => {
    expect(projectPaneThread([shell("coord")], withCoordinator, "coord")).toEqual({
      kind: "coordinator",
    });
    expect(projectPaneThread([], withCoordinator, "coord")).toEqual({ kind: "coordinator" });
  });
  it("takes the host's coordinator id for the coordinator before the settings load", () => {
    expect(
      projectPaneThread([shell("project-coordinator:atlas")], scope, "project-coordinator:atlas"),
    ).toEqual({ kind: "coordinator" });
  });
  it("opens a previous coordinator full page", () => {
    const threads = [shell("project-coordinator:atlas"), shell("coord")];
    expect(projectPaneThread(threads, withCoordinator, "project-coordinator:atlas")).toEqual({
      kind: "elsewhere",
      environmentId: "host",
    });
  });
  it("leaves another machine's coordinator on that machine", () => {
    expect(projectPaneThread([], withCoordinator, "coord", "laptop")).toEqual({
      kind: "elsewhere",
      environmentId: "laptop",
    });
  });
});

describe("paneSelectionCorrection", () => {
  it("lets go of the coordinator for the main conversation", () => {
    expect(paneSelectionCorrection({ kind: "coordinator" }, false)).toEqual({
      kind: "coordinator",
    });
  });
  it("leaves a shown thread, and nothing selected, alone", () => {
    expect(paneSelectionCorrection(null, true)).toEqual({ kind: "none" });
    expect(paneSelectionCorrection({ kind: "pane", thread: {} }, true)).toEqual({ kind: "none" });
  });
  it("closes the panel on a deleted thread and opens another project's full page", () => {
    expect(paneSelectionCorrection({ kind: "deleted" }, false)).toEqual({ kind: "close" });
    expect(paneSelectionCorrection({ kind: "elsewhere", environmentId: "laptop" }, false)).toEqual({
      kind: "elsewhere",
      environmentId: "laptop",
    });
  });
  it("waits for every host before giving up on a thread it has not seen", () => {
    expect(paneSelectionCorrection({ kind: "unknown" }, false)).toEqual({ kind: "none" });
    expect(paneSelectionCorrection({ kind: "unknown" }, true)).toEqual({ kind: "close" });
  });
});

describe("parseProjectWorkspaceSearch", () => {
  it("keeps a thread id and drops anything else", () => {
    expect(parseProjectWorkspaceSearch({ thread: " thread:mcp:a:b:0 " })).toEqual({
      thread: "thread:mcp:a:b:0",
    });
    expect(parseProjectWorkspaceSearch({})).toEqual({});
    expect(parseProjectWorkspaceSearch({ thread: "" })).toEqual({});
    expect(parseProjectWorkspaceSearch({ thread: 42 })).toEqual({});
    expect(parseProjectWorkspaceSearch({ thread: "a\nb" })).toEqual({});
    expect(parseProjectWorkspaceSearch({ thread: "x".repeat(513) })).toEqual({});
  });
});

describe("projectPaneTargetForChat", () => {
  const project = { projectKey: "atlas-key", coordinatorThreadId: "project-coordinator:atlas" };
  const chat = (id: string) => ({ id: id as Shell["id"], createdBy: "agent" as const });
  it("routes agent workers and their forks into the project panel", () => {
    expect(projectPaneTargetForChat(chat("thread:mcp:scope:req:0"), project)).toEqual({
      projectKey: "atlas-key",
      threadId: "thread:mcp:scope:req:0",
    });
    expect(projectPaneTargetForChat(chat("thread:delegated-task:cmd"), project)).not.toBeNull();
    // Agent-created forks remain owned even when their root is unavailable.
    expect(projectPaneTargetForChat(chat("fork-1"), project)).not.toBeNull();
    expect(
      projectPaneTargetForChat({ ...chat("plain-chat"), createdBy: "user" }, project),
    ).toBeNull();
  });
  it("keeps chats of projects without a coordinator full page", () => {
    expect(
      projectPaneTargetForChat(chat("thread:mcp:scope:req:0"), {
        projectKey: "atlas-key",
        coordinatorThreadId: null,
      }),
    ).toBeNull();
    expect(projectPaneTargetForChat(chat("thread:mcp:scope:req:0"), null)).toBeNull();
  });
  it("opens the coordinator full page, where its approvals and answers are, never in the panel", () => {
    expect(projectPaneTargetForChat(chat("project-coordinator:atlas"), project)).toBeNull();
  });
  it("opens a previous coordinator full page", () => {
    const renamed = { projectKey: "atlas-key", coordinatorThreadId: "coord-2" };
    expect(projectPaneTargetForChat(chat("project-coordinator:atlas"), renamed)).toBeNull();
    expect(projectPaneTargetForChat(chat("coord-2"), renamed)).toBeNull();
  });
});

describe("chatProjectPaneTarget", () => {
  const group = {
    projectKey: "atlas-key",
    memberProjects: [
      {
        environmentId: "host",
        id: "atlas",
        workspaceSettings: { coordinatorThreadId: "project-coordinator:atlas" },
      },
      { environmentId: "laptop", id: "atlas", workspaceSettings: undefined },
    ],
  };
  const row = (environmentId: string, id = "thread:mcp:s:r:0") =>
    ({
      id,
      environmentId,
      projectId: "atlas",
      createdBy: "agent",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    }) as unknown as Parameters<typeof chatProjectPaneTarget>[0];
  it("uses the coordinator of the checkout the chat lives in", () => {
    expect(chatProjectPaneTarget(row("host"), group)?.projectKey).toBe("atlas-key");
    expect(chatProjectPaneTarget(row("laptop"), group)).toBeNull();
    expect(chatProjectPaneTarget(row("host"), undefined)).toBeNull();
  });
  it("opens each machine's coordinator on its own page, not the page's chosen coordinator", () => {
    const twoMachines = {
      projectKey: "atlas-key",
      memberProjects: [
        {
          environmentId: "host",
          id: "atlas",
          workspaceSettings: { coordinatorThreadId: "project-coordinator:atlas" },
        },
        {
          environmentId: "laptop",
          id: "atlas",
          workspaceSettings: { coordinatorThreadId: "project-coordinator:atlas" },
        },
      ],
    };
    expect(chatProjectPaneTarget(row("host", "project-coordinator:atlas"), twoMachines)).toBeNull();
    expect(
      chatProjectPaneTarget(row("laptop", "project-coordinator:atlas"), twoMachines),
    ).toBeNull();
    expect(chatProjectPaneTarget(row("laptop"), twoMachines)?.threadId).toBe("thread:mcp:s:r:0");
  });
  describe("isProjectOwnedChat", () => {
    type Owned = Parameters<typeof isProjectOwnedChat>[0];
    const owned = (
      id: string,
      overrides: {
        environmentId?: string;
        createdBy?: string;
        lineage?: unknown;
        forkedFrom?: unknown;
      } = {},
    ) =>
      ({
        id,
        environmentId: "host",
        projectId: "atlas",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        ...overrides,
      }) as unknown as Owned;
    const host = { environmentId: "host", id: "atlas" };
    const check = (
      thread: Owned,
      others: Owned[] = [],
      displayedCheckout: typeof host | undefined = host,
    ) =>
      isProjectOwnedChat(thread, group, {
        displayedCheckout,
        lookup: (id) => [thread, ...others].find((candidate) => candidate.id === id),
      });
    it("owns the threads an agent started in the project", () => {
      expect(check(owned("worker", { createdBy: "agent" }))).toBe(true);
    });
    it("leaves a chat the person started as a chat, even with a coordinator", () => {
      expect(check(owned("mine", { createdBy: "user" }))).toBe(false);
      // A server that does not say who started a thread counts it as the person's.
      expect(check(owned("unknown"))).toBe(false);
      // Sharing a directory does not make it a project worker.
      expect(chatProjectPaneTarget(owned("mine", { createdBy: "user" }), group)).toBeNull();
    });
    it("owns forks and subagents of a worker, whoever started them", () => {
      const worker = owned("worker", { createdBy: "agent" });
      const fork = owned("fork", {
        createdBy: "user",
        lineage: { parentThreadId: "worker", relationshipToParent: "fork", rootThreadId: "worker" },
      });
      const runFork = owned("run-fork", {
        createdBy: "user",
        forkedFrom: { type: "run", threadId: "fork", runId: "r" },
      });
      expect(check(fork, [worker])).toBe(true);
      expect(check(runFork, [worker, fork])).toBe(true);
      // A fork of the person's own chat stays theirs.
      const mine = owned("mine", { createdBy: "user" });
      expect(
        check(
          owned("mine-fork", {
            createdBy: "user",
            lineage: { parentThreadId: "mine", relationshipToParent: "fork", rootThreadId: "mine" },
          }),
          [mine],
        ),
      ).toBe(false);
    });
    it("only hides what the project page lists", () => {
      const worker = owned("worker", { createdBy: "agent" });
      // A checkout without a coordinator has no project page to hold its threads.
      expect(check(owned("w", { environmentId: "laptop", createdBy: "agent" }))).toBe(false);
      expect(
        isProjectOwnedChat(worker, undefined, { displayedCheckout: host, lookup: () => undefined }),
      ).toBe(false);
      // The page shows another checkout, so this one's threads stay in the chat list.
      expect(check(worker, [], { environmentId: "laptop", id: "atlas" })).toBe(false);
      expect(
        isProjectOwnedChat(worker, group, {
          displayedCheckout: undefined,
          lookup: () => undefined,
        }),
      ).toBe(false);
      // The coordinator itself is the project row, never a thread in its panel.
      expect(check(owned("project-coordinator:atlas", { createdBy: "agent" }))).toBe(false);
    });
  });
});

describe("chatNavigationTarget", () => {
  const group = {
    projectKey: "atlas-key",
    memberProjects: [
      {
        environmentId: "host",
        id: "atlas",
        workspaceSettings: { coordinatorThreadId: "project-coordinator:atlas" },
      },
    ],
  };
  const row = (projectId: string) =>
    ({
      id: "worker",
      environmentId: "host",
      projectId,
      createdBy: "agent",
    }) as unknown as Parameters<typeof chatNavigationTarget>[0];
  it("names the project page with the thread, or the thread's own page", () => {
    expect(chatNavigationTarget(row("atlas"), group)).toEqual({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas-key" },
      search: { thread: "worker", checkout: "host:atlas" },
    });
    expect(chatNavigationTarget(row("other"), undefined)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "worker" },
    });
  });
  it("names the coordinator main project view, never the side panel", () => {
    const coordinator = {
      id: "project-coordinator:atlas",
      environmentId: "host",
      projectId: "atlas",
    } as unknown as Parameters<typeof chatNavigationTarget>[0];
    expect(chatNavigationTarget(coordinator, group)).toEqual({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas-key" },
      search: { checkout: "host:atlas" },
    });
  });
});

describe("currentSidebarChatKey", () => {
  const chats = [
    { key: "host:a", id: "a", project: "atlas" },
    { key: "host:b", id: "b", project: "atlas" },
    { key: "host:c", id: "c", project: "borealis" },
  ];
  const current = (input: {
    routeThreadKey?: string | null;
    paneThreadId?: string | null;
    activeProjectKey?: string | null;
  }) =>
    currentSidebarChatKey({
      routeThreadKey: input.routeThreadKey ?? null,
      paneThreadId: input.paneThreadId ?? null,
      activeProjectKey: input.activeProjectKey ?? null,
      chats,
      keyOf: (chat) => chat.key,
      idOf: (chat) => chat.id,
      projectKeyOf: (chat) => chat.project,
    });
  it("is the full-page chat when there is one", () => {
    expect(current({ routeThreadKey: "host:z", paneThreadId: "b" })).toBe("host:z");
  });
  it("is the chat open in the project's panel, so next and previous move from it", () => {
    expect(current({ paneThreadId: "b", activeProjectKey: "atlas" })).toBe("host:b");
  });
  it("is nothing for another project's thread, or off a project page", () => {
    expect(current({ paneThreadId: "c", activeProjectKey: "atlas" })).toBeNull();
    expect(current({ paneThreadId: "b" })).toBeNull();
    expect(current({})).toBeNull();
  });
});

describe("coordinator, worker and independent chat entry points", () => {
  const group = {
    projectKey: "atlas",
    memberProjects: [
      {
        environmentId: "host",
        id: "atlas",
        workspaceSettings: { coordinatorThreadId: "coordinator" },
      },
    ],
  };
  const row = (id: string, createdBy?: "agent" | "user") =>
    ({
      id,
      environmentId: "host",
      projectId: "atlas",
      createdBy,
      lineage: { relationshipToParent: null },
    }) as unknown as Parameters<typeof chatNavigationTarget>[0];
  it("opens the current coordinator in the project main pane", () => {
    expect(chatNavigationTarget(row("coordinator"), group)).toEqual({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { checkout: "host:atlas" },
    });
  });
  it("keeps an independent human chat full-page despite sharing a checkout", () => {
    expect(chatNavigationTarget(row("independent", "user"), group)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "independent" },
    });
  });
  it("keeps unknown provenance full-page and puts a known worker in the project side pane", () => {
    expect(chatNavigationTarget(row("legacy"), group).to).toBe("/$environmentId/$threadId");
    expect(chatNavigationTarget(row("worker", "agent"), group)).toEqual({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { thread: "worker", checkout: "host:atlas" },
    });
  });
});

it("retains a validated exact checkout independently of the optional side thread", () => {
  expect(parseProjectWorkspaceSearch({ checkout: " remote:project ", thread: "worker" })).toEqual({
    checkout: "remote:project",
    thread: "worker",
  });
  expect(parseProjectWorkspaceSearch({ checkout: "remote:project", thread: "" })).toEqual({
    checkout: "remote:project",
  });
  expect(parseProjectWorkspaceSearch({ checkout: "remote\n:project" })).toEqual({});
  expect(parseProjectWorkspaceSearch({ checkout: "x".repeat(1025) })).toEqual({});
});

it.each(["user", null])(
  "keeps same-project independent %s chats full page in direct pane links",
  (createdBy) => {
    expect(projectPaneThread([shell("independent", { createdBy })], scope, "independent")).toEqual({
      kind: "elsewhere",
      environmentId: "host",
    });
  },
);

describe("standalone chat descendants", () => {
  const group = {
    projectKey: "atlas",
    memberProjects: [
      { environmentId: "host", id: "atlas", workspaceSettings: { coordinatorThreadId: "coord" } },
    ],
  };
  it.each(["atlas", "scratch"])(
    "keeps native descendants stored in %s with their independent human root",
    (projectId) => {
      const root = shell("independent", { createdBy: "user" });
      const child = shell("native-child", { projectId, lineage: subagentOf(root.id) });
      const grandchild = shell("nested-child", {
        projectId,
        lineage: subagentOf(child.id, root.id),
      });
      const threads = [root, child, grandchild];
      const lookup = (id: string) => threads.find((thread) => thread.id === id);
      for (const descendant of [child, grandchild]) {
        expect(
          projectPaneThread(threads, { ...scope, coordinatorThreadId: "coord" }, descendant.id)
            .kind,
        ).toBe("elsewhere");
        expect(chatNavigationTarget(descendant, group, lookup).to).toBe(
          "/$environmentId/$threadId",
        );
        expect(
          isProjectOwnedChat(descendant, group, {
            displayedCheckout: { environmentId: "host", id: "atlas" },
            lookup,
          }),
        ).toBe(false);
      }
    },
  );
  it("does not claim an agent child before its referenced parent loads", () => {
    const child = shell("native-child", { lineage: subagentOf("loading-parent") });
    expect(chatNavigationTarget(child, group).to).toBe("/$environmentId/$threadId");
    const parent = shell("loading-parent");
    expect(
      chatNavigationTarget(child, group, (id) => (id === parent.id ? parent : undefined)).to,
    ).toBe("/projects/$projectKey");
  });
  it("retains exact coordinator ancestry even when the coordinator shell has not loaded", () => {
    const child = shell("native-child", { createdBy: "user", lineage: subagentOf("coord") });
    expect(chatNavigationTarget(child, group).to).toBe("/projects/$projectKey");
  });
});
