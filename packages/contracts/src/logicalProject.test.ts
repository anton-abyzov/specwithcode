import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  LogicalProject,
  logicalProjectTitle,
  ProjectCoordinatorBinding,
  projectCoordinatorIsFenced,
  projectExecutionIsFenced,
} from "./logicalProject.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectWorkspacePatch,
  ProjectWorkspaceSettings,
} from "./projectWorkspace.ts";

describe("logical project identity", () => {
  it("retains the domain name over a handoff label without guessing legacy names", () => {
    const title = "sw-easychamp product handoff 0907";
    expect(logicalProjectTitle({ title })).toBe(title);
    expect(logicalProjectTitle({ title, workspaceSettings: null })).toBe(title);
    expect(
      logicalProjectTitle({
        title,
        workspaceSettings: { logicalProject: { title: "EasyChamp" } },
      }),
    ).toBe("EasyChamp");
  });
  it("decodes existing settings without creating or merging an identity", () => {
    const settings = Schema.decodeUnknownSync(ProjectWorkspaceSettings)(
      DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    );
    expect(settings.logicalProject).toBeUndefined();
    expect(projectCoordinatorIsFenced(settings)).toBe(false);
  });
  it("keeps execution ownership out of ordinary settings updates", () => {
    const patch = Schema.decodeUnknownSync(ProjectWorkspacePatch)({
      expectedRevision: 0,
      paused: false,
      logicalProject: { id: "replacement" },
      coordinatorBinding: { state: "active", epoch: 99 },
    });
    expect(patch).toEqual({ expectedRevision: 0, paused: false });
  });
  it("fences both a pending transfer and a confirmed successor", () => {
    for (const state of ["transferring", "transferred"] as const) {
      const coordinatorBinding = Schema.decodeUnknownSync(ProjectCoordinatorBinding)({
        state,
        epoch: 2,
      });
      expect(projectCoordinatorIsFenced({ coordinatorBinding })).toBe(true);
    }
    expect(projectCoordinatorIsFenced({ coordinatorBinding: { state: "active", epoch: 3 } })).toBe(
      false,
    );
  });
  it("rejects invalid or unbounded identities and epochs", () => {
    expect(
      Schema.is(LogicalProject)({ id: "", title: "Project", coordinatorId: "c", members: [] }),
    ).toBe(false);
    expect(Schema.is(ProjectCoordinatorBinding)({ state: "active", epoch: -1 })).toBe(false);
    expect(Schema.is(ProjectCoordinatorBinding)({ state: "active", epoch: 0.5 })).toBe(false);
  });
});

it("rejects duplicate binding keys and keeps acknowledged worker execution independent", () => {
  const member = {
    environmentId: "host",
    projectId: "project",
    coordinatorThreadId: "coordinator",
  };
  expect(
    Schema.is(LogicalProject)({
      id: "logical",
      title: "P",
      coordinatorId: "c",
      members: [member, { ...member, coordinatorThreadId: "conflict" }],
    }),
  ).toBe(false);
  const settings = {
    coordinatorThreadId: "coordinator",
    coordinatorBinding: { state: "transferred" as const, epoch: 1 },
  };
  expect(projectExecutionIsFenced(settings, "project", "coordinator")).toBe(true);
  expect(projectExecutionIsFenced(settings, "project", "worker")).toBe(false);
  expect(projectExecutionIsFenced(settings, "project", null)).toBe(false);
});
