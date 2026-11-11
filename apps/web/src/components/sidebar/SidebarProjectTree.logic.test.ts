import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  buildProjectTree,
  classifyProjectTreeSession,
  compactAge,
  PROJECT_TREE_OTHER_KEY,
  PROJECT_TREE_PROJECT_PAGE,
  resolveProjectTreeExpanded,
  routeProjectTreeKey,
  visibleProjectTree,
} from "./SidebarProjectTree.logic";

function group(key: string, name: string, projectIds: string[]): SidebarProjectSnapshot {
  return {
    projectKey: key,
    displayName: name,
    memberProjectRefs: projectIds.map((projectId) => ({ environmentId: "env", projectId })),
  } as unknown as SidebarProjectSnapshot;
}

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env",
    projectId: "p-umb" as EnvironmentThreadShell["projectId"],
    title: id,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    updatedAt: "2026-10-10T05:00:00Z",
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

const groups = [
  group("umb", "specweave-umb", ["p-umb"]),
  group("acme", "acme-app", ["p-acme"]),
  group("idle", "quiet-project", ["p-idle"]),
];

describe("buildProjectTree", () => {
  it("nests sessions under their project and keeps empty projects listed", () => {
    const tree = buildProjectTree(groups, [
      shell("a"),
      shell("b", { projectId: "p-acme" as EnvironmentThreadShell["projectId"] }),
      shell("gone", { archivedAt: "2026-10-09T00:00:00Z" }),
    ]);
    expect(tree.map((g) => [g.label, g.sessions.map((s) => s.thread.id)])).toEqual([
      ["specweave-umb", ["a"]],
      ["acme-app", ["b"]],
      ["quiet-project", []],
    ]);
  });

  it("puts decisions and running work first and resolved sessions last", () => {
    const tree = buildProjectTree(groups, [
      shell("old-ready", { updatedAt: "2026-10-01T00:00:00Z" }),
      shell("resolved-new", { settledOverride: "settled", updatedAt: "2026-10-10T06:00:00Z" }),
      shell("new-ready", { updatedAt: "2026-10-10T05:30:00Z" }),
      shell("approval", { hasPendingApprovals: true, updatedAt: "2026-09-01T00:00:00Z" }),
    ]);
    const umb = tree[0]!;
    expect(umb.sessions.map((s) => s.thread.id)).toEqual([
      "approval",
      "new-ready",
      "old-ready",
      "resolved-new",
    ]);
    expect(umb.attentionCount).toBe(1);
    expect(umb.sessions.map((s) => s.status)).toEqual(["attention", "ready", "ready", "resolved"]);
  });

  it("can put the most recently active projects first and empty ones last", () => {
    const tree = buildProjectTree(
      groups,
      [
        shell("a", { updatedAt: "2026-10-09T00:00:00Z" }),
        shell("b", {
          projectId: "p-acme" as EnvironmentThreadShell["projectId"],
          updatedAt: "2026-10-10T00:00:00Z",
        }),
      ],
      { orderByActivity: true },
    );
    expect(tree.map((g) => g.key)).toEqual(["acme", "umb", "idle"]);
  });

  it("puts a project made after the last activity first, before it has a session", () => {
    const fresh = {
      ...group("fresh", "carbon-test", ["p-fresh"]),
      createdAt: "2026-10-11T00:00:00Z",
    };
    const tree = buildProjectTree(
      [...groups, fresh],
      [shell("a", { updatedAt: "2026-10-09T00:00:00Z" })],
      { orderByActivity: true },
    );
    expect(tree[0]?.key).toBe("fresh");
  });

  it("keeps the project of the open draft listed when it sorts past the first page", () => {
    const many = Array.from({ length: PROJECT_TREE_PROJECT_PAGE + 5 }, (_, index) =>
      group(`g${index}`, `project-${index}`, [`p-${index}`]),
    );
    const tree = buildProjectTree(many, []);
    const last = tree.at(-1)!;
    expect(visibleProjectTree(tree, new Set(), false)).not.toContain(last);
    const key = routeProjectTreeKey(tree, null, {
      environmentId: last.project!.memberProjectRefs[0]!.environmentId,
      projectId: last.project!.memberProjectRefs[0]!.projectId,
    });
    expect(key).toBe(last.key);
    expect(visibleProjectTree(tree, new Set([key!]), false)).toContain(last);
    expect(visibleProjectTree(tree, new Set(), true)).toHaveLength(tree.length);
  });

  it("collects sessions of unregistered projects under Other sessions", () => {
    const tree = buildProjectTree(groups, [
      shell("stray", { projectId: "p-unknown" as EnvironmentThreadShell["projectId"] }),
    ]);
    expect(tree.at(-1)?.key).toBe(PROJECT_TREE_OTHER_KEY);
    expect(tree.at(-1)?.sessions).toHaveLength(1);
  });
});

describe("resolveProjectTreeExpanded", () => {
  it("opens busy and recent projects by default, honours saved choices and the open session", () => {
    const tree = buildProjectTree(groups, [
      shell("a"),
      shell("b", {
        projectId: "p-acme" as EnvironmentThreadShell["projectId"],
        hasPendingUserInput: true,
      }),
    ]);
    expect([...resolveProjectTreeExpanded(tree, {}, null)].sort()).toEqual(["acme", "umb"]);
    expect([...resolveProjectTreeExpanded(tree, { umb: false }, null)]).toEqual(["acme"]);
    const activeKey = tree[0]!.sessions[0]!.key;
    expect(resolveProjectTreeExpanded(tree, { umb: false }, activeKey).has("umb")).toBe(true);
  });
});

describe("compactAge", () => {
  it("formats short relative ages", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(compactAge(now - 30_000, now)).toBe("now");
    expect(compactAge(now - 5 * 60_000, now)).toBe("5m");
    expect(compactAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(compactAge(now - 2 * 86_400_000, now)).toBe("2d");
    expect(compactAge(now - 21 * 86_400_000, now)).toBe("3w");
    expect(compactAge(0, now)).toBe("");
  });
});

describe("classifyProjectTreeSession", () => {
  it("names an access request apart from a command approval", () => {
    const access = {
      id: "turn-item:access-request:1",
      kind: "permission",
      createdAt: "2026-10-10T05:00:00Z",
      access: { accessTitle: "Use Notes", reason: "", subjects: [] },
    };
    expect(
      classifyProjectTreeSession(
        shell("asks", {
          hasPendingApprovals: true,
          source: { pendingRuntimeRequest: access } as never,
        }),
      ),
    ).toEqual({ status: "attention", label: "Access requested" });
    expect(classifyProjectTreeSession(shell("cmd", { hasPendingApprovals: true }))).toEqual({
      status: "attention",
      label: "Approval requested",
    });
  });
});
