import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@specweave-studio/contracts";

const fixture = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  settings: {} as ServerSettings,
  openScratch: vi.fn(),
  query: vi.fn(),
  subscribe: vi.fn(),
  toast: vi.fn(),
  router: {
    state: {
      location: { href: "/" },
      matches: [{ params: {} as { draftId?: string } }],
    },
    navigate: vi.fn(async (request: { params: { draftId: string } }) => {
      fixture.router.state.location.href = `/draft/${request.params.draftId}`;
      fixture.router.state.matches = [{ params: request.params }];
    }),
  },
}));

// Keep the caller, normal draft handler, settings/default resolution, identity
// helpers and draft store real. Only the React host and transport are isolated.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map(
      fixture.projects.map((project) => [project.environmentId, { settings: fixture.settings }]),
    ),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => fixture.router,
}));
vi.mock("../state/entities", () => ({
  readProjects: () => fixture.projects,
  readThreadShell: () => null,
  useProjects: () => fixture.projects,
  useThreadShell: () => null,
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../state/projects", () => ({
  projectEnvironment: { openScratch: "open-scratch", folderCheck: "folder-check" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    // The new-thread handler reads a project's folder layout only for an unconfigured Git folder.
    if (command === "folder-check") return async () => ({ _tag: "Failure" });
    if (command !== "open-scratch") throw new Error("Unexpected server command");
    return fixture.openScratch;
  },
}));
vi.mock("../components/ui/toast", () => ({
  toastManager: { add: fixture.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: (cwd: string) => cwd,
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({
  useLegacySidebarEnabled: () => true,
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../lib/studioProjectFileDefaults", () => ({
  readStudioProjectFile: () => {
    throw new Error("Configured drafts must not read project files");
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (failure: unknown) => failure,
  executeAtomQuery: fixture.query,
  followStreamInEnvironment: () => {
    throw new Error("Unexpected live subscription");
  },
}));
vi.mock("@specweave-studio/client-runtime/rpc", () => ({ subscribe: fixture.subscribe }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: { atom: (effect: unknown) => effect },
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

const primaryHost = EnvironmentId.make("primary-host");
const requestedHost = EnvironmentId.make("requested-worker");
function project(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  };
}
const primaryScratch = project(primaryHost, "primary-scratch", "/primary/studio/scratch");
const scratch = project(requestedHost, "server-returned-scratch", "/worker/studio/scratch");
const gitProject = project(requestedHost, "git-project", "/worker/repository");

function resetStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    rewindingThreadKeys: new Set(),
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  fixture.projects = [primaryScratch, scratch, gitProject];
  fixture.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    defaultThreadEnvMode: "worktree",
    newWorktreesStartFromOrigin: true,
  };
  fixture.router.state.location.href = "/";
  fixture.router.state.matches = [{ params: {} }];
  fixture.openScratch.mockImplementation(
    async ({ environmentId }: { environmentId: EnvironmentId }) => {
      expect(environmentId).toBe(requestedHost);
      return { _tag: "Success", value: scratch };
    },
  );
});
afterEach(resetStore);

describe("No project drafts with a global worktree default", () => {
  it("creates a local, unsubmitted draft for the exact scratch project on the requested host", async () => {
    const opened = await useScratchProject().startScratchThread(requestedHost);

    expect(fixture.openScratch).toHaveBeenCalledExactlyOnceWith({
      environmentId: requestedHost,
      input: {},
    });
    const draftId = fixture.router.state.matches[0]!.params.draftId!;
    expect(opened).toMatchObject({ draftId });
    const store = useComposerDraftStore.getState();
    expect(store.draftThreadsByThreadKey[draftId]).toMatchObject({
      environmentId: requestedHost,
      projectId: scratch.id,
      envMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
    });
    expect(store.draftThreadsByThreadKey[draftId]?.promotedTo).toBeNull();
    expect(store.backgroundSubmissionThreadKeys).toEqual({});
    expect(Object.keys(store.draftThreadsByThreadKey)).toEqual([draftId]);
    expect(fixture.query).not.toHaveBeenCalled();
    expect(fixture.subscribe).not.toHaveBeenCalled();
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it("reuses an empty scratch draft as local without importing another project's workspace", async () => {
    // Reproduce an empty draft created before this fix inherited worktree mode.
    const existing = await useNewThreadHandler()(scopeProjectRef(requestedHost, scratch.id));
    expect(existing).not.toBeNull();
    const other = await useNewThreadHandler()(scopeProjectRef(requestedHost, gitProject.id), {
      envMode: "worktree",
      branch: "feature/keep",
      worktreePath: "/worker/worktrees/keep",
      startFromOrigin: true,
    });
    const otherBefore = useComposerDraftStore.getState().getDraftSession(other!.draftId);

    await useScratchProject().startScratchThread(requestedHost);

    const store = useComposerDraftStore.getState();
    expect(fixture.router.state.matches[0]!.params.draftId).toBe(existing!.draftId);
    expect(store.getDraftSession(existing!.draftId)).toMatchObject({
      threadId: existing!.threadId,
      environmentId: requestedHost,
      projectId: scratch.id,
      envMode: "local",
      branch: null,
      worktreePath: null,
      promotedTo: null,
    });
    expect(store.getDraftSession(other!.draftId)).toEqual(otherBefore);
    expect(store.backgroundSubmissionThreadKeys).toEqual({});
    expect(Object.keys(store.draftThreadsByThreadKey)).toHaveLength(2);
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it.each([undefined, "local", "worktree"] as const)(
    "preserves normal project workspace selection %s",
    async (envMode) => {
      const opened = await useNewThreadHandler()(
        scopeProjectRef(requestedHost, gitProject.id),
        envMode === undefined ? undefined : { envMode },
      );
      expect(useComposerDraftStore.getState().getDraftSession(opened!.draftId)).toMatchObject({
        environmentId: requestedHost,
        projectId: gitProject.id,
        envMode: envMode ?? "worktree",
        startFromOrigin: envMode !== "local",
      });
      expect(fixture.openScratch).not.toHaveBeenCalled();
    },
  );
});

function deferredScratch(project: EnvironmentProject) {
  let complete!: () => void;
  const promise = new Promise<{ _tag: "Success"; value: EnvironmentProject }>((resolve) => {
    complete = () => resolve({ _tag: "Success", value: project });
  });
  return { promise, complete };
}

describe("Scratch intent while the server opens its project", () => {
  it("preserves a newer route without creating or navigating to a stale draft", async () => {
    const deferred = deferredScratch(scratch);
    fixture.openScratch.mockReturnValueOnce(deferred.promise);
    fixture.router.state.location.href = "/threads/requested-old";
    const pending = useScratchProject().startScratchThread(requestedHost);

    fixture.router.state.location.href = "/threads/primary-new-choice";
    deferred.complete();
    await pending;

    expect(fixture.router.state.location.href).toBe("/threads/primary-new-choice");
    expect(fixture.router.navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
  });

  it("treats a newer location with the same href as newer navigation intent", async () => {
    const deferred = deferredScratch(scratch);
    fixture.openScratch.mockReturnValueOnce(deferred.promise);
    const pending = useScratchProject().startScratchThread(requestedHost);

    // Navigating away and back creates a new location even when the href matches.
    fixture.router.state.location = { ...fixture.router.state.location };
    deferred.complete();
    await pending;

    expect(fixture.router.navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().draftThreadsByThreadKey).toEqual({});
  });

  it.each(["older-first", "newer-first"] as const)(
    "keeps the latest Scratch host intent across hook instances when replies arrive %s",
    async (order) => {
      const older = deferredScratch(scratch);
      const newer = deferredScratch(primaryScratch);
      fixture.openScratch.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      const pendingOlder = useScratchProject().startScratchThread(requestedHost);
      const pendingNewer = useScratchProject().startScratchThread(primaryHost);
      let draftsAfterOlder = 0;
      if (order === "older-first") {
        older.complete();
        await pendingOlder;
        draftsAfterOlder = Object.keys(
          useComposerDraftStore.getState().draftThreadsByThreadKey,
        ).length;
        newer.complete();
        await pendingNewer;
      } else {
        newer.complete();
        await pendingNewer;
        older.complete();
        await pendingOlder;
      }

      expect(draftsAfterOlder).toBe(0);
      expect(fixture.openScratch.mock.calls).toEqual([
        [{ environmentId: requestedHost, input: {} }],
        [{ environmentId: primaryHost, input: {} }],
      ]);
      const store = useComposerDraftStore.getState();
      const draftId = fixture.router.state.matches[0]!.params.draftId!;
      expect(Object.keys(store.draftThreadsByThreadKey)).toEqual([draftId]);
      expect(store.draftThreadsByThreadKey[draftId]).toMatchObject({
        environmentId: primaryHost,
        projectId: primaryScratch.id,
        envMode: "local",
        worktreePath: null,
        branch: null,
        promotedTo: null,
      });
      expect(store.backgroundSubmissionThreadKeys).toEqual({});
      expect(fixture.router.navigate).toHaveBeenCalledOnce();
    },
  );
});
