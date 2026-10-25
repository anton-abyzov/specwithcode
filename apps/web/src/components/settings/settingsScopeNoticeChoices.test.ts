import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  settingsScopeNoticeCheckouts,
  settingsScopeNoticeProjects,
} from "./settingsScopeNoticeChoices";

const laptop = EnvironmentId.make("laptop");
const server = EnvironmentId.make("server");
const scratchRoots = new Map([
  [laptop, "/home/.studio/scratch"],
  [server, "/srv/.studio/scratch"],
]);
const scratchRootFor = (id: EnvironmentId) => scratchRoots.get(id) ?? null;

const member = (
  id: string,
  workspaceRoot: string,
  environmentId = laptop,
  workspaceSettings: object = {},
) => ({
  environmentId,
  id: ProjectId.make(id),
  physicalProjectKey: `${environmentId}:${id}`,
  environmentLabel: environmentId === laptop ? "Laptop" : "Server",
  workspaceRoot,
  workspaceSettings,
});

const group = (
  projectKey: string,
  displayName: string,
  members: ReturnType<typeof member>[],
  workspaceSettings: object = {},
) => ({
  projectKey,
  displayName,
  workspaceRoot: members[0]?.workspaceRoot,
  workspaceSettings,
  memberProjects: members,
});

const groups = [
  group("app", "App", [member("app", "/work/app"), member("app-s", "/srv/app", server)]),
  group("old", "Old", [member("old", "/work/old", laptop, { archived: true })], {
    archived: true,
  }),
  group("check", "Check", [member("check", "/work/check", laptop, { origin: "automated" })]),
  // Each machine's "No project" folder is its own group, both named "No project".
  group("scratch-laptop", "No project", [member("s1", "/home/.studio/scratch")]),
  group("scratch-server", "No project", [member("s2", "/srv/.studio/scratch", server)]),
];

describe("settings scope notice projects", () => {
  it("folds archived projects apart and drops every No project", () => {
    const { listed, archived } = settingsScopeNoticeProjects(groups, scratchRootFor, undefined);
    expect(listed.map((entry) => entry.label)).toEqual(["App", "Check"]);
    expect(archived.map((entry) => entry.label)).toEqual(["Old"]);
    expect([...listed, ...archived].some((entry) => entry.label === "No project")).toBe(false);
    expect(listed[0]).toMatchObject({
      detail: "2 checkouts · /work/app",
      search: { project: "app" },
    });
  });

  it("keeps the selected archived project in the main list", () => {
    const { listed, archived } = settingsScopeNoticeProjects(groups, scratchRootFor, "old");
    expect(listed.map((entry) => entry.key)).toEqual(["app", "old", "check"]);
    expect(archived).toEqual([]);
  });

  it("does not count a No project member as a checkout", () => {
    const mixed = group("mixed", "Mixed", [
      member("m", "/work/mixed"),
      member("s3", "/srv/.studio/scratch", server),
    ]);
    const { listed } = settingsScopeNoticeProjects([mixed], scratchRootFor, undefined);
    expect(listed.map((entry) => entry.detail)).toEqual(["/work/mixed"]);
  });
});

describe("settings scope notice checkouts", () => {
  it("lists real checkouts, folds archived ones and drops No project rows", () => {
    const { listed, archived } = settingsScopeNoticeCheckouts(groups, scratchRootFor, undefined);
    expect(listed.map((entry) => entry.label)).toEqual([
      "App · Laptop",
      "App · Server",
      "Check · Laptop",
    ]);
    expect(archived.map((entry) => entry.label)).toEqual(["Old · Laptop"]);
    expect(listed[1]?.search).toEqual({
      project: "app",
      machine: server,
      checkout: "server:app-s",
    });
  });

  it("drops a No project member grouped with a real checkout", () => {
    const mixed = group("mixed", "Mixed", [
      member("m", "/work/mixed"),
      member("s3", "/srv/.studio/scratch", server),
    ]);
    const { listed } = settingsScopeNoticeCheckouts([mixed], scratchRootFor, undefined);
    expect(listed.map((entry) => entry.label)).toEqual(["Mixed · Laptop"]);
  });

  it("offers only the selected project's checkouts, even when it is archived", () => {
    expect(settingsScopeNoticeCheckouts(groups, scratchRootFor, "app").listed).toHaveLength(2);
    const { listed, archived } = settingsScopeNoticeCheckouts(groups, scratchRootFor, "old");
    expect(listed.map((entry) => entry.label)).toEqual(["Old · Laptop"]);
    expect(archived).toEqual([]);
  });
});
