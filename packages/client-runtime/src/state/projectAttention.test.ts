import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "./models.js";
import {
  aggregateProjectAttention,
  observeProjectThread,
  type AttentionMember,
} from "./projectAttention.js";
import { classifyProjectActions } from "@specweave-studio/shared/projectAttention";
const member: AttentionMember = {
  environmentId: "host",
  projectId: "project",
  coordinatorThreadId: "coordinator",
  freshness: "live",
};
const thread = (id: string, props: Partial<EnvironmentThreadShell> = {}) =>
  ({
    id,
    environmentId: "host",
    projectId: "project",
    updatedAt: "2026-10-23T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    runtime: null,
    latestRun: null,
    settledOverride: null,
    lineage: { parentThreadId: null, relationshipToParent: null },
    ...props,
  }) as EnvironmentThreadShell;
const child = (id: string, parent: string, props: Partial<EnvironmentThreadShell> = {}) =>
  thread(id, {
    lineage: {
      parentThreadId: parent,
      relationshipToParent: "subagent",
    } as EnvironmentThreadShell["lineage"],
    ...props,
  });
const active = { runtime: { status: "running" } as EnvironmentThreadShell["runtime"] };
describe("project conversation aggregation", () => {
  it("counts a report asking for feedback once, with or without a native request", () => {
    const root = thread("root", { reportedBlocker: "Upload the signing key or skip signing?" });
    const actions = classifyProjectActions(observeProjectThread(root));
    expect(actions).toMatchObject([{ threadId: "root", reason: "input" }]);
    expect(
      classifyProjectActions(observeProjectThread({ ...root, hasPendingUserInput: true })),
    ).toHaveLength(1);
    expect(
      aggregateProjectAttention({ members: [member], roots: [root], threads: [root] }),
    ).toMatchObject({ count: 1, working: 0, complete: true });
  });
  it("folds report feedback from an app-launched child into its visible parent", () => {
    const root = thread("root");
    const result = aggregateProjectAttention({
      members: [member],
      roots: [root],
      threads: [
        root,
        child("child", "root", {
          reportedBlocker: "Which option should I use?",
          source: { creationSource: "mcp" },
        } as unknown as Partial<EnvironmentThreadShell>),
      ],
    });
    expect(result.count).toBe(1);
    expect(result.roots[0]?.actions).toMatchObject([{ threadId: "child", reason: "input" }]);
  });
  // October 26: finished Claude Code subagents ("Close increment 1054", a
  // close review from October 25) ended their reports with Blockers and kept
  // their parents under Waiting on you, even while the parent ran.
  describe("a provider-native subagent's report", () => {
    const native = (id: string, props: Partial<EnvironmentThreadShell> = {}) =>
      child(id, "root", {
        source: { creationSource: "provider", pendingRuntimeRequest: null },
        ...props,
      } as unknown as Partial<EnvironmentThreadShell>);
    const closer = native("closer", {
      reportedBlocker: "You can close 1054 one of two ways: re-run verify, or close now.",
    });
    const aggregate = (root: EnvironmentThreadShell, sub: EnvironmentThreadShell) =>
      aggregateProjectAttention({ members: [member], roots: [root], threads: [root, sub] });

    it("is its parent's tool result, so it adds no attention", () => {
      expect(classifyProjectActions(observeProjectThread(closer))).toEqual([]);
      expect(aggregate(thread("root"), closer)).toMatchObject({ count: 0, complete: true });
      const running = aggregate(thread("root", active), closer);
      expect(running.roots[0]).toMatchObject({ actions: [], working: true });
      expect(running.working).toBe(1);
    });
    it("still surfaces the subagent's real approval or question", () => {
      for (const [kind, flag, reason] of [
        ["command", "hasPendingApprovals", "approval"],
        ["user_input", "hasPendingUserInput", "input"],
      ] as const) {
        const asking = native("closer", {
          reportedBlocker: "Close 1054?",
          [flag]: true,
          source: {
            creationSource: "provider",
            pendingRuntimeRequest: { id: `req-${kind}`, kind, createdAt: null },
          },
        } as unknown as Partial<EnvironmentThreadShell>);
        expect(aggregate(thread("root"), asking).roots[0]?.actions).toMatchObject([
          { threadId: "closer", reason },
        ]);
      }
    });
    it("leaves the parent's own report blocker waiting on the person", () => {
      const root = thread("root", { reportedBlocker: "Close 1054 now, or re-run verify?" });
      expect(aggregate(root, closer).roots[0]?.actions).toMatchObject([
        { threadId: "root", reason: "input" },
      ]);
    });
  });
  it("clears report attention when resumed, resolved, archived, deleted or removed", () => {
    const root = thread("root", { reportedBlocker: "Approve the release?" });
    for (const overrides of [
      active,
      { settledOverride: "settled" as const },
      { archivedAt: root.updatedAt },
      { deletedAt: root.updatedAt },
      { reportedBlocker: null },
      { reportedBlocker: "  " },
    ]) {
      expect(classifyProjectActions(observeProjectThread({ ...root, ...overrides }))).toEqual([]);
    }
  });
  it("clears a subagent's ask when its parent is resolved, unless asked after", () => {
    const root = thread("root", {
      settledOverride: "settled",
      settledAt: "2026-10-23T12:00:00Z",
    } as Partial<EnvironmentThreadShell>);
    const aggregate = (sub: EnvironmentThreadShell) =>
      aggregateProjectAttention({ members: [member], roots: [root], threads: [root, sub] });
    const stale = aggregate(child("review", "root", { reportedBlocker: "Close 0989?" }));
    expect(stale.count).toBe(0);
    expect(stale.roots[0]?.actions).toEqual([]);
    const fresh = aggregate(
      child("review", "root", {
        hasPendingUserInput: true,
        source: {
          pendingRuntimeRequest: {
            id: "ask-after",
            kind: "user_input",
            createdAt: DateTime.makeUnsafe("2026-10-23T13:00:00Z"),
          },
        },
      } as unknown as Partial<EnvironmentThreadShell>),
    );
    expect(fresh.roots[0]?.actions).toMatchObject([{ threadId: "review", reason: "input" }]);
  });
  it("keeps cached report feedback stale until the host reconnects", () => {
    const root = thread("root", { reportedBlocker: "Choose a signing account?" });
    const aggregate = (freshness: AttentionMember["freshness"]) =>
      aggregateProjectAttention({
        members: [{ ...member, freshness }],
        roots: [root],
        threads: [root],
      });
    expect(aggregate("offline")).toMatchObject({ count: 0, staleCount: 1, complete: false });
    expect(aggregate("live")).toMatchObject({ count: 1, staleCount: 0, complete: true });
  });
  it("reproduces 3 direct plus 2 descendant-active roots as 5 working and zero actions", () => {
    const roots = [
      thread("a", active),
      thread("b", active),
      thread("c", active),
      thread("d"),
      thread("e"),
    ];
    const result = aggregateProjectAttention({
      members: [member],
      roots,
      threads: [
        ...roots,
        child("d1", "d", active),
        child("e1", "e", active),
        child("e2", "e", active),
      ],
    });
    expect(result).toMatchObject({ count: 0, working: 5, complete: true });
  });
  it("includes coordinator, folds siblings once and retains exact targets", () => {
    const roots = [thread("coordinator", { hasPendingUserInput: true }), thread("worker")];
    const threads = [
      ...roots,
      child("a", "worker", { hasPendingApprovals: true }),
      child("b", "worker", { hasPendingUserInput: true }),
    ];
    const result = aggregateProjectAttention({
      members: [member],
      roots,
      threads: [...threads, threads[2]!],
    });
    expect(result.count).toBe(2);
    expect(result.roots[1]!.actions.map((a) => a.threadId)).toEqual(["a", "b"]);
    expect(result.roots[0]!.coordinator).toBe(true);
  });
  it.each(["empty", "cached", "synchronizing", "offline", "unauthorized"] as const)(
    "never turns %s into an all-clear",
    (freshness) => {
      const roots = [thread("a", { hasPendingUserInput: true })];
      const result = aggregateProjectAttention({
        members: [{ ...member, freshness }],
        roots,
        threads: roots,
      });
      expect(result).toMatchObject({
        complete: false,
        count: 0,
        staleCount: 1,
        label: "Attention unavailable",
      });
      expect(
        aggregateProjectAttention({ members: [member], roots, threads: [thread("a")] }),
      ).toMatchObject({ complete: true, count: 0, staleCount: 0 });
    },
  );
  it("keeps identical IDs on distinct hosts distinct and excludes other projects", () => {
    const roots = [
      thread("a", { hasPendingUserInput: true }),
      thread("a", { environmentId: "other" as never, hasPendingUserInput: true }),
      thread("outside", { projectId: "outside" as never, hasPendingUserInput: true }),
    ];
    expect(
      aggregateProjectAttention({
        members: [member, { ...member, environmentId: "other" }],
        roots,
        threads: roots,
      }).count,
    ).toBe(2);
  });
  it("marks missing ancestry and cycles incomplete without looping or inventing roots", () => {
    for (const threads of [
      [child("a", "missing", { hasPendingUserInput: true })],
      [child("a", "b"), child("b", "a")],
    ])
      expect(aggregateProjectAttention({ members: [member], roots: [], threads })).toMatchObject({
        complete: false,
        count: 0,
      });
  });
  it("excludes archived ancestors and deleted roots", () => {
    const roots = [thread("root", { archivedAt: "2026-10-23" })];
    expect(
      aggregateProjectAttention({
        members: [member],
        roots,
        threads: [...roots, child("c", "root", { hasPendingUserInput: true })],
      }).count,
    ).toBe(0);
  });
  it("sign-in is actionable, operational error and limit alone are not", () => {
    expect(
      classifyProjectActions(
        observeProjectThread(
          thread("a", {
            source: { pendingRuntimeRequest: { id: "auth", kind: "auth_refresh" } } as never,
          }),
        ),
      )[0]?.reason,
    ).toBe("signin");
    for (const status of ["failed", "limited", "waiting"])
      expect(
        classifyProjectActions(observeProjectThread(thread("a", { runtime: { status } as never }))),
      ).toEqual([]);
  });
});

