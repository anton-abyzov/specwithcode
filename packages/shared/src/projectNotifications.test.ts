import { describe, expect, it } from "vite-plus/test";

import {
  isDelegatedThread,
  projectAlertAllowed,
  projectNotificationLevel,
  projectShowsWaitingCount,
  type ProjectNotificationLevel,
} from "./projectNotifications.ts";

describe("projectNotificationLevel", () => {
  it("reads a saved level and falls back to the coordinator level", () => {
    expect(projectNotificationLevel({ workspaceSettings: { notifications: "none" } })).toBe("none");
    expect(projectNotificationLevel({ workspaceSettings: {} })).toBe("coordinator");
    expect(projectNotificationLevel(null)).toBe("coordinator");
    // A level a newer version saved reads as the default here.
    expect(projectNotificationLevel({ workspaceSettings: { notifications: "digest" } })).toBe(
      "coordinator",
    );
  });
});

describe("projectNotificationLevel of a project nobody works in", () => {
  const checkFolder = "/Users/x/Projects/scratch/swc-1164-handoff";

  it("starts a check's project with no alerts", () => {
    expect(
      projectNotificationLevel({
        workspaceRoot: checkFolder,
        workspaceSettings: { origin: "automated" },
      }),
    ).toBe("none");
    expect(
      projectNotificationLevel({ workspaceRoot: "/Users/x/.specwithcode/m4/scratch/run/app" }),
    ).toBe("none");
  });

  it("lets a level the person saved win", () => {
    expect(
      projectNotificationLevel({
        workspaceRoot: checkFolder,
        workspaceSettings: { origin: "automated", notifications: "requests" },
      }),
    ).toBe("requests");
  });

  it.each([
    "/Users/x/Projects/sw-easychamp",
    "/Users/x/Projects/scratch/invoices",
    "/Users/x/work/acceptance-portal",
    "/Users/x/Projects/client-demo",
    "/Users/x/.specwithcode/m4/projects/notes",
    // A machine's "No project" folder holds the person's own chats.
    "/Users/x/.specwithcode/m4/scratch",
  ])("keeps alerts on %s", (workspaceRoot) => {
    expect(projectNotificationLevel({ workspaceRoot })).toBe("coordinator");
  });

  it("gives alerts back when the person moves it to their projects", () => {
    expect(
      projectNotificationLevel({
        workspaceRoot: checkFolder,
        workspaceSettings: { origin: "user" },
      }),
    ).toBe("coordinator");
  });

  it("keeps the personal assistant's alerts wherever its folder is", () => {
    expect(
      projectNotificationLevel({
        workspaceRoot: "/Users/x/.specwithcode/m4/aide",
        workspaceSettings: { kind: "personal" },
      }),
    ).toBe("coordinator");
  });
});

describe("projectAlertAllowed", () => {
  const events = [
    { delegated: false, needsYou: false },
    { delegated: false, needsYou: true },
    { delegated: true, needsYou: false },
    { delegated: true, needsYou: true },
  ];
  it.each<[ProjectNotificationLevel, boolean[]]>([
    ["all", [true, true, true, true]],
    ["coordinator", [true, true, false, true]],
    ["requests", [false, true, false, true]],
    ["none", [false, false, false, false]],
  ])("lets %s through as documented", (level, expected) => {
    expect(events.map((event) => projectAlertAllowed(level, event))).toEqual(expected);
  });

  it("counts waiting threads at every level but nothing", () => {
    expect(projectShowsWaitingCount("requests")).toBe(true);
    expect(projectShowsWaitingCount("none")).toBe(false);
  });
});

describe("isDelegatedThread", () => {
  it("treats delegated workers as replies and forks as main threads", () => {
    expect(isDelegatedThread({ lineage: { relationshipToParent: "subagent" } })).toBe(true);
    expect(isDelegatedThread({ lineage: { relationshipToParent: "fork" } })).toBe(false);
    expect(isDelegatedThread({ lineage: { relationshipToParent: null } })).toBe(false);
  });
});
