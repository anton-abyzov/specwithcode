import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { Project, Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  collapseRestartedBrowsePath,
  buildCommandPaletteProjectMetadata,
  buildCommandPaletteRows,
  buildProjectActionItems,
  buildRootGroups,
  buildRootProjectItems,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  latestThreadActivityByProjectKey,
  machineHasOwnAssistant,
  orderProjectsForPalette,
  paletteAssistants,
  personalAssistantActionOffered,
  RECENT_PROJECT_LIMIT,
  reduceCommandPaletteUiState,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("linked pull request thread navigation", () => {
  it("keeps archived relations searchable and routes them through the PR environment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const id = ThreadId.make("archived-thread");
    const runThread = vi.fn(async () => {});
    const query = "https://github.com/acme/web/pull/42";
    const linkedThreads = {
      environmentId,
      threads: [
        {
          id,
          projectId: ProjectId.make("project"),
          title: "Completed work",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const state = reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null },
      {
        _tag: "OpenSearch",
        query,
        linkedThreads,
      },
    );
    expect(state.openIntent).toEqual({ kind: "search", query, linkedThreads });
    const items = buildLinkedThreadActionItems({ ...linkedThreads, query, icon: null, runThread });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items)).toEqual(items);
    expect(items[0]?.description).toBe("Archived thread");
    await items[0]?.run();
    expect(runThread).toHaveBeenCalledWith({ environmentId, id });
  });
});

describe("buildCommandPaletteProjectMetadata", () => {
  const localEnvironmentId = EnvironmentId.make("environment-local");
  const remoteEnvironmentId = EnvironmentId.make("environment-build-box");
  const locations = new Map([
    [localEnvironmentId, { kind: "local" as const, label: "Local", machine: "laptop" as const }],
    [
      remoteEnvironmentId,
      { kind: "remote" as const, label: "Build box", machine: "server" as const },
    ],
  ]);

  it("makes every member environment and path searchable", () => {
    const metadata = buildCommandPaletteProjectMetadata({
      projects: [
        {
          environmentId: localEnvironmentId,
          title: "SpecWithCode",
          workspaceRoot: "/Users/dev/Projects/studio",
        },
        {
          environmentId: remoteEnvironmentId,
          title: "studio",
          workspaceRoot: "/srv/studio",
        },
      ],
      locationByEnvironmentId: locations,
    });

    expect(metadata.searchTerms).toEqual([
      "SpecWithCode",
      "/Users/dev/Projects/studio",
      "Local",
      "studio",
      "/srv/studio",
      "Build box",
    ]);
    expect(metadata.environmentLabels).toEqual(["Local", "Build box"]);

    const [filteredGroup] = filterCommandPaletteGroups({
      activeGroups: [],
      query: "build box",
      isInSubmenu: false,
      projectSearchItems: [
        {
          kind: "action",
          value: "project:studio",
          title: "SpecWithCode",
          searchTerms: metadata.searchTerms,
          icon: null,
          run: async () => undefined,
        },
      ],
      threadSearchItems: [],
    });
    expect(filteredGroup?.items).toHaveLength(1);
  });

  it("deduplicates grouped checkouts by environment", () => {
    const metadata = buildCommandPaletteProjectMetadata({
      projects: [
        {
          environmentId: remoteEnvironmentId,
          title: "SpecWithCode",
          workspaceRoot: "/srv/studio",
        },
        {
          environmentId: remoteEnvironmentId,
          title: "SpecWithCode worktree",
          workspaceRoot: "/srv/studio-feature",
        },
      ],
      locationByEnvironmentId: locations,
    });

    expect(metadata.environmentLabels).toEqual(["Build box"]);
  });

  it("deduplicates distinct environments with the same label", () => {
    const secondRemoteEnvironmentId = EnvironmentId.make("environment-build-box-2");
    const metadata = buildCommandPaletteProjectMetadata({
      projects: [
        {
          environmentId: remoteEnvironmentId,
          title: "SpecWithCode",
          workspaceRoot: "/srv/studio",
        },
        {
          environmentId: secondRemoteEnvironmentId,
          title: "SpecWithCode mirror",
          workspaceRoot: "/srv/mirror/studio",
        },
      ],
      locationByEnvironmentId: new Map([
        [remoteEnvironmentId, { label: "Build box" }],
        [secondRemoteEnvironmentId, { label: "Build box" }],
      ]),
    });

    expect(metadata.environmentLabels).toEqual(["Build box"]);
  });

  it("uses a human-readable fallback when presentation data is unavailable", () => {
    const metadata = buildCommandPaletteProjectMetadata({
      projects: [
        {
          environmentId: remoteEnvironmentId,
          title: "SpecWithCode",
          workspaceRoot: "/srv/studio",
        },
      ],
      locationByEnvironmentId: new Map(),
    });

    expect(metadata.searchTerms).toContain("Remote");
    expect(metadata.environmentLabels).toEqual(["Remote"]);
  });
});

