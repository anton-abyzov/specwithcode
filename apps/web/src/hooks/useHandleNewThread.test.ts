import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@specweave-studio/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  type StoredDraft = {
    readonly draftId: string;
    readonly environmentId: string;
    readonly projectId?: string;
    readonly promotedTo: { environmentId: string; threadId: string } | null;
    readonly threadId: string;
    readonly envMode?: "local" | "worktree";
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
    readonly startFromOrigin?: boolean;
  };
  let storedDraft: StoredDraft | null = null;
  let explicitModelPick = false;
  type ActiveDraft = StoredDraft & {
    logicalProjectKey: string;
    runtimeMode: RuntimeMode;
    interactionMode: "default";
    createdAt: string;
  };
  let activeDraft: ActiveDraft | null = null;
  let currentRouteTarget: { kind: "draft"; draftId: string } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => activeDraft ?? storedDraft),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    setExplicitModelPick(value: boolean) {
      explicitModelPick = value;
    },
    get explicitModelPick() {
      return explicitModelPick;
    },
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
    get currentRouteTarget() {
      return currentRouteTarget;
    },
    setStoredDraft(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
    },
    setActiveDraft(nextActiveDraft: ActiveDraft | null) {
      activeDraft = nextActiveDraft;
    },
    openDraft(draftId: string) {
      currentRouteTarget = { kind: "draft", draftId };
      router.state.location.href = `/draft/${draftId}`;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      explicitModelPick = false;
      draftStore.applyStickyState.mockClear();
      draftStore.setModelSelection.mockClear();
      activeDraft = null;
      currentRouteTarget = null;
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : new Map([
          [
            "environment-primary",
            {
              settings: {
                ...testState.targetSettings,
                newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
              },
            },
          ],
          ["environment-ssh", { settings: testState.targetSettings }],
        ]),
}));
vi.mock("@specweave-studio/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@specweave-studio/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@specweave-studio/shared/projectSettings", () => ({
  // Environment settings pass through; the tests set project fields on the
  // project record, which the hook still honors until the server folds them.
  // With a file argument the env mode resolves like the real chain.
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => testState.explicitModelPick,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/newThreadWorkspaceDefault", () => ({
  readNewThreadWorkspaceDefault: vi.fn(
    async ({ configuredMode }: { configuredMode: "local" | "worktree" | null }) =>
      configuredMode ?? "worktree",
  ),
}));
vi.mock("../lib/studioProjectFileDefaults", () => ({
  readStudioProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.currentRouteTarget,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";
import { readNewThreadWorkspaceDefault } from "../lib/newThreadWorkspaceDefault";

function expectNoWorkspaceOverrides(options: Record<string, unknown>) {
  for (const key of ["envMode", "branch", "worktreePath", "startFromOrigin"]) {
    expect(options).not.toHaveProperty(key);
  }
}

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
      envMode: "local" as const,
      branch: "feature/chosen",
      worktreePath: null,
      startFromOrigin: false,
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("writes explicit host intent before navigation without suppressing configured workspace defaults", async () => {
    testState.reset(draft, { envMode: "worktree", startFromOrigin: true });
    const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
    const pendingOpen = useNewThreadHandler()(projectRef, { environmentSelection: "manual" });
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      opened!.draftId,
      expect.objectContaining({
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        ...(!draft ? { envMode: "worktree", startFromOrigin: true } : {}),
      }),
    );
    if (draft) {
      expectNoWorkspaceOverrides(
        testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
      );
    }
    expect(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.invocationCallOrder[0],
    ).toBeLessThan(testState.router.navigate.mock.invocationCallOrder[0]!);
  });

  it("does not add host intent for inherited automatic callers", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pendingOpen;
    const options = testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3];
    expect(options).not.toHaveProperty("environmentSelection");
    expect(options).not.toHaveProperty("loadBalancedEnvironmentId");
  });

  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "uses the target environment's %s permissions for new threads",
    async (runtimeMode) => {
      testState.reset(draft);
      testState.targetSettings.defaultRuntimeMode = runtimeMode;
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = useNewThreadHandler()(projectRef);
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ runtimeMode }),
      );
    },
  );

  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses new-thread origin defaults and preserves reused workspace context (%s)",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = openThread(projectRef);

      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).toEqual({
        draftId: draft?.draftId ?? "draft-delayed",
        threadId: draft?.threadId ?? "thread-delayed",
      });
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining(!draft ? { envMode: "worktree", startFromOrigin } : {}),
      );
      if (draft) {
        expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
          draft.draftId,
          expect.objectContaining({ runtimeMode: "full-access" }),
        );
        expectNoWorkspaceOverrides(testState.draftStore.setDraftThreadContext.mock.calls[0]![1]);
        expectNoWorkspaceOverrides(
          testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
        );
      }
    },
  );

  it.each([true, false])(
    "preserves an explicit start-from-origin choice of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;

      const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
    },
  );
});

