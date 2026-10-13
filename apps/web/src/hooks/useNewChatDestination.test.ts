import { beforeEach, expect, it, vi } from "vite-plus/test";
const runtime = vi.hoisted(() => ({ coordinator: vi.fn(), draft: vi.fn() }));
vi.mock("react", () => ({ useCallback: (fn: any) => fn }));
vi.mock("./useProjectCoordinatorHandoff", () => ({
  useProjectCoordinatorHandoff: () => runtime.coordinator,
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => runtime.draft }));
import { openBackgroundChatComposer, useNewChatDestination } from "./useNewChatDestination";
import { handleDesktopAppActivationRequest } from "../desktopAppActivation";
const ref = { environmentId: "m1", projectId: "project" } as any;
beforeEach(() => {
  runtime.coordinator.mockReset();
  runtime.draft.mockReset().mockResolvedValue({ draftId: "draft", threadId: "thread" });
});
it("acknowledges a coordinator without pretending it created a draft", async () => {
  runtime.coordinator.mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  expect(await useNewChatDestination()(ref, { branch: "feature", worktreePath: "/tree" })).toEqual({
    kind: "coordinator",
    threadId: "coordinator",
  });
  expect(runtime.coordinator).toHaveBeenCalledWith(ref, {
    branch: "feature",
    worktreePath: "/tree",
    model: undefined,
  });
  expect(runtime.draft).not.toHaveBeenCalled();
});
it("creates drafts only for standalone destinations and reports failure explicitly", async () => {
  runtime.coordinator.mockResolvedValue({ kind: "standalone" });
  expect(await useNewChatDestination()(ref)).toEqual({
    kind: "draft",
    draftId: "draft",
    threadId: "thread",
  });
  runtime.coordinator.mockResolvedValue({ kind: "unavailable" });
  expect(await useNewChatDestination()(ref)).toEqual({ kind: "unavailable" });
  expect(runtime.draft).toHaveBeenCalledTimes(1);
});
it("desktop folder activation acknowledges the opened coordinator as success", async () => {
  runtime.coordinator.mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  const open = useNewChatDestination();
  const response = await handleDesktopAppActivationRequest(
    {
      version: 1,
      requestId: "request",
      type: "open-workspace",
      workspaceRoot: "/repo",
      platform: "darwin",
    },
    {
      getTarget: () => ({ environmentId: ref.environmentId, platform: "darwin" }),
      findProject: () => ({ ...ref, id: ref.projectId, workspaceRoot: "/repo" }),
      createProject: vi.fn(),
      waitForProject: vi.fn(),
      openThread: async (project) => {
        const result = await open(project);
        return result.kind === "unavailable" ? null : { threadId: result.threadId };
      },
    },
  );
  expect(response).toMatchObject({ ok: true, projectId: "project", threadId: "coordinator" });
  expect(runtime.draft).not.toHaveBeenCalled();
});

it.each(["coordinator", "draft", "unavailable"] as const)(
  "background composer opening reports %s accurately",
  async (kind) => {
    const open = vi.fn().mockResolvedValue({ kind });
    expect(await openBackgroundChatComposer(open, ref, {})).toBe(kind !== "unavailable");
  },
);
