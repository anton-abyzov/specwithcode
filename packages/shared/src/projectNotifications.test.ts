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
