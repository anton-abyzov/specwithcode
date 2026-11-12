import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkServiceChanges,
  enableAllChanges,
  googleBriefingAction,
  partitionGoogleProjects,
} from "./googleAccountSettings.logic";

const env = EnvironmentId.make("env");
const project = (
  id: string,
  title: string,
  settings: { kind?: string; archived?: boolean; origin?: string } = {},
  workspaceRoot = `/p/${id}`,
) => ({
  environmentId: env,
  id: ProjectId.make(id),
  title,
  workspaceRoot,
  workspaceSettings: settings,
});
const A = ProjectId.make("a");
const B = ProjectId.make("b");

describe("partitionGoogleProjects", () => {
  it("puts Aide in its own group and keeps automated, archived and scratch projects apart", () => {
    const { assistants, active, automated, archived } = partitionGoogleProjects(
      [
        project("code", "Beta"),
        project("alpha", "Alpha"),
        project("old", "Old", { archived: true }),
        project("aide", "Zeta", { kind: "personal" }),
        project("scratch", "No project", {}, "/scratch"),
        project(
          "check",
          "Routing acceptance",
          {},
          "/home/me/.specwithcode/m4/scratch/run/workspace",
        ),
        project("demo", "Demo", { origin: "automated" }),
        project("oldcheck", "Old check", { archived: true }, "/tmp/check"),
      ],
      () => "/scratch",
    );
    expect(assistants.map((entry) => entry.id)).toEqual(["aide"]);
    expect(active.map((entry) => entry.id)).toEqual(["alpha", "code"]);
    expect(automated.map((entry) => entry.id)).toEqual(["demo", "check"]);
    expect(archived.map((entry) => entry.id)).toEqual(["old", "oldcheck"]);
  });

  it("never counts an archived Aide among projects", () => {
    const { assistants, archived } = partitionGoogleProjects(
      [project("aide", "Aide", { kind: "personal", archived: true })],
      () => null,
    );
    expect(assistants.map((entry) => entry.id)).toEqual(["aide"]);
    expect(archived).toEqual([]);
  });

  it("leaves a hidden personal assistant out unless it still holds Google access", () => {
    const projects = [project("code", "Alpha"), project("aide", "Zeta", { kind: "personal" })];
    const hidden = partitionGoogleProjects(projects, () => null, { enabled: false, keepIds: [] });
    expect(hidden.assistants).toEqual([]);
    expect(hidden.active.map((entry) => entry.id)).toEqual(["code"]);
    const withAccess = partitionGoogleProjects(projects, () => null, {
      enabled: false,
      keepIds: ["aide"],
    });
    expect(withAccess.assistants.map((entry) => entry.id)).toEqual(["aide"]);
    expect(withAccess.active.map((entry) => entry.id)).toEqual(["code"]);
  });
});

describe("googleBriefingAction", () => {
  const aide = { assistant: true, machineAssistant: true, aideEnabled: true };
  const regular = { assistant: false, machineAssistant: false, aideEnabled: true };

  it("points Aide at its own Proactive briefing once it may read Gmail or Calendar", () => {
    expect(googleBriefingAction(["gmail"], aide)).toBe("proactive");
    expect(googleBriefingAction(["calendar", "drive"], aide)).toBe("proactive");
  });

  it("offers a Morning briefing where no routine is set up on its own", () => {
    expect(googleBriefingAction(["drive"], aide)).toBe("morning");
    expect(googleBriefingAction(["gmail"], regular)).toBe("morning");
    expect(googleBriefingAction(["gmail"], { ...aide, machineAssistant: false })).toBe("morning");
  });

  it("offers nothing without access or for a hidden Aide", () => {
    expect(googleBriefingAction([], aide)).toBeNull();
    expect(googleBriefingAction([], regular)).toBeNull();
    expect(googleBriefingAction(["gmail"], { ...aide, aideEnabled: false })).toBeNull();
  });
});

describe("bulk Google access", () => {
  const access = [{ projectId: A, services: ["gmail" as const] }];

  it("enables one service only where it is missing", () => {
    expect(bulkServiceChanges(access, [A, B], "gmail", true)).toEqual([
      { projectId: B, services: ["gmail"] },
    ]);
  });

  it("disables one service and keeps the others", () => {
    expect(
      bulkServiceChanges([{ projectId: A, services: ["gmail", "drive"] }], [A, B], "gmail", false),
    ).toEqual([{ projectId: A, services: ["drive"] }]);
  });

  it("enables every granted service for every project", () => {
    expect(enableAllChanges(access, [A, B], ["gmail", "calendar"])).toEqual([
      { projectId: A, services: ["gmail", "calendar"] },
      { projectId: B, services: ["gmail", "calendar"] },
    ]);
  });
});
