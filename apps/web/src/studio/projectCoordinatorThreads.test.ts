import { describe, expect, it } from "vite-plus/test";

import {
  coordinatorAttention,
  isOrchestratorThreadId,
  isProjectCoordinatorThread,
  projectCoordinatorRole,
} from "./projectCoordinatorThreads";

describe("projectCoordinatorRole", () => {
  const scope = { projectId: "atlas", coordinatorThreadId: "coord-2" };
  it("names the saved coordinator current and older coordinator ids previous", () => {
    expect(projectCoordinatorRole("coord-2", scope)).toBe("current");
    expect(projectCoordinatorRole("project-coordinator:atlas", scope)).toBe("previous");
    expect(projectCoordinatorRole("worker", scope)).toBeNull();
  });
  it("takes the host's id for a new coordinator as current until the settings name one", () => {
    const unsaved = { projectId: "atlas", coordinatorThreadId: null };
    expect(projectCoordinatorRole("project-coordinator:atlas", unsaved)).toBe("current");
    expect(projectCoordinatorRole("project-coordinator:other", unsaved)).toBe("previous");
    expect(projectCoordinatorRole("worker", unsaved)).toBeNull();
  });
  it("calls any coordinator of the project a coordinator thread", () => {
    expect(isProjectCoordinatorThread("coord-2", scope)).toBe(true);
    expect(isProjectCoordinatorThread("project-coordinator:atlas", scope)).toBe(true);
    expect(isProjectCoordinatorThread("thread:delegated-task:x", scope)).toBe(false);
  });
  it("recognizes coordinator ids by the host's prefix", () => {
    expect(isOrchestratorThreadId("project-coordinator:atlas")).toBe(true);
    expect(isOrchestratorThreadId("worker")).toBe(false);
  });
});

describe("coordinatorAttention", () => {
  type Coordinator = NonNullable<Parameters<typeof coordinatorAttention>[0]>;
  const coordinator = (overrides: Partial<Coordinator> = {}): Coordinator => ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    runtime: null,
    ...overrides,
  });
  it("is quiet while the coordinator wants nothing", () => {
    expect(coordinatorAttention(null)).toBeNull();
    expect(coordinatorAttention(coordinator())).toBeNull();
    expect(coordinatorAttention(coordinator({ runtime: { status: "running" } }))).toBeNull();
  });
  it("names what the coordinator waits on, approval first", () => {
    expect(
      coordinatorAttention(coordinator({ hasPendingApprovals: true, hasPendingUserInput: true })),
    ).toEqual({
      reason: "approval",
      message: "The coordinator is waiting for your approval.",
      action: "Review the request",
    });
    expect(coordinatorAttention(coordinator({ hasPendingUserInput: true }))?.reason).toBe("input");
    expect(coordinatorAttention(coordinator({ hasActionableProposedPlan: true }))?.reason).toBe(
      "plan",
    );
    expect(coordinatorAttention(coordinator({ runtime: { status: "failed" } }))?.reason).toBe(
      "failed",
    );
  });
});