describe("personalAssistantActionOffered", () => {
  it("offers Personal assistant only while Percy is on and a machine can hold it", () => {
    expect(personalAssistantActionOffered({ aideEnabled: true, newProjectMachineCount: 1 })).toBe(
      true,
    );
    expect(personalAssistantActionOffered({ aideEnabled: false, newProjectMachineCount: 2 })).toBe(
      false,
    );
    expect(personalAssistantActionOffered({ aideEnabled: true, newProjectMachineCount: 0 })).toBe(
      false,
    );
  });

  it("leaves setup out once this machine has its assistant, which the Percy entry opens", () => {
    expect(
      personalAssistantActionOffered({
        aideEnabled: true,
        newProjectMachineCount: 2,
        hasOwnAssistant: true,
      }),
    ).toBe(false);
  });
});

describe("paletteAssistants", () => {
  const assistant = (
    id: string,
    environmentId: string,
    createdAt: string,
    settings: { archived?: boolean } = {},
  ) => ({ id, environmentId, createdAt, workspaceSettings: { kind: "personal", ...settings } });
  const app = { id: "app", environmentId: "m4", workspaceSettings: { kind: "code" } };

  it("lists each machine's own assistant, this machine's first", () => {
    const projects = [
      assistant("anna-aide", "anna", "2026-01-01"),
      app,
      assistant("aide", "m4", "2026-02-01"),
      assistant("aide-extra", "m4", "2026-03-01"),
    ];
    expect(paletteAssistants(projects, "m4").map((project) => project.id)).toEqual([
      "aide",
      "anna-aide",
    ]);
  });

  it("leaves out an archived assistant", () => {
    expect(
      paletteAssistants([assistant("aide", "m4", "2026-02-01", { archived: true })], "m4"),
    ).toEqual([]);
  });

  it("still counts an archived assistant as the machine's own, so setup is not offered", () => {
    const archived = [assistant("aide", "m4", "2026-02-01", { archived: true }), app];
    expect(machineHasOwnAssistant(archived, "m4")).toBe(true);
    expect(machineHasOwnAssistant(archived, "m1")).toBe(false);
    expect(machineHasOwnAssistant([app], "m4")).toBe(false);
    expect(machineHasOwnAssistant(archived, null)).toBe(false);
  });
});

