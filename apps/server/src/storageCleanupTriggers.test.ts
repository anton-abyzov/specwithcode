import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ServerSettings,
} from "@specweave-studio/contracts";
import { RunId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  LOW_DISK_BACKOFF_FIRST_MS,
  LOW_DISK_BACKOFF_MAX_MS,
  LowDiskBackoff,
  MergedPullRequests,
  SweepScope,
  sweepThreadAfterEvent,
} from "./storageCleanupTriggers.ts";
import {
  storageCleanupFollowsParent,
  storageCleanupThreadFinished,
} from "./worktreeCleanupRules.ts";
import { baseSettings, NOW_MS, shell } from "./worktreeCleanupSweep.testkit.ts";

const THREAD = "thread-1";

/** Only the fields the trigger reads; the rest of an event does not matter to it. */
const event = (type: string, payload: Record<string, unknown> = {}) =>
  ({ type, threadId: THREAD, payload }) as unknown as OrchestrationV2DomainEvent;

const settings = (overrides: Partial<ServerSettings["storageCleanup"]>): ServerSettings => ({
  ...baseSettings,
  storageCleanup: { ...baseSettings.storageCleanup, ...overrides },
});

const mergedLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 7,
  snapshot: { state: "merged" },
};

describe("what asks for a sweep of one chat's folders", () => {
  it.each([
    ["a run completing", event("run.updated", { status: "completed" })],
    ["a chat resolved", event("thread.settled")],
    ["a chat archived", event("thread.archived")],
    [
      "a pull request newly merged",
      event("thread.pull-request-synced", { id: THREAD, pullRequests: [mergedLink] }),
    ],
  ])("%s asks for that chat", (_name, domainEvent) => {
    expect(sweepThreadAfterEvent(domainEvent, baseSettings, new MergedPullRequests(), true)).toBe(
      THREAD,
    );
  });

  it.each([
    ["a run starting", event("run.updated", { status: "running" })],
    ["a run failing", event("run.updated", { status: "failed" })],
    ["a session turning ready", event("provider-session.updated", { status: "ready" })],
    ["a session stopping with no delete rule", event("provider-session.updated", { status: "stopped" })],
    ["a chat deleted with no delete rule", event("thread.deleted")],
    ["a message", event("message.created")],
    [
      "a pull request still open",
      event("thread.pull-request-synced", {
        id: THREAD,
        pullRequests: [{ ...mergedLink, snapshot: { state: "open" } }],
      }),
    ],
  ])("%s asks for nothing", (_name, domainEvent) => {
    expect(
      sweepThreadAfterEvent(domainEvent, baseSettings, new MergedPullRequests(), true),
    ).toBeNull();
  });

  it("asks once for a merged pull request, however often it is synced", () => {
    const merged = new MergedPullRequests();
    const sync = event("thread.pull-request-synced", { id: THREAD, pullRequests: [mergedLink] });
    expect(sweepThreadAfterEvent(sync, baseSettings, merged, true)).toBe(THREAD);
    expect(sweepThreadAfterEvent(sync, baseSettings, merged, true)).toBeNull();
  });

  it("remembers a merge seen while every rule is off, so switching one on is not news", () => {
    const merged = new MergedPullRequests();
    const sync = event("thread.pull-request-synced", { id: THREAD, pullRequests: [mergedLink] });
    expect(sweepThreadAfterEvent(sync, baseSettings, merged, false)).toBeNull();
    expect(sweepThreadAfterEvent(sync, baseSettings, merged, true)).toBeNull();
  });

  it("asks for nothing on a completed run when the merge rule is off", () => {
    const off = settings({ worktreeOnMerge: false });
    const done = event("run.updated", { status: "completed" });
    expect(sweepThreadAfterEvent(done, off, new MergedPullRequests(), true)).toBeNull();
  });

  it("asks for a deleted chat, and its session stopping, only under the delete rule", () => {
    const on = settings({ worktreeOnDelete: true });
    const merged = new MergedPullRequests();
    expect(sweepThreadAfterEvent(event("thread.deleted"), on, merged, true)).toBe(THREAD);
    expect(
      sweepThreadAfterEvent(
        event("provider-session.updated", { status: "stopped" }),
        on,
        merged,
        true,
      ),
    ).toBe(THREAD);
    expect(
      sweepThreadAfterEvent(event("provider-session.updated", { status: "ready" }), on, merged, true),
    ).toBeNull();
  });
});