describe("explicit host intent across draft reuse", () => {
  const storedDraft = {
    draftId: "draft-existing",
    environmentId: "environment-ssh",
    promotedTo: null,
    threadId: "thread-existing",
  } as const;
  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;

  it("pins the already-open empty draft without resetting its workspace", async () => {
    testState.reset(storedDraft);
    testState.openDraft(storedDraft.draftId);
    const opened = await useNewThreadHandler()(projectRef, { environmentSelection: "manual" });
    expect(opened?.draftId).toBe(storedDraft.draftId);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      storedDraft.draftId,
      expect.objectContaining({ environmentSelection: "manual", loadBalancedEnvironmentId: null }),
    );
    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });

  it("pins a raced winner before navigating and keeps explicit workspace options", async () => {
    testState.reset(null);
    const pendingOpen = useNewThreadHandler()(projectRef, {
      environmentSelection: "manual",
      branch: "feature/chosen",
      worktreePath: "/chosen/worktree",
    });
    testState.setStoredDraft(storedDraft);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;
    expect(opened?.draftId).toBe(storedDraft.draftId);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      storedDraft.draftId,
      expect.objectContaining({
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        branch: "feature/chosen",
        worktreePath: "/chosen/worktree",
      }),
    );
    expect(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.invocationCallOrder[0],
    ).toBeLessThan(testState.router.navigate.mock.invocationCallOrder[0]!);
  });

  it("pins the current-route empty draft even when its logical mapping is absent", async () => {
    testState.reset(null);
    testState.setActiveDraft({
      ...storedDraft,
      logicalProjectKey: "remote-project",
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-10-07T00:00:00Z",
    });
    testState.openDraft(storedDraft.draftId);
    const opened = await useNewThreadHandler()(projectRef, { environmentSelection: "manual" });
    expect(opened?.draftId).toBe(storedDraft.draftId);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      storedDraft.draftId,
      expect.objectContaining({
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        runtimeMode: "approval-required",
      }),
    );
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });
});

describe("Git-aware workspace default integration", () => {
  it("asks only the selected environment about an unconfigured project", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    const open = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { environmentSelection: "manual" },
    );
    testState.completeProjectFileRead(null);
    await open;
    expect(readNewThreadWorkspaceDefault).toHaveBeenLastCalledWith({
      configuredMode: null,
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
    });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenLastCalledWith(
      "remote-project",
      expect.objectContaining({ environmentId: "environment-ssh" }),
      "draft-delayed",
      expect.objectContaining({
        envMode: "worktree",
        branch: null,
        worktreePath: null,
        environmentSelection: "manual",
      }),
    );
  });
  it("preserves a reused workspace and explicit provider/model pick without querying defaults", async () => {
    const stored = {
      draftId: "draft-kept",
      threadId: "thread-kept",
      environmentId: "environment-ssh",
      promotedTo: null,
      envMode: "local" as const,
      branch: "feature/mine",
      worktreePath: null,
      startFromOrigin: false,
    };
    testState.reset(stored, { envMode: null, startFromOrigin: true });
    testState.setExplicitModelPick(true);
    vi.mocked(readNewThreadWorkspaceDefault).mockClear();
    await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    expect(readNewThreadWorkspaceDefault).not.toHaveBeenCalled();
    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
      stored.draftId,
      expect.objectContaining({ runtimeMode: "full-access" }),
    );
    expectNoWorkspaceOverrides(testState.draftStore.setDraftThreadContext.mock.calls[0]![1]);
    expectNoWorkspaceOverrides(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
    );
    expect(testState.draftStore.applyStickyState).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
    ).not.toHaveProperty("environmentSelection");
  });
  it("does not overwrite a raced winner with the newly observed Git default", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: true });
    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.setStoredDraft({
      draftId: "winner",
      threadId: "winner-thread",
      environmentId: "environment-ssh",
      promotedTo: null,
      envMode: "local",
      branch: "feature/winner",
      worktreePath: null,
      startFromOrigin: false,
    });
    testState.completeProjectFileRead(null);
    expect((await pending)?.draftId).toBe("winner");
    const write = testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3];
    for (const key of [
      "envMode",
      "branch",
      "worktreePath",
      "startFromOrigin",
      "environmentSelection",
    ])
      expect(write).not.toHaveProperty(key);
    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
  });
  it("does not query or replace an explicit current-checkout choice", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    vi.mocked(readNewThreadWorkspaceDefault).mockClear();
    await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { envMode: "local", branch: "feature/mine", environmentSelection: "manual" },
    );
    expect(readNewThreadWorkspaceDefault).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenLastCalledWith(
      "remote-project",
      expect.anything(),
      "draft-delayed",
      expect.objectContaining({
        envMode: "local",
        branch: "feature/mine",
        environmentSelection: "manual",
      }),
    );
  });
});

