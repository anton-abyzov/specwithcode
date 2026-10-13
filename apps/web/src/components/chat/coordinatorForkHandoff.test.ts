import { beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ threads: [] as any[], coordinator: "coordinator" }));
vi.mock("~/state/entities", () => ({
  readProjects: () => [
    {
      environmentId: "m1",
      id: "project",
      workspaceSettings: { coordinatorThreadId: state.coordinator },
    },
  ],
  readThreadShell: (ref: any) => state.threads.find((t) => t.id === ref.threadId) ?? null,
}));
import { coordinatorForkHandoff } from "./coordinatorForkHandoff";
const input = { sourceThreadId: "worker", runId: "run-123" } as any;
beforeEach(() => {
  state.threads = [
    {
      id: "worker",
      environmentId: "m1",
      projectId: "project",
      createdBy: "agent",
      title: "Worker",
      branch: "feature",
      worktreePath: "/tree",
      lineage: { relationshipToParent: null },
      forkedFrom: null,
    },
  ];
});
it("stages exact source thread, run and workspace context without making a worker", async () => {
  const open = vi.fn().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  expect(await coordinatorForkHandoff(open, "m1" as any, input)).toBe(true);
  expect(open).toHaveBeenCalledWith(
    { environmentId: "m1", projectId: "project" },
    expect.objectContaining({
      prompt: expect.stringContaining("studio://thread/m1/worker"),
      branch: "feature",
      worktreePath: "/tree",
    }),
  );
  expect(open.mock.calls[0]?.[1].prompt).toContain("Source run: run-123");
});
it("keeps independent and legacy forks on their original workflow", async () => {
  const open = vi.fn().mockResolvedValue({ kind: "standalone" });
  expect(await coordinatorForkHandoff(open, "m1" as any, input)).toBe(false);
  open.mockClear();
  state.threads[0].createdBy = "user";
  expect(await coordinatorForkHandoff(open, "m1" as any, input)).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
it("does not fall through to native creation if a project handoff fails", async () => {
  expect(
    await coordinatorForkHandoff(
      vi.fn().mockResolvedValue({ kind: "unavailable" }),
      "m1" as any,
      input,
    ),
  ).toBe(true);
});

it("uses the owning ancestor project when a native subagent is stored in Scratch", async () => {
  state.threads.push({
    ...state.threads[0],
    id: "native-child",
    projectId: "scratch",
    lineage: { parentThreadId: "worker", relationshipToParent: "subagent", rootThreadId: "worker" },
  });
  const open = vi.fn().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  expect(
    await coordinatorForkHandoff(open, "m1" as any, { ...input, sourceThreadId: "native-child" }),
  ).toBe(true);
  expect(open).toHaveBeenCalledWith(
    { environmentId: "m1", projectId: "project" },
    expect.objectContaining({ prompt: expect.stringContaining("studio://thread/m1/native-child") }),
  );
});

it.each(["project", "scratch"])(
  "keeps a native %s subagent fork under its independent human chat",
  async (projectId) => {
    state.threads[0].createdBy = "user";
    state.threads.push({
      ...state.threads[0],
      id: "native-child",
      createdBy: "agent",
      projectId,
      lineage: {
        parentThreadId: "worker",
        relationshipToParent: "subagent",
        rootThreadId: "worker",
      },
    });
    const open = vi.fn().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
    expect(
      await coordinatorForkHandoff(open, "m1" as any, { ...input, sourceThreadId: "native-child" }),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  },
);
