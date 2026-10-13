import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
const fixture = vi.hoisted(() => ({ handoff: vi.fn(), newThread: vi.fn(), prepare: vi.fn() }));
vi.mock("~/hooks/useProjectCoordinatorHandoff", () => ({
  useProjectCoordinatorHandoff: () => fixture.handoff,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => fixture.newThread }));
vi.mock("~/lib/sourceControlActions", () => ({
  usePreparePullRequestThreadAction: () => ({ run: fixture.prepare }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: vi.fn(),
  useEnvironmentSettings: vi.fn(),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("~/state/entities", () => ({ useProjects: () => [] }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => "m1" }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), update: vi.fn() } }));
import { usePullRequestHandoffs } from "./usePullRequestActions";
let renderer: ReactTestRenderer, actions: ReturnType<typeof usePullRequestHandoffs>;
const detail = {
  projectId: ProjectId.make("project"),
  workspaceRoot: "/repo",
  url: "https://github.com/a/b/pull/1",
};
function Harness() {
  actions = usePullRequestHandoffs({ environmentId: EnvironmentId.make("m1"), detail });
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.handoff.mockReset().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
  fixture.newThread.mockReset();
  fixture.prepare.mockReset();
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("Ask carries PR evidence to coordinator before creating a worker", async () => {
  await act(async () => actions.startAsk("ask", { prompt: "Explain this" }));
  expect(fixture.handoff).toHaveBeenCalledWith(
    { environmentId: "m1", projectId: "project" },
    { prompt: "Explain this", url: detail.url },
  );
  expect(fixture.newThread).not.toHaveBeenCalled();
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(actions.handoff).toBeNull();
});
it.each(["worktree", "local"] as const)(
  "Fix stages desired %s intent with no checkout mutation",
  async (mode) => {
    await act(async () => actions.startHandoff("fix", { prompt: "Fix findings" }, mode));
    expect(fixture.handoff).toHaveBeenCalledWith(
      { environmentId: "m1", projectId: "project" },
      { prompt: "Fix findings", url: detail.url, mode },
    );
    expect(fixture.newThread).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(actions.handoff).toBeNull();
  },
);
