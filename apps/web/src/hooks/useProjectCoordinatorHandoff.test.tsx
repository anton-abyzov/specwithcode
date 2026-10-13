import { beforeEach, expect, it, vi } from "vite-plus/test";
const runtime = vi.hoisted(() => ({
  legacy: false,
  configsReady: true,
  update: vi.fn(),
  projects: [] as any[],
  navigate: vi.fn(),
  enqueue: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("react", () => ({ useCallback: (fn: any) => fn }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map(runtime.configsReady ? [["m1", { scratchWorkspaceRoot: "/scratch" }]] : []),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: runtime.navigate }) }));
vi.mock("./useSettings", () => ({
  useLegacySidebarEnabled: () => runtime.legacy,
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => runtime.update }));
vi.mock("../state/projects", () => ({ projectEnvironment: { update: "update" } }));
vi.mock("../state/entities", () => ({ readProjects: () => runtime.projects }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../studio/projectCoordinatorDraft", async (original) => ({
  ...(await original<typeof import("../studio/projectCoordinatorDraft")>()),
  enqueueProjectCoordinatorDraft: runtime.enqueue,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: runtime.toast } }));
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@specweave-studio/contracts";
import {
  projectCoordinatorHandoffText,
  useProjectCoordinatorHandoff,
} from "./useProjectCoordinatorHandoff";
const projectRef = {
  environmentId: EnvironmentId.make("m1"),
  projectId: ProjectId.make("project"),
};
beforeEach(() => {
  runtime.legacy = false;
  runtime.configsReady = true;
  runtime.update.mockReset().mockResolvedValue({ _tag: "Success" });
  runtime.projects = [
    { ...projectRef, id: projectRef.projectId, workspaceRoot: "/repo", title: "Project" },
  ];
  runtime.navigate.mockReset().mockResolvedValue(undefined);
  runtime.enqueue.mockClear();
  runtime.toast.mockClear();
});
it.each(["worktree", "local"] as const)(
  "stages review context and %s intent on the exact project without starting work",
  async (mode) => {
    const task = {
      url: "https://github.com/a/b/pull/1",
      prompt: "Fix findings",
      mode,
      reviewComments: [
        {
          id: "finding",
          sectionId: "review",
          sectionTitle: "Finding",
          filePath: "src/a.ts",
          startIndex: 1,
          endIndex: 1,
          rangeLabel: "L2",
          text: "Wrong value",
          diff: "+bad()",
        },
      ],
    };
    expect(await useProjectCoordinatorHandoff()(projectRef, task)).toMatchObject({
      kind: "opened",
    });
    expect(runtime.enqueue).toHaveBeenCalledWith({
      ...projectRef,
      text: projectCoordinatorHandoffText(task),
    });
    const text = runtime.enqueue.mock.calls[0]?.[0].text;
    expect(text).toContain(task.url);
    expect(text).toContain("Wrong value");
    expect(text).toContain("+bad()");
    expect(text).toContain(mode === "worktree" ? "own worktree" : "this checkout");
    expect(runtime.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/projects/$projectKey", search: { checkout: "m1:project" } }),
    );
  },
);
it("leaves legacy and No project handoffs on their existing workflow", async () => {
  runtime.legacy = true;
  expect(await useProjectCoordinatorHandoff()(projectRef, { prompt: "Task" })).toEqual({
    kind: "standalone",
  });
  runtime.legacy = false;
  runtime.projects[0].workspaceRoot = "/scratch";
  expect(await useProjectCoordinatorHandoff()(projectRef, { prompt: "Task" })).toEqual({
    kind: "standalone",
  });
  expect(runtime.enqueue).not.toHaveBeenCalled();
  expect(runtime.navigate).not.toHaveBeenCalled();
});
it("keeps queued context available after navigation fails", async () => {
  runtime.navigate.mockRejectedValue(new Error("route unavailable"));
  expect(await useProjectCoordinatorHandoff()(projectRef, { prompt: "Keep this" })).toEqual({
    kind: "unavailable",
  });
  expect(runtime.enqueue).toHaveBeenCalledWith({ ...projectRef, text: "Keep this" });
  expect(runtime.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Could not open the coordinator" }),
  );
});

it("saves the chosen coordinator model before opening its project", async () => {
  const model = { instanceId: ProviderInstanceId.make("codex"), model: "chosen" };
  runtime.projects[0].workspaceSettings = { revision: 3, coordinatorThreadId: "retained" };
  expect(await useProjectCoordinatorHandoff()(projectRef, { model })).toEqual({
    kind: "opened",
    threadId: "retained",
  });
  expect(runtime.update).toHaveBeenCalledWith({
    environmentId: "m1",
    input: {
      projectId: "project",
      workspaceSettings: { expectedRevision: 3, coordinatorModelSelection: model },
    },
  });
  expect(runtime.update.mock.invocationCallOrder[0]).toBeLessThan(
    runtime.navigate.mock.invocationCallOrder[0]!,
  );
});
it("does not navigate or claim success if the model save conflicts", async () => {
  runtime.update.mockResolvedValue({ _tag: "Failure" });
  expect(
    await useProjectCoordinatorHandoff()(projectRef, {
      model: { instanceId: ProviderInstanceId.make("codex"), model: "chosen" },
    }),
  ).toEqual({ kind: "unavailable" });
  expect(runtime.navigate).not.toHaveBeenCalled();
});
it("waits for machine identity before classifying a cached Scratch project", async () => {
  runtime.configsReady = false;
  runtime.projects[0].workspaceRoot = "/scratch";
  expect(await useProjectCoordinatorHandoff()(projectRef)).toEqual({ kind: "unavailable" });
  expect(runtime.navigate).not.toHaveBeenCalled();
});
