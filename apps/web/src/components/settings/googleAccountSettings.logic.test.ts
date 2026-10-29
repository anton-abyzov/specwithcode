import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bulkServiceChanges,
  enableAllChanges,
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
  it("lists active projects, personal first, and keeps automated, archived and scratch apart", () => {
    const { active, automated, archived } = partitionGoogleProjects(
      [
        project("code", "Alpha"),
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
    expect(active.map((entry) => entry.id)).toEqual(["aide", "code"]);
    expect(automated.map((entry) => entry.id)).toEqual(["demo", "check"]);
    expect(archived.map((entry) => entry.id)).toEqual(["old", "oldcheck"]);
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
