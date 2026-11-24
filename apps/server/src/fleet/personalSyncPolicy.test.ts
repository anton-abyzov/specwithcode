// @effect-diagnostics nodeBuiltinImport:off -- reads the policy source to check its guard table.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

import {
  isOwnPersonalSyncAllowed,
  personalSyncAccess,
  type PersonalSyncCaller,
  type PersonalSyncLocal,
  type PersonalSyncTarget,
} from "./personalSyncPolicy.ts";
import { projectInGrant } from "./workGrantPolicy.ts";

const localEnv = EnvironmentId.make("env-m5");
const peerEnv = EnvironmentId.make("env-m4");
const otherEnv = EnvironmentId.make("env-other");

const linkedPersonal: PersonalSyncTarget = {
  id: ProjectId.make("percy-m5"),
  workspaceSettings: {
    kind: "personal",
    logicalProject: {
      id: "lp-percy",
      members: [{ environmentId: localEnv }, { environmentId: peerEnv }],
    },
  },
};

const validCaller: PersonalSyncCaller = {
  environmentId: peerEnv,
  grant: { kind: "own", legacy: false, revoked: false },
  cloudUserId: "user_owner_123",
};

const validLocal: PersonalSyncLocal = {
  environmentId: localEnv,
  cloudUserId: "user_owner_123",
};

describe("isOwnPersonalSyncAllowed", () => {
  it("allows own non-legacy peer with matching cloudUserId and logicalProject membership", () => {
    expect(personalSyncAccess(validCaller, validLocal, linkedPersonal, "lp-percy")).toEqual({
      allowed: true,
    });
    expect(isOwnPersonalSyncAllowed(validCaller, validLocal, linkedPersonal, "lp-percy")).toBe(
      true,
    );
  });

  it("refuses team grants, legacy grants, revoked grants, and missing grants", () => {
    expect(
      personalSyncAccess(
        { ...validCaller, grant: { kind: "team", revoked: false } },
        validLocal,
        linkedPersonal,
      ),
    ).toEqual({ allowed: false, reason: "not_own_grant" });

    expect(
      personalSyncAccess(
        { ...validCaller, grant: { kind: "own", legacy: true, revoked: false } },
        validLocal,
        linkedPersonal,
      ),
    ).toEqual({ allowed: false, reason: "legacy_grant" });

    expect(
      personalSyncAccess(
        { ...validCaller, grant: { kind: "own", revoked: true } },
        validLocal,
        linkedPersonal,
      ),
    ).toEqual({ allowed: false, reason: "grant_revoked" });

    expect(
      personalSyncAccess({ ...validCaller, grant: undefined }, validLocal, linkedPersonal),
    ).toEqual({ allowed: false, reason: "no_grant" });
  });

  it("refuses missing or mismatched cloudUserId", () => {
    expect(
      personalSyncAccess({ ...validCaller, cloudUserId: undefined }, validLocal, linkedPersonal),
    ).toEqual({ allowed: false, reason: "missing_cloud_user" });

    expect(
      personalSyncAccess(validCaller, { ...validLocal, cloudUserId: "  " }, linkedPersonal),
    ).toEqual({ allowed: false, reason: "missing_cloud_user" });

    expect(
      personalSyncAccess(
        { ...validCaller, cloudUserId: "user_someone_else" },
        validLocal,
        linkedPersonal,
      ),
    ).toEqual({ allowed: false, reason: "cloud_user_mismatch" });
  });

  it("refuses same machine, non-member, unlinked, mismatched logicalProjectId, or code projects", () => {
    expect(
      personalSyncAccess({ ...validCaller, environmentId: localEnv }, validLocal, linkedPersonal),
    ).toEqual({ allowed: false, reason: "same_machine" });

    expect(
      personalSyncAccess({ ...validCaller, environmentId: otherEnv }, validLocal, linkedPersonal),
    ).toEqual({ allowed: false, reason: "not_member" });

    expect(personalSyncAccess(validCaller, validLocal, linkedPersonal, "lp-different")).toEqual({
      allowed: false,
      reason: "not_linked",
    });

    expect(
      personalSyncAccess(validCaller, validLocal, {
        id: "percy-unlinked",
        workspaceSettings: { kind: "personal" },
      }),
    ).toEqual({ allowed: false, reason: "not_linked" });

    expect(
      personalSyncAccess(validCaller, validLocal, {
        ...linkedPersonal,
        workspaceSettings: { ...linkedPersonal.workspaceSettings, kind: "code" },
      }),
    ).toEqual({ allowed: false, reason: "not_personal" });
  });

  it("keeps workGrantPolicy.projectInGrant closed for linked personal assistants", () => {
    expect(projectInGrant({ kind: "all" }, peerEnv, linkedPersonal)).toBe(false);
    expect(projectInGrant({ kind: "linked" }, peerEnv, linkedPersonal)).toBe(false);
    expect(
      projectInGrant(
        { kind: "listed", projectIds: [ProjectId.make("percy-m5")] },
        peerEnv,
        linkedPersonal,
      ),
    ).toBe(false);
  });
});

describe("AC-08 guard table regression", () => {
  const serverSrc = path.resolve(import.meta.dirname, "..");
  const guardedSubsystems = [
    "fleet/workGrantPolicy.ts",
    "mcp/workGrantAccess.ts",
    "project/ProjectLink.ts",
    "mcp/toolkits/project/handlers.ts",
    "mcp/toolkits/orchestrator/migrate.ts",
    "away/AwayPlanner.ts",
    "handoff/HandoffMode.ts",
    "handoff/HandoffMoves.ts",
    "orchestration-v2/ThreadMoveService.ts",
    "orchestration-v2/MachineLimitHandoff.ts",
  ];

  for (const rel of guardedSubsystems) {
    it(`retains isPersonalAssistantProject guard in ${rel}`, () => {
      const content = fs.readFileSync(path.join(serverSrc, rel), "utf8");
      expect(content).toContain("isPersonalAssistantProject");
    });
  }
});