describe("what the next sweep covers", () => {
  it("covers the chats asked for, then starts again", () => {
    const scope = new SweepScope();
    expect(scope.empty).toBe(true);
    scope.addThread("a");
    scope.addThread("b");
    scope.addThread("a");
    expect(scope.empty).toBe(false);
    expect([...(scope.take() ?? [])]).toEqual(["a", "b"]);
    expect(scope.empty).toBe(true);
    expect(scope.take()?.size).toBe(0);
  });

  it("covers every folder once that was asked for, whatever came before or after", () => {
    const scope = new SweepScope();
    scope.addThread("a");
    scope.addAll();
    scope.addThread("b");
    expect(scope.empty).toBe(false);
    expect(scope.take()).toBeNull();
    expect(scope.empty).toBe(true);
  });
});

describe("low disk backs off while passes remove nothing", () => {
  it("doubles the wait from two minutes to an hour, and starts over once something goes", () => {
    const backoff = new LowDiskBackoff();
    expect(backoff.allows(0)).toBe(true);

    backoff.notePass(0, 0);
    expect(backoff.allows(LOW_DISK_BACKOFF_FIRST_MS - 1)).toBe(false);
    expect(backoff.allows(LOW_DISK_BACKOFF_FIRST_MS)).toBe(true);

    backoff.notePass(0, 0);
    expect(backoff.allows(2 * LOW_DISK_BACKOFF_FIRST_MS - 1)).toBe(false);
    expect(backoff.allows(2 * LOW_DISK_BACKOFF_FIRST_MS)).toBe(true);

    for (let pass = 0; pass < 12; pass += 1) backoff.notePass(0, 0);
    expect(backoff.allows(LOW_DISK_BACKOFF_MAX_MS - 1)).toBe(false);
    expect(backoff.allows(LOW_DISK_BACKOFF_MAX_MS)).toBe(true);

    backoff.notePass(3, 0);
    expect(backoff.allows(0)).toBe(true);
    backoff.notePass(0, 0);
    expect(backoff.allows(LOW_DISK_BACKOFF_FIRST_MS)).toBe(true);
  });

  it("starts over when the disk returns to ok", () => {
    const backoff = new LowDiskBackoff();
    backoff.notePass(0, 0);
    backoff.notePass(0, 0);
    backoff.reset();
    expect(backoff.allows(0)).toBe(true);
    backoff.notePass(0, 0);
    expect(backoff.allows(LOW_DISK_BACKOFF_FIRST_MS)).toBe(true);
  });
});

describe("a chat nobody resolved counts as finished", () => {
  const chat = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    shell({
      worktreePath: "/worktrees/feature",
      status: "completed",
      latestRunId: RunId.make("run-1"),
      ...overrides,
    });

  it("when its last run completed and nothing waits", () => {
    expect(storageCleanupThreadFinished(chat({}), NOW_MS)).toBe(true);
  });

  it.each(["idle", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "not when its last run ended as %s",
    (status) => {
      expect(storageCleanupThreadFinished(chat({ status }), NOW_MS)).toBe(false);
    },
  );

  it("not while a run works or waits, a message is held, or it never ran", () => {
    expect(storageCleanupThreadFinished(chat({ activeRunId: RunId.make("run-2") }), NOW_MS)).toBe(
      false,
    );
    expect(storageCleanupThreadFinished(chat({ activityRunStatus: "waiting" }), NOW_MS)).toBe(
      false,
    );
    expect(storageCleanupThreadFinished(chat({ heldQueuedCount: 1 }), NOW_MS)).toBe(false);
    expect(storageCleanupThreadFinished(chat({ latestRunId: null }), NOW_MS)).toBe(false);
  });

  it("judges a sub-chat with no run of its own by its parent in the same folder", () => {
    const parent = ThreadId.make("parent");
    const helper = chat({
      latestRunId: null,
      lineage: { ...shell().lineage, parentThreadId: parent, relationshipToParent: "subagent" },
    });
    expect(storageCleanupFollowsParent(helper, new Set([parent]))).toBe(true);
    // Its parent works elsewhere, it ran itself, or it is a fork: judged on its own.
    expect(storageCleanupFollowsParent(helper, new Set())).toBe(false);
    expect(
      storageCleanupFollowsParent({ ...helper, latestRunId: RunId.make("run-1") }, new Set([parent])),
    ).toBe(false);
    expect(
      storageCleanupFollowsParent(
        { ...helper, lineage: { ...helper.lineage, relationshipToParent: "fork" } },
        new Set([parent]),
      ),
    ).toBe(false);
  });
});
