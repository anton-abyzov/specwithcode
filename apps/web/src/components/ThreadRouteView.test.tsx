// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  legacy: false,
  ancestors: [] as any[],
  shell: null as any,
  draft: null as any,
  composer: null as any,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../hooks/useSettings", () => ({ useLegacySidebarEnabled: () => state.legacy }));
vi.mock("./settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    {
      projectKey: "atlas",
      memberProjects: [
        {
          environmentId: "remote",
          id: "project",
          workspaceRoot: "/repo",
          workspaceSettings: { coordinatorThreadId: "coordinator" },
        },
      ],
    },
  ],
}));
vi.mock("./ChatView", () => ({ default: () => <div data-native-chat="">Native chat</div> }));
vi.mock("./ChatView.logic", () => ({
  threadHasStarted: () => false,
  resolveDraftPromotionNavigationTarget: () => null,
}));
vi.mock("./chat/draftHeroTransition", () => ({
  waitForDraftHeroTransition: () => Promise.resolve(),
}));
vi.mock("./ui/sidebar", () => ({ SidebarInset: ({ children }: any) => <div>{children}</div> }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: any) =>
    select({
      getDraftSession: () => state.draft,
      getComposerDraft: () => state.composer,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  composerDraftHasUserContent: (draft: any) => Boolean(draft?.prompt),
  useBackgroundDraftSubmissionPending: () => false,
  markPromotedDraftThreadByRef: vi.fn(),
  finalizePromotedDraftThreadByRef: vi.fn(),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: { getState: () => ({ clearPendingFileDropsForThread: vi.fn() }) },
}));
vi.mock("../state/entities", () => ({
  useServerConfigs: () => new Map([["remote", { scratchWorkspaceRoot: "/scratch" }]]),
  useThreadShells: () => state.ancestors,
  useEnvironmentThreadRefs: () => [],
  useThreadRefs: () => [],
  useThreadShell: () => state.shell,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: { _tag: "Some" } } }),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../threadRoutes", () => ({
  buildThreadRouteParams: (ref: any) => ref,
  resolveThreadRouteRenderState: () => "ready",
}));
import { ThreadRouteView } from "./ThreadRouteView";
let root: Root, container: HTMLDivElement;
const environmentId = EnvironmentId.make("remote"),
  projectId = ProjectId.make("project");
async function render(id = "coordinator", createdBy: "agent" | "user" = "user") {
  state.shell = {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    createdBy,
    deletedAt: null,
    lineage: { parentThreadId: null, rootThreadId: id, relationshipToParent: null },
    forkedFrom: null,
  };
  await act(async () =>
    root.render(
      <ThreadRouteView
        target={{ kind: "server", threadRef: { environmentId, threadId: ThreadId.make(id) } }}
      />,
    ),
  );
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.navigate.mockClear();
  state.legacy = false;
  state.draft = null;
  state.composer = null;
  state.shell = null;
  state.ancestors = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("routes a direct coordinator link to the exact project checkout without showing a standalone chat", async () => {
  await render();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/projects/$projectKey",
    params: { projectKey: "atlas" },
    search: { checkout: "remote:project" },
    replace: true,
  });
  expect(container.querySelector("[data-native-chat]")).toBeNull();
});
it("routes a direct worker link to the side pane", async () => {
  await render("worker", "agent");
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/projects/$projectKey",
    params: { projectKey: "atlas" },
    search: { checkout: "remote:project", thread: "worker" },
    replace: true,
  });
});
it("keeps a human chat sharing the directory full-page", async () => {
  await render("manual", "user");
  expect(state.navigate).not.toHaveBeenCalled();
  expect(container.querySelector("[data-native-chat]")).not.toBeNull();
});
it("preserves legacy full-page coordinator navigation", async () => {
  state.legacy = true;
  await render();
  expect(state.navigate).not.toHaveBeenCalled();
  expect(container.querySelector("[data-native-chat]")).not.toBeNull();
});
it("leaves historical coordinators available on their original page", async () => {
  await render("project-coordinator:project", "agent");
  expect(state.navigate).not.toHaveBeenCalled();
  expect(container.querySelector("[data-native-chat]")).not.toBeNull();
});

it.each([false, true])(
  "redirects an empty project draft but preserves an invested draft (%s)",
  async (invested) => {
    state.draft = {
      environmentId,
      projectId,
      threadId: ThreadId.make("reserved"),
      promotedTo: null,
      branch: null,
      worktreePath: null,
    };
    state.composer = { prompt: invested ? "Keep my draft" : "" };
    await act(async () =>
      root.render(<ThreadRouteView target={{ kind: "draft", draftId: "old-draft" as any }} />),
    );
    if (invested) {
      expect(state.navigate).not.toHaveBeenCalled();
      expect(container.querySelector("[data-native-chat]")).not.toBeNull();
    } else {
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectKey",
        params: { projectKey: "atlas" },
        search: { checkout: "remote:project" },
        replace: true,
      });
      expect(container.querySelector("[data-native-chat]")).toBeNull();
    }
  },
);

it("moves a human-created fork beside its coordinator when its agent ancestor arrives", async () => {
  const fork = ThreadId.make("fork");
  state.shell = {
    id: fork,
    environmentId,
    projectId,
    createdBy: "user",
    deletedAt: null,
    lineage: { parentThreadId: "late-worker", relationshipToParent: "fork" },
    forkedFrom: null,
  };
  const renderFork = () =>
    root.render(
      <ThreadRouteView target={{ kind: "server", threadRef: { environmentId, threadId: fork } }} />,
    );
  await act(async () => renderFork());
  expect(state.navigate).not.toHaveBeenCalled();
  state.ancestors = [{ id: "late-worker", environmentId, projectId, createdBy: "agent" }];
  await act(async () => renderFork());
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/projects/$projectKey",
    params: { projectKey: "atlas" },
    search: { checkout: "remote:project", thread: fork },
    replace: true,
  });
});