describe("reused draft workspace races", () => {
  const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
  const storedDraft = {
    draftId: "draft-existing",
    threadId: "thread-existing",
    environmentId: "environment-ssh",
    projectId: "project-remote",
    promotedTo: null,
    envMode: "worktree" as const,
    branch: "feature/OLD",
    worktreePath: "/host-A/worktrees/OLD",
    startFromOrigin: false,
  };

  it.each([
    { environmentId: "environment-primary", projectId: "project-remote" },
    { environmentId: "environment-ssh", projectId: "other-project" },
  ])(
    "leaves branch/path invalidation to the store when reusing from $environmentId/$projectId",
    async (source) => {
      testState.reset({ ...storedDraft, ...source });
      await useNewThreadHandler()(projectRef, { environmentSelection: "manual" });

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        projectRef,
        storedDraft.draftId,
        expect.objectContaining({
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
        }),
      );
      expectNoWorkspaceOverrides(testState.draftStore.setDraftThreadContext.mock.calls[0]![1]);
      expectNoWorkspaceOverrides(
        testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
      );
    },
  );

  it("never replays OLD context over a newer same-project workspace choice", async () => {
    testState.reset(storedDraft);
    const pending = useNewThreadHandler()(projectRef);
    const latest = {
      ...storedDraft,
      envMode: "local" as const,
      branch: "feature/NEW",
      worktreePath: "/host-A/worktrees/NEW",
      startFromOrigin: true,
    };
    testState.setStoredDraft(latest);
    expect((await pending)?.draftId).toBe(storedDraft.draftId);

    // Both writes must leave the authoritative store's new workspace alone.
    expectNoWorkspaceOverrides(testState.draftStore.setDraftThreadContext.mock.calls[0]![1]);
    expectNoWorkspaceOverrides(
      testState.draftStore.setLogicalProjectDraftThreadId.mock.calls[0]![3],
    );
    expect(testState.draftStore.getDraftSessionByLogicalProjectKey()).toEqual(latest);
  });

  it.each([
    { environmentId: "environment-primary" },
    { projectId: "project-new" },
    { threadId: "thread-new" },
    { promotedTo: { environmentId: "environment-ssh", threadId: "thread-promoted" } },
  ])("abandons a stale open when the same draft moved meanwhile: %j", async (newContext) => {
    testState.reset(storedDraft);
    const pending = useNewThreadHandler()(projectRef);
    testState.setStoredDraft({ ...storedDraft, ...newContext });
    expect(await pending).toBeNull();
    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
    expect(testState.router.navigate).not.toHaveBeenCalled();
  });

  it("honors an explicit destination workspace on a host change", async () => {
    testState.reset({ ...storedDraft, environmentId: "environment-primary" });
    const selected = {
      branch: "feature/host-B",
      worktreePath: "/host-B/worktrees/selected",
      envMode: "worktree" as const,
      startFromOrigin: true,
      environmentSelection: "manual" as const,
    };
    await useNewThreadHandler()(projectRef, selected);
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      storedDraft.draftId,
      expect.objectContaining(selected),
    );
  });
});
