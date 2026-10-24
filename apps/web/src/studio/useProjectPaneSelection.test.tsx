// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { state, root, container, shell } from "../components/studio/ProjectWorkspace.test-fixtures";
import { ProjectWorkspace } from "../components/studio/ProjectWorkspace";

import { projectReturnSearch } from "./projectReturnNavigation";

const selected = "worker" as never;
describe("remembered project pane selection", () => {
  it.each(["missing", "archived", "deleted", "foreign", "inaccessible"])(
    "falls back safely for %s instead of following another project",
    async (kind) => {
      state.shells =
        kind === "missing" || kind === "inaccessible"
          ? []
          : [
              shell("worker", {
                ...(kind === "archived" ? { archivedAt: "2026-10-23T00:00:00Z" } : {}),
                ...(kind === "deleted" ? { deletedAt: "2026-10-23T00:00:00Z" } : {}),
                ...(kind === "foreign" ? { projectId: "foreign" as never } : {}),
              }),
            ];
      const select = vi.fn();
      await act(async () =>
        root.render(
          <ProjectWorkspace
            projectKey="atlas"
            selectedThreadId={selected}
            selectedThreadEnvironmentId={kind === "inaccessible" ? "unavailable-machine" : null}
            restoringThread
            onSelectThread={select}
          />,
        ),
      );
      expect(select).toHaveBeenCalledWith(null, { replace: true });
      expect(state.navigate).not.toHaveBeenCalled();
    },
  );
  it("records direct links without checkout under the resolved machine identity", async () => {
    state.shells = [shell("worker")];
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={selected}
          onSelectThread={vi.fn()}
        />,
      ),
    );
    expect(projectReturnSearch("atlas", "host:project")).toEqual({
      checkout: "host:project",
      thread: selected,
      threadEnvironment: "host",
      restoreThread: true,
    });
  });
  it("waits for inventory and restores when the worker arrives", async () => {
    state.shellsBootstrapped = false;
    state.shells = [];
    const select = vi.fn();
    const render = () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={selected}
          restoringThread
          onSelectThread={select}
        />,
      );
    await act(async () => render());
    expect(select).not.toHaveBeenCalled();
    state.shells = [shell("worker")];
    state.shellsBootstrapped = true;
    await act(async () => render());
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
  });
  it("preserves explicit foreign-thread link routing", async () => {
    state.shells = [shell("worker", { projectId: "foreign" as never })];
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={selected}
          onSelectThread={vi.fn()}
        />,
      ),
    );
    expect(state.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/$environmentId/$threadId" }),
    );
  });
});