describe("buildRootGroups", () => {
  const item = (value: string) => ({
    kind: "action" as const,
    value,
    searchTerms: [value],
    title: value,
    icon: null,
    run: async () => {},
  });

  it("puts Percy in a group of its own, after the actions", () => {
    expect(
      buildRootGroups({
        projectItems: [],
        actionItems: [item("action:new-thread")],
        recentThreadItems: [item("thread:1")],
        assistantItems: [item("assistant:m4:aide")],
      }).map((group) => [group.value, group.label]),
    ).toEqual([
      ["actions", "Actions"],
      ["assistant", "Percy"],
      ["recent-threads", "Recent Threads"],
    ]);
  });
});

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: "ToggleMode",
      mode: "content",
    });
    expect(contentOpen).toEqual({ open: true, mode: "content", openIntent: null });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: "ToggleMode", mode: "content" }),
    ).toEqual({ open: false, mode: "content", openIntent: null });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("opens PR search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null },
      {
        _tag: "OpenSearch",
        query: "https://github.com/acme/web/pull/7",
      },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "https://github.com/acme/web/pull/7" },
    });
    const second = reduceCommandPaletteUiState(first, {
      _tag: "OpenSearch",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(second.openIntent).toEqual({
      kind: "search",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(
      reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewAssistant", aideEnabled: true }),
    ).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-assistant" },
    });
    // While Percy is off, the sidebar's or another surface's setup request changes nothing.
    expect(
      reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewAssistant", aideEnabled: false }),
    ).toBe(filesOpen);
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("preserves the mode on close and resets it on open", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("buildProjectActionItems", () => {
  it("shows the grouped display name but keeps the real title for icons", () => {
    const project = makeProject({ title: "fleet", workspaceRoot: "/Users/dev/Code/p/fleet" });
    const iconTitles: string[] = [];
    const [item] = buildProjectActionItems({
      projects: [{ ...project, displayName: "acme/fleet" }],
      valuePrefix: "project",
      icon: (candidate) => {
        iconTitles.push(candidate.title);
        return null;
      },
      runProject: async () => undefined,
    });

    expect(item?.title).toBe("acme/fleet");
    expect(item?.searchTerms).toEqual(
      expect.arrayContaining(["acme/fleet", "fleet", "/Users/dev/Code/p/fleet"]),
    );
    expect(iconTitles).toEqual(["fleet"]);
  });
});

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("orders title matches by recent activity before older prefix matches", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old-prefix"),
        title: "Convex InvalidCursor in Convex threads query",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-title"),
        title: "Disable Convex schema validation",
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-content"),
        title: "Fix schema validation",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectTitleById: new Map([[PROJECT_ID, "SpecWithCode"]]),
      sortOrder: "created_at",
      icon: null,
      getContentMatch: (thread) =>
        thread.id === ThreadId.make("recent-content")
          ? { source: "user", snippet: "Please check Convex", query: "convex" }
          : undefined,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "convex",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:recent-title",
      "thread:old-prefix",
      "thread:recent-content",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("keeps accent-insensitive setting results", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "thè\u{1ab0}mes",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [
        {
          kind: "action",
          value: "setting:theme",
          searchTerms: ["Themes", "Appearance"],
          title: "Themes",
          icon: null,
          run: async () => undefined,
        },
      ],
      threadSearchItems: [],
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual(["setting:theme"]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search" })],
      projectTitleById: new Map([[PROJECT_ID, "SpecWithCode"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("SpecWithCode · #feat/search");
  });

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectTitleById: new Map([[PROJECT_ID, "SpecWithCode"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${idThread.id}` }),
    ]);
  });

  it("prefers renderDescription when provided", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ branch: "feat/search", worktreePath: "/tmp/wt" })],
      projectTitleById: new Map([[PROJECT_ID, "SpecWithCode"]]),
      sortOrder: "updated_at",
      icon: null,
      renderDescription: (thread, { projectTitle }) =>
        `${projectTitle}:${thread.branch}:${thread.worktreePath ? "wt" : "local"}`,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("SpecWithCode:feat/search:wt");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("filterCommandPaletteGroups", () => {
  it("sorts secondary settings results after other matches", () => {
    const item = (value: string, title: string, secondary?: boolean) =>
      ({
        kind: "action",
        value,
        title,
        searchTerms: [title, "General"],
        icon: null,
        run: async () => undefined,
        ...(secondary ? { secondary } : {}),
      }) satisfies CommandPaletteActionItem;
    const [group] = filterCommandPaletteGroups({
      activeGroups: [],
      query: "model",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [
        item("setting:keybinding-modelPicker.toggle", "Model Picker: Toggle", true),
        item("setting:default-model", "Default model"),
      ],
      threadSearchItems: [],
    });
    expect(group?.items.map((entry) => entry.value)).toEqual([
      "setting:default-model",
      "setting:keybinding-modelPicker.toggle",
    ]);
  });
});

describe("root Projects group", () => {
  const item = (value: string, title = value): CommandPaletteActionItem => ({
    kind: "action",
    value,
    title,
    searchTerms: [title],
    icon: null,
    run: async () => undefined,
  });
  const projects = Array.from({ length: 10 }, (_, index) =>
    item(`project:local:p${index}`, `Project ${index}`),
  );
  const actions = [item("action:new-thread", "New thread")];
  const recentThreads = [item("thread:t1", "Fix login")];
  const rootGroups = buildRootGroups({
    projectItems: projects,
    actionItems: actions,
    recentThreadItems: recentThreads,
  });
  const filter = (query: string) =>
    filterCommandPaletteGroups({
      activeGroups: rootGroups,
      query,
      isInSubmenu: false,
      projectSearchItems: projects,
      settingsSearchItems: [],
      threadSearchItems: recentThreads,
    });

  it("lists projects first, capped, then actions and recent threads", () => {
    expect(rootGroups.map((group) => group.value)).toEqual([
      "projects",
      "actions",
      "recent-threads",
    ]);
    expect(rootGroups[0]?.label).toBe("Projects");
    expect(rootGroups[0]?.items).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(rootGroups[0]?.items.map((entry) => entry.value)).toEqual(
      projects.slice(0, RECENT_PROJECT_LIMIT).map((entry) => entry.value),
    );
  });

  it("shows no Projects group when there are no projects", () => {
    const groups = buildRootGroups({
      projectItems: [],
      actionItems: actions,
      recentThreadItems: recentThreads,
    });
    expect(groups.map((group) => group.value)).toEqual(["actions", "recent-threads"]);
  });

  it("opens with the first project highlighted on an empty query", () => {
    const groups = filter("");
    expect(groups.map((group) => group.value)).toEqual(["projects", "actions", "recent-threads"]);
    expect(buildCommandPaletteRows(groups).itemValues[0]).toBe("project:local:p0");
  });

  it("lists matching projects once, in the search group, while typing", () => {
    const groups = filter("project 9");
    expect(groups.map((group) => group.value)).toEqual(["projects-search"]);
    expect(groups[0]?.items.map((entry) => entry.value)).toEqual(["project:local:p9"]);
    expect(filter("project").filter((group) => group.label === "Projects")).toHaveLength(1);
  });

  it("keeps the > prefix to actions only", () => {
    expect(filter(">").map((group) => group.value)).toEqual(["actions"]);
    expect(filter(">new").map((group) => group.value)).toEqual(["actions"]);
  });
});

describe("orderProjectsForPalette", () => {
  const order = (input: {
    keys: string[];
    contextualKey: string | null;
    activity: Record<string, number>;
  }) =>
    orderProjectsForPalette({
      items: input.keys,
      keyOf: (key) => key,
      contextualKey: input.contextualKey,
      latestActivityByKey: new Map(Object.entries(input.activity)),
    });

  it("puts the current project first, then newest activity, then sidebar order", () => {
    expect(
      order({
        keys: ["a", "b", "c", "d", "e"],
        contextualKey: "d",
        activity: { b: 100, e: 300, d: 50, x: 999 },
      }),
    ).toEqual(["d", "e", "b", "a", "c"]);
  });

  it("keeps sidebar order when nothing has activity and there is no current project", () => {
    expect(order({ keys: ["c", "a", "b"], contextualKey: null, activity: {} })).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("orders projects by their newest non-archived thread", () => {
    const environmentId = EnvironmentId.make("local");
    const thread = (projectId: string, at: string, archivedAt: string | null = null) => ({
      environmentId,
      projectId: ProjectId.make(projectId),
      createdAt: at,
      updatedAt: at,
      latestUserMessageAt: at,
      archivedAt,
    });
    const activity = latestThreadActivityByProjectKey([
      thread("web", "2026-11-01T10:00:00.000Z"),
      thread("web", "2026-11-03T10:00:00.000Z"),
      thread("api", "2026-11-02T10:00:00.000Z"),
      thread("docs", "2026-11-05T10:00:00.000Z", "2026-11-06T10:00:00.000Z"),
    ]);
    expect(activity.get("local:web")).toBe(Date.parse("2026-11-03T10:00:00.000Z"));
    expect(activity.has("local:docs")).toBe(false);
    expect(
      orderProjectsForPalette({
        items: ["local:docs", "local:api", "local:web"],
        keyOf: (key) => key,
        contextualKey: null,
        latestActivityByKey: activity,
      }),
    ).toEqual(["local:web", "local:api", "local:docs"]);
  });
});

describe("buildRootProjectItems", () => {
  it("counts every member of a grouped project and keeps the current project first", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("studio-mac");
    const ref = (environmentId: EnvironmentId, id: string) => ({
      environmentId,
      id: ProjectId.make(id),
    });
    const projects = [ref(local, "docs"), ref(local, "web"), ref(local, "api")];
    const items = projects.map((project): CommandPaletteActionItem => ({
      kind: "action",
      value: `project:${project.environmentId}:${project.id}`,
      title: project.id,
      searchTerms: [project.id],
      icon: null,
      run: async () => undefined,
    }));
    const thread = (environmentId: EnvironmentId, projectId: string, at: string) => ({
      environmentId,
      projectId: ProjectId.make(projectId),
      createdAt: at,
      updatedAt: at,
      latestUserMessageAt: at,
      archivedAt: null,
    });
    const ordered = buildRootProjectItems({
      projects,
      items,
      // "web" is also cloned on another machine, where its newest thread lives.
      groupByKey: new Map([
        ["local:web", { memberProjects: [ref(local, "web"), ref(remote, "web-clone")] }],
      ]),
      contextualProject: ref(local, "api"),
      threads: [
        thread(local, "docs", "2026-11-02T10:00:00.000Z"),
        thread(remote, "web-clone", "2026-11-04T10:00:00.000Z"),
      ],
    });
    expect(ordered.map((entry) => entry.value)).toEqual([
      "project:local:api",
      "project:local:web",
      "project:local:docs",
    ]);
  });
});

describe("virtualized command palette rows", () => {
  const action = (value: string, disabled = false): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [],
    title: value,
    icon: null,
    ...(disabled ? { disabled } : {}),
    run: async () => {},
  });
  const groups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: [action("new-thread"), action("offline", true)] },
    { value: "threads", label: "Threads", items: [action("thread-a"), action("thread-b")] },
  ];

  it("keeps group order and headings while indexing only enabled items", () => {
    const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(groups);

    expect(rows.map((row) => (row.kind === "label" ? `# ${row.label}` : row.key))).toEqual([
      "# Actions",
      "actions:new-thread",
      "actions:offline",
      "# Threads",
      "threads:thread-a",
      "threads:thread-b",
    ]);
    expect(itemValues).toEqual(["new-thread", "thread-a", "thread-b"]);
    expect(rowIndexByItemIndex).toEqual([1, 4, 5]);
    expect(rows.flatMap((row) => (row.kind === "item" ? [row.itemIndex] : []))).toEqual([
      0,
      null,
      1,
      2,
    ]);
  });

  it("resolves Enter to the highlighted item without needing its row mounted", () => {
    expect(findHighlightedCommandPaletteItem(groups, "thread-b")?.value).toBe("thread-b");
    expect(findHighlightedCommandPaletteItem(groups, "offline")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, null)).toBeNull();
  });
});

describe("collapseRestartedBrowsePath", () => {
  it("keeps the path the user started over with after the prefilled ~/", () => {
    expect(collapseRestartedBrowsePath("~/~/Projects/app")).toBe("~/Projects/app");
    expect(collapseRestartedBrowsePath("~//Users/me/app")).toBe("/Users/me/app");
    expect(collapseRestartedBrowsePath("~/code/C:\\Users\\me")).toBe("C:\\Users\\me");
    expect(collapseRestartedBrowsePath("~/Projects/app")).toBe("~/Projects/app");
    expect(collapseRestartedBrowsePath("https://github.com/o/r")).toBe("https://github.com/o/r");
  });
});

it("retains an explicit machine through the add-project intent", () => {
  const target = "remote" as import("@specweave-studio/contracts").EnvironmentId;
  expect(
    reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null },
      { _tag: "OpenAddProject", environmentId: target },
    ).openIntent,
  ).toEqual({ kind: "add-project", environmentId: target });
});
