import { describe, expect, it } from "vite-plus/test";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { mobileReplySources, replySourceThreadTarget } from "./replySourceModel";

function message(id: string, role: "user" | "assistant", runId: string, senderThreadId?: string) {
  return {
    type: "message",
    message: { id, role, runId, senderThreadId, text: id, attachments: [] },
  } as unknown as ThreadFeedEntry;
}
function notification(runId: string, source: object) {
  return {
    type: "activity-group",
    activities: [
      {
        id: `notification:${runId}`,
        projectedItem: {
          item: {
            type: "notification",
            runId,
            source: { kind: "monitor" },
            replySources: [source],
          },
        },
      },
    ],
  } as unknown as ThreadFeedEntry;
}

describe("mobile coordinator reply source links", () => {
  it("keeps persisted notification and sender sources together after reload", () => {
    const feed = [
      message("trigger", "user", "run", "local-worker"),
      notification("run", {
        kind: "thread",
        environmentId: "remote",
        threadId: "remote-worker",
        title: "Build mobile",
      }),
      message("reply", "assistant", "run"),
      message("unrelated", "assistant", "next-run"),
    ];
    const sources = mobileReplySources(JSON.parse(JSON.stringify(feed)), "local", {
      threadId: "project-coordinator:project",
    });
    expect(sources.get("reply")).toEqual([
      { kind: "thread", environmentId: "local", threadId: "local-worker" },
      { kind: "thread", environmentId: "remote", threadId: "remote-worker", title: "Build mobile" },
    ]);
    expect(sources.has("unrelated")).toBe(false);
  });

  it("retains a PR-only event without manufacturing a worker", () => {
    const sources = mobileReplySources(
      [
        notification("run", {
          kind: "pull_request",
          url: "https://github.com/example/app/pull/1",
          title: "PR #1",
        }),
        message("reply", "assistant", "run"),
      ],
      "local",
      { threadId: "project-coordinator:project" },
    );
    expect(sources.get("reply")).toEqual([
      { kind: "pull_request", url: "https://github.com/example/app/pull/1", title: "PR #1" },
    ]);
  });

  it("does not show coordinator chips in a worker or ordinary chat", () => {
    const feed = [
      message("trigger", "user", "run", "parent"),
      message("reply", "assistant", "run"),
    ];
    expect(
      mobileReplySources(feed, "local", { threadId: "worker", coordinatorThreadId: "coordinator" })
        .size,
    ).toBe(0);
  });

  it("shows one chip on the first visible assistant message of each coordinator run", () => {
    const feed = [
      message("trigger", "user", "run", "worker"),
      message("first", "assistant", "run"),
      message("last", "assistant", "run"),
    ];
    expect([
      ...mobileReplySources(feed, "local", {
        threadId: "custom",
        coordinatorThreadId: "custom",
      }).keys(),
    ]).toEqual(["first"]);
    expect([
      ...mobileReplySources(feed, "local", {
        threadId: "custom",
        coordinatorThreadId: "custom",
        visibleMessageIds: new Set(["last"]),
      }).keys(),
    ]).toEqual(["last"]);
  });

  it("uses the precise connected environment, with no local-ID fallback", () => {
    const source = { kind: "thread" as const, threadId: "same-id", environmentId: "remote" };
    const local = { environmentId: "local", isEnabled: true, connectionState: "connected" };
    expect(replySourceThreadTarget(source, [local])).toBeNull();
    expect(
      replySourceThreadTarget(source, [
        local,
        { ...local, environmentId: "remote", connectionState: "error" },
      ]),
    ).toBeNull();
    expect(
      replySourceThreadTarget(source, [{ ...local, environmentId: "remote", isEnabled: false }]),
    ).toBeNull();
    expect(replySourceThreadTarget(source, [{ ...local, environmentId: "remote" }])).toEqual({
      threadId: "same-id",
      environmentId: "remote",
    });
  });

  it("allows archived or unloaded thread navigation without requiring a sidebar shell", () => {
    expect(
      replySourceThreadTarget({ kind: "thread", threadId: "archived", environmentId: "remote" }, [
        { environmentId: "remote", isEnabled: true, connectionState: "connected" },
      ]),
    ).toEqual({ threadId: "archived", environmentId: "remote" });
  });
});
