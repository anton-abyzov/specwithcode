import { expect, it, vi } from "vite-plus/test";
import { coordinatorDeviceHandoff } from "./coordinatorDeviceHandoff";
const target = {
  environmentId: "m1",
  projectId: "project",
  selection: { instanceId: "codex", model: "chosen" },
} as any;
it("stages transcript, selected native model and branch instead of starting a project worker", async () => {
  const open = vi.fn().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  expect(await coordinatorDeviceHandoff(open, target, "Existing conversation", "feature")).toBe(
    true,
  );
  expect(open).toHaveBeenCalledWith(
    { environmentId: "m1", projectId: "project" },
    { prompt: "Existing conversation", model: target.selection, branch: "feature" },
  );
});
it("only legacy or Scratch continuation can use the direct native start", async () => {
  expect(
    await coordinatorDeviceHandoff(
      vi.fn().mockResolvedValue({ kind: "standalone" }),
      target,
      "Context",
      null,
    ),
  ).toBe(false);
  await expect(
    coordinatorDeviceHandoff(
      vi.fn().mockResolvedValue({ kind: "unavailable" }),
      target,
      "Context",
      null,
    ),
  ).rejects.toThrow("current thread is unchanged");
});
