import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  COORDINATOR_STANDBY_AFTER_MINUTES,
  DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES,
  LogicalProject,
  LogicalProjectMember,
  logicalProjectMemberKey,
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
  it("records a member's folder at link time and still decodes members linked before it", () => {
    const legacy = {
      environmentId: "m2",
      projectId: "easychamp-m2",
      coordinatorThreadId: "project-coordinator:easychamp-m2",
    };
    const rooted = {
      environmentId: "m4",
      projectId: "easychamp-m4",
      coordinatorThreadId: "project-coordinator:easychamp-m4",
      workspaceRoot: "/Users/anton/Projects/sw-easychamp",
    };
    const identity = { id: "logical", title: "EasyChamp", coordinatorId: "c" };
    const decoded = Schema.decodeUnknownSync(LogicalProject)({
      ...identity,
      members: [rooted, legacy],
    });
    expect(decoded.members).toEqual([rooted, legacy]);
    expect("workspaceRoot" in decoded.members[1]!).toBe(false);
    expect(Schema.is(LogicalProjectMember)({ ...legacy, workspaceRoot: "" })).toBe(false);
    expect(Schema.is(LogicalProjectMember)({ ...legacy, workspaceRoot: "/".repeat(4097) })).toBe(
      false,
    );
    // A folder never makes a second entry for the same machine and project.
    expect(
      Schema.is(LogicalProject)({
        ...identity,
        members: [legacy, { ...legacy, workspaceRoot: "/elsewhere" }],
      }),
    ).toBe(false);
    const moved = { ...decoded.members[0]!, workspaceRoot: "/elsewhere" };
    expect(logicalProjectMemberKey(moved)).toBe(logicalProjectMemberKey(decoded.members[0]!));
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

describe("coordinator standby", () => {
  const member = {
    environmentId: "m1",
    projectId: "easychamp-m1",
    coordinatorThreadId: "project-coordinator:easychamp-m1",
  };
  const standby = { member, afterMinutes: 15, enabledAt: "2026-10-26T14:00:00.000Z" };

  it("leaves bindings written before the standby without one", () => {
    const binding = Schema.decodeUnknownSync(ProjectCoordinatorBinding)({
      state: "active",
      epoch: 3,
      takenOverAt: "2026-10-26T14:00:00.000Z",
    });
    expect(binding.standby).toBeUndefined();
    expect(binding.takenOverBy).toBeUndefined();
  });

  it("records one standby with an allowed delay", () => {
    const binding = Schema.decodeUnknownSync(ProjectCoordinatorBinding)({
      state: "active",
      epoch: 3,
      standby,
    });
    expect(binding.standby).toEqual(standby);
    expect(projectCoordinatorIsFenced({ coordinatorBinding: binding })).toBe(false);
    expect(COORDINATOR_STANDBY_AFTER_MINUTES).toEqual([5, 15, 30, 60]);
    expect(COORDINATOR_STANDBY_AFTER_MINUTES).toContain(DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES);
  });

  it("rejects delays outside 5, 15, 30 or 60 minutes", () => {
    for (const afterMinutes of [0, 1, 10, 61, 1440, 15.5, "15"]) {
      expect(
        Schema.is(ProjectCoordinatorBinding)({
          state: "active",
          epoch: 3,
          standby: { ...standby, afterMinutes },
        }),
      ).toBe(false);
    }
  });

  it("rejects a standby without a full member or start time", () => {
    const { coordinatorThreadId: _, ...partial } = member;
    expect(
      Schema.is(ProjectCoordinatorBinding)({
        state: "active",
        epoch: 3,
        standby: { ...standby, member: partial },
      }),
    ).toBe(false);
    expect(
      Schema.is(ProjectCoordinatorBinding)({
        state: "active",
        epoch: 3,
        standby: { member, afterMinutes: 15 },
      }),
    ).toBe(false);
  });

  it("says who took over, a person or the standby", () => {
    for (const takenOverBy of ["person", "auto"] as const) {
      const binding = Schema.decodeUnknownSync(ProjectCoordinatorBinding)({
        state: "active",
        epoch: 4,
        takenOverAt: "2026-10-26T14:30:00.000Z",
        takenOverBy,
        predecessor: member,
      });
      expect(binding.takenOverBy).toBe(takenOverBy);
    }
    expect(
      Schema.is(ProjectCoordinatorBinding)({ state: "active", epoch: 4, takenOverBy: "robot" }),
    ).toBe(false);
  });

  it("keeps the standby out of ordinary settings updates", () => {
    const patch = Schema.decodeUnknownSync(ProjectWorkspacePatch)({
      expectedRevision: 0,
      coordinatorBinding: { state: "active", epoch: 3, standby },
    });
    expect(patch).toEqual({ expectedRevision: 0 });
  });

  it("fits the automatic takeover operation id in the binding's 128 characters", () => {
    // "auto:" + 32 hex characters + ":" + the largest safe epoch.
    const operationId = `auto:${"a".repeat(32)}:${Number.MAX_SAFE_INTEGER}`;
    expect(operationId.length).toBeLessThanOrEqual(128);
    expect(Schema.is(ProjectCoordinatorBinding)({ state: "active", epoch: 4, operationId })).toBe(
      true,
    );
  });
});
