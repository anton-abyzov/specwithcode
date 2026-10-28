// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";
import { state, root, container, shell, render, click } from "./ProjectWorkspace.test-fixtures";

describe("one project across execution machines", () => {
  it("shows EasyChamp even when the active checkout retains a handoff operation label", async () => {
    const title = state.project.title;
    Object.assign(state.project, {
      title: "sw-easychamp product handoff 0907",
      workspaceSettings: {
        logicalProject: {
          id: "easychamp",
          title: "EasyChamp",
          coordinatorId: "coord",
          members: [],
        },
        coordinatorBinding: { epoch: 1, state: "active" },
        coordinatorThreadId: "coord",
      },
    });
    try {
      await render();
      expect(container.querySelector("h1")?.textContent).toBe("EasyChamp");
      expect(container.textContent).toContain("Excited to get started on EasyChamp.");
      expect(container.querySelector(".project-workspace-identity")?.textContent).not.toContain(
        "handoff 0907",
      );
    } finally {
      state.project.title = title;
      delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    }
  });
  it("lists scoped workers from all bindings and opens the selected remote copy", async () => {
    const refs = ["host", "m1", "m3"].map((environmentId) => ({
      environmentId,
      projectId: "project",
      coordinatorThreadId:
        environmentId === "host" ? "coord" : `project-coordinator:${environmentId}`,
    }));
    const domain = { id: "one", title: "Atlas", coordinatorId: "one-coordinator", members: refs };
    Object.assign(state.project, {
      workspaceSettings: {
        logicalProject: domain,
        coordinatorBinding: { epoch: 2, state: "active" },
        coordinatorThreadId: "coord",
      },
    });
    state.otherCheckouts = ["m1", "m3"].map((environmentId) => ({
      id: "project",
      environmentId,
      workspaceRoot: `/${environmentId}/atlas`,
      workspaceSettings: {
        logicalProject: domain,
        coordinatorBinding: { epoch: 0, state: "transferred" },
      },
    }));
    state.shells = refs.map((ref) =>
      shell("same-id", {
        environmentId: ref.environmentId,
        title: `Worker on ${ref.environmentId}`,
      } as never),
    );
    try {
      await render();
      for (const ref of refs)
        expect(container.textContent).toContain(`Worker on ${ref.environmentId}`);
      expect(container.querySelector('[data-unavailable-thread-host="m3"]')?.textContent).toContain(
        "thread list may be incomplete",
      );
      const remote = container.querySelector<HTMLButtonElement>(
        '[data-thread-environment="m1"] .sws-thread-open',
      );
      expect(remote).not.toBeNull();
      await act(async () => remote!.click());
      expect(container.querySelector('[data-native-thread="same-id"]')).not.toBeNull();
      expect(container.querySelector(".sws-thread-head")?.textContent).toContain("Worker on m1");
      expect(state.navigate).not.toHaveBeenCalled();
    } finally {
      delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    }
  });
});

describe("handoff recovery after the active coordinator moves", () => {
  it("keeps the original source operation recoverable after successor mount and reload, without restarting a launched coordinator", async () => {
    const operationId = "7307ab55-fc59-4e07-abeb-de54be69215f";
    const sourceRef = { environmentId: "host", projectId: "project", coordinatorThreadId: "coord" };
    const nextRef = {
      environmentId: "m1",
      projectId: "continued",
      coordinatorThreadId: "next-coord",
    };
    const domain = {
      id: "one",
      title: "Atlas",
      coordinatorId: "one-coordinator",
      members: [sourceRef, nextRef],
    };
    const binding = { epoch: 0, state: "transferring", operationId, successor: nextRef };
    const bundle = {
      sourceEnvironmentId: "host",
      sourceProjectId: "project",
      sourceThreadId: "coord",
      logicalProject: domain,
      coordinatorBinding: binding,
      destination: { environmentId: "m1", projectId: "anchor" },
      manifest: { operationId },
      digest: "published-digest",
    };
    Object.assign(state.project, {
      workspaceSettings: {
        logicalProject: domain,
        coordinatorBinding: binding,
        coordinatorThreadId: "coord",
      },
    });
    state.recoveryHosts = ["m1"];
    const storageKey = `studio:machine-handoff:v1:${JSON.stringify(["host", "project"])}`;
    localStorage.setItem(storageKey, JSON.stringify({ operationId, targetKey: "m1:anchor" }));
    let failAcknowledgment = true;
    state.send.mockImplementation(async ({ input }) => {
      if (input.acknowledgment && failAcknowledgment)
        return { _tag: "Failure", error: new Error("Source acknowledgment unavailable") };
      if (input.mode === "preview")
        return {
          _tag: "Success",
          value: {
            phase: "started",
            operationId,
            projectId: "continued",
            coordinatorThreadId: "next-coord",
          },
        };
      return { _tag: "Success", value: { publication: "published", bundle } };
    });
    const retry = () =>
      act(async () =>
        container.querySelector<HTMLButtonElement>("[data-handoff-recovery] button")!.click(),
      );
    try {
      await render();
      expect(container.querySelector("[data-handoff-recovery]")).not.toBeNull();
      // Destination project.create can stream before receive returns and before source ACK.
      state.otherCheckouts = [
        {
          id: "continued",
          environmentId: "m1",
          workspaceRoot: "/m1/continued",
          title: "Continued Atlas",
          workspaceSettings: {
            logicalProject: domain,
            coordinatorBinding: { epoch: 1, state: "active", predecessor: sourceRef },
            coordinatorThreadId: "next-coord",
          },
        } as never,
      ];
      await render();
      expect(container.querySelector(".project-workspace-identity h1")?.textContent).toBe("Atlas");
      expect(state.otherCheckouts[0]).toMatchObject({ title: "Continued Atlas" });
      await retry();
      expect(container.textContent).toContain("Source acknowledgment unavailable");
      expect(localStorage.getItem(storageKey)).not.toBeNull();
      await act(async () => root.render(<div />));
      await render();
      expect(container.querySelector("[data-handoff-recovery]")).not.toBeNull();
      failAcknowledgment = false;
      await retry();
      expect(container.textContent).toContain("Move finished on both machines.");
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(state.send.mock.calls.filter(([call]) => call.input.mode === "start")).toHaveLength(0);
      const acknowledgments = state.send.mock.calls
        .map(([call]) => call)
        .filter((call) => call.input.acknowledgment);
      expect(acknowledgments).toHaveLength(2);
      expect(acknowledgments[1]).toMatchObject({
        environmentId: "host",
        input: {
          projectId: "project",
          operationId,
          expectedDigest: "published-digest",
          destination: { environmentId: "m1", projectId: "anchor" },
          acknowledgment: { projectId: "continued", coordinatorThreadId: "next-coord" },
        },
      });
      expect(state.navigate).not.toHaveBeenCalled();
    } finally {
      delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    }
  });
});