describe("native child and fallback generations", () => {
  it("folds a native child with a different project ID into its explicit parent", () => {
    const root = thread("root");
    const native = child("native", "root", {
      projectId: "provider-project" as never,
      hasPendingUserInput: true,
    });
    const result = aggregateProjectAttention({
      members: [member],
      roots: [root],
      threads: [root, native],
    });
    expect(result.count).toBe(1);
    expect(result.roots[0]?.actions[0]?.projectId).toBe("provider-project");
  });
  it("invalidates a prior held generation after discard and requeue in the same run", () => {
    const before = classifyProjectActions(
      observeProjectThread(thread("a", { heldQueuedCount: 1 })),
    )[0]!;
    const after = classifyProjectActions(
      observeProjectThread(thread("a", { heldQueuedCount: 1, updatedAt: "2026-10-23T01:00:00Z" })),
    )[0]!;
    expect(before.key).not.toBe(after.key);
  });
  it("trusts an authoritative empty request over stale legacy flags", () => {
    expect(
      classifyProjectActions(
        observeProjectThread(
          thread("a", {
            hasPendingUserInput: true,
            source: { pendingRuntimeRequest: null } as never,
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("remote follower aliases", () => {
  it("marks an unmatched follower unknown and never duplicates a loaded root", () => {
    const root = thread("remote", { hasPendingUserInput: true });
    const remoteWorkers = [{ environmentId: "host", remoteThreadId: "remote", state: "following" }];
    expect(
      aggregateProjectAttention({
        members: [{ ...member, remoteWorkers }],
        roots: [root],
        threads: [root],
      }),
    ).toMatchObject({ count: 1, complete: true });
    expect(
      aggregateProjectAttention({
        members: [{ ...member, remoteWorkers }],
        roots: [],
        threads: [],
      }),
    ).toMatchObject({ count: 0, complete: false });
  });
  it("qualifies known actions while follower coverage is unavailable", () => {
    const root = thread("a", { hasPendingUserInput: true });
    expect(
      aggregateProjectAttention({
        members: [{ ...member, remoteWorkersComplete: false }],
        roots: [root],
        threads: [root],
      }),
    ).toMatchObject({ count: 1, complete: false, label: "1 waiting on you · partial" });
  });
});

describe("ownership and remote permissions", () => {
  it("keeps a missing fork ancestor incomplete", () => {
    const fork = thread("fork", {
      createdBy: "agent",
      lineage: { parentThreadId: "missing", relationshipToParent: "fork" } as never,
      hasPendingUserInput: true,
    });
    expect(
      aggregateProjectAttention({ members: [member], roots: [], threads: [fork] }),
    ).toMatchObject({ complete: false, count: 0 });
  });
  it("does not hide caller-side remote permission loss behind an idle loaded alias", () => {
    const root = thread("remote");
    expect(
      aggregateProjectAttention({
        members: [
          {
            ...member,
            remoteWorkers: [
              { environmentId: "host", remoteThreadId: "remote", state: "paused_auth" },
            ],
          },
        ],
        roots: [root],
        threads: [root],
      }),
    ).toMatchObject({ complete: false, count: 0 });
  });
});

it("does not prove zero for a subagent whose parent identity is absent", () => {
  const orphan = thread("orphan", {
    lineage: { parentThreadId: null, relationshipToParent: "subagent" } as never,
  });
  expect(
    aggregateProjectAttention({ members: [member], roots: [], threads: [orphan] }),
  ).toMatchObject({ count: 0, complete: false });
});
