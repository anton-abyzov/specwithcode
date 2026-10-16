import { describe, expect, it } from "vite-plus/test";

import {
  arrangeProjects,
  moveProject,
  rememberPinnedMembers,
  resolveProjectOrder,
  sameProjectOrder,
  stepProject,
  toggleProjectPin,
} from "./projectOrder";

const groups = ["a", "b", "c", "d"].map((projectKey) => ({ projectKey }));
const keys = (arranged: {
  pinned: { projectKey: string }[];
  unpinned: { projectKey: string }[];
}) => ({
  pinned: arranged.pinned.map((group) => group.projectKey),
  unpinned: arranged.unpinned.map((group) => group.projectKey),
});

describe("arrangeProjects", () => {
  it("keeps input order when nothing is saved", () => {
    expect(keys(arrangeProjects(groups, { pinned: [], unpinned: [] }))).toEqual({
      pinned: [],
      unpinned: ["a", "b", "c", "d"],
    });
  });

  it("puts pinned projects first and new projects at the top of the rest", () => {
    expect(keys(arrangeProjects(groups, { pinned: ["c"], unpinned: ["d", "b"] }))).toEqual({
      pinned: ["c"],
      unpinned: ["a", "d", "b"],
    });
  });

  it("ignores saved keys of projects that are not listed", () => {
    expect(keys(arrangeProjects(groups, { pinned: ["gone"], unpinned: ["x", "d"] }))).toEqual({
      pinned: [],
      unpinned: ["a", "b", "c", "d"],
    });
  });
});

describe("moveProject", () => {
  const listed = { pinned: ["c"], unpinned: ["a", "b", "d"] };

  it("reorders within a group and records every listed project", () => {
    expect(
      moveProject({ pinned: ["c"], unpinned: [] }, listed, "d", { pinned: false, beforeKey: "a" }),
    ).toEqual({ pinned: ["c"], unpinned: ["d", "a", "b"] });
  });

  it("pins and unpins when crossing the boundary", () => {
    const pinned = moveProject({ pinned: ["c"], unpinned: [] }, listed, "b", {
      pinned: true,
      beforeKey: "c",
    });
    expect(pinned).toEqual({ pinned: ["b", "c"], unpinned: ["a", "d"] });
    expect(
      moveProject(pinned, { pinned: ["b", "c"], unpinned: ["a", "d"] }, "c", {
        pinned: false,
        beforeKey: null,
      }),
    ).toEqual({ pinned: ["b"], unpinned: ["a", "d", "c"] });
  });

  it("keeps entries of projects that are not listed right now", () => {
    expect(
      moveProject({ pinned: ["off", "c"], unpinned: ["archived", "a"] }, listed, "a", {
        pinned: false,
        beforeKey: null,
      }),
    ).toEqual({ pinned: ["c", "off"], unpinned: ["b", "d", "a", "archived"] });
  });

  it("lands a new project at the top once the order is saved", () => {
    const saved = moveProject({ pinned: [], unpinned: [] }, listed, "d", {
      pinned: false,
      beforeKey: "a",
    });
    expect(keys(arrangeProjects([...groups, { projectKey: "new" }], saved)).unpinned).toEqual([
      "new",
      "d",
      "a",
      "b",
    ]);
  });
});

describe("toggleProjectPin", () => {
  const listed = { pinned: ["c"], unpinned: ["a", "b"] };
  it("pins at the end and unpins to the top of the rest", () => {
    expect(toggleProjectPin({ pinned: [], unpinned: [] }, listed, "b")).toEqual({
      pinned: ["c", "b"],
      unpinned: ["a"],
    });
    expect(toggleProjectPin({ pinned: [], unpinned: [] }, listed, "c")).toEqual({
      pinned: [],
      unpinned: ["c", "a", "b"],
    });
  });
});

describe("stepProject", () => {
  const listed = { pinned: ["p1", "p2"], unpinned: ["u1", "u2"] };
  it("moves one place within a group", () => {
    expect(stepProject(listed, "u2", "up")).toEqual({ pinned: false, beforeKey: "u1" });
    expect(stepProject(listed, "p1", "down")).toEqual({ pinned: true, beforeKey: null });
    expect(stepProject(listed, "u1", "down")).toEqual({ pinned: false, beforeKey: null });
  });
  it("crosses the boundary, and stops at either end", () => {
    expect(stepProject(listed, "u1", "up")).toEqual({ pinned: true, beforeKey: null });
    expect(stepProject(listed, "p2", "down")).toEqual({ pinned: false, beforeKey: "u1" });
    expect(stepProject(listed, "p1", "up")).toBeNull();
    expect(stepProject(listed, "u2", "down")).toBeNull();
  });
});

it("compares orders by content", () => {
  expect(sameProjectOrder({ pinned: ["a"], unpinned: [] }, { pinned: ["a"], unpinned: [] })).toBe(
    true,
  );
  expect(sameProjectOrder({ pinned: ["a"], unpinned: [] }, { pinned: [], unpinned: ["a"] })).toBe(
    false,
  );
});

describe("pins across folder changes", () => {
  const before = [
    { projectKey: "host:/old/easychamp", memberProjects: [{ environmentId: "host", id: "p1" }] },
    { projectKey: "github.com/a/specweave", memberProjects: [{ environmentId: "host", id: "p2" }] },
  ];
  it("finds a re-pointed project through its remembered members", () => {
    const saved = rememberPinnedMembers(
      { pinned: ["host:/old/easychamp", "github.com/a/specweave"], unpinned: [] },
      before,
    );
    expect(saved.pinnedMembers).toEqual({
      "host:/old/easychamp": ["host:p1"],
      "github.com/a/specweave": ["host:p2"],
    });
    const after = [
      { projectKey: "host:/new/easychamp", memberProjects: [{ environmentId: "host", id: "p1" }] },
      before[1]!,
    ];
    const resolved = resolveProjectOrder(saved, after);
    expect(resolved.pinned).toEqual(["host:/new/easychamp", "github.com/a/specweave"]);
    expect(keys(arrangeProjects(after, resolved)).pinned).toEqual([
      "host:/new/easychamp",
      "github.com/a/specweave",
    ]);
  });

  it("keeps a pin whose project is not listed right now", () => {
    const saved = rememberPinnedMembers({ pinned: ["gone"], unpinned: [] }, []);
    expect(resolveProjectOrder(saved, before).pinned).toEqual(["gone"]);
  });
});
