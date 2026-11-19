/**
 * 1390 AC-28: an automatic hand off raises one notification on each machine.
 * The source's copy gets its note, the continuation arrives with its own; a move
 * by hand has no note and raises nothing.
 */
import type {
  OrchestrationV2ThreadProjectMoveLink,
  OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { handoffNoticeOf, observeHandoffNotices } from "./handoffNotice.logic";

const note = "Handed off to M5 at 14:02: Claude limit reached on M4";
const link = (patch: Partial<OrchestrationV2ThreadProjectMoveLink>) =>
  ({
    threadId: "thread-other",
    projectId: "project-1",
    title: "Ship the release",
    movedAt: "2026-11-19T14:02:00.000Z",
    kind: "handoff",
    environmentId: "env-m5",
    machineLabel: "M5",
    ...patch,
  }) as OrchestrationV2ThreadProjectMoveLink;
const thread = (id: string, patch: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id,
    projectId: "project-1",
    title: "Ship the release",
    movedTo: null,
    movedFrom: null,
    ...patch,
  }) as unknown as OrchestrationV2ThreadShell;

describe("handoffNoticeOf", () => {
  it("names the machine and keeps the line on the source", () => {
    expect(handoffNoticeOf(thread("t1", { movedTo: link({ note }) }))).toEqual({
      identity: "moved-to:thread-other",
      title: "Handed off to M5",
      body: note,
    });
  });

  it("names the source on the continuation", () => {
    expect(
      handoffNoticeOf(
        thread("t2", {
          movedFrom: link({ threadId: "t1", machineLabel: "M4", environmentId: "env-m4" as never, note }),
        }),
      ),
    ).toEqual({ identity: "moved-from:t1", title: "Continued here from M4", body: note });
  });

  it("is null for a move by hand, a project move, or a thread that never moved", () => {
    expect(handoffNoticeOf(thread("t1", { movedTo: link({}) }))).toBeNull();
    expect(handoffNoticeOf(thread("t1", { movedFrom: link({}) }))).toBeNull();
    expect(handoffNoticeOf(thread("t1", { movedTo: link({ kind: "project", note }) }))).toBeNull();
    expect(handoffNoticeOf(thread("t1"))).toBeNull();
  });
});

describe("observeHandoffNotices", () => {
  it("announces nothing from history on the first pass", () => {
    const first = observeHandoffNotices(null, [thread("t1", { movedTo: link({ note }) })]);
    expect(first.notices).toEqual([]);
    expect(first.seen.get("t1" as never)).toBe("moved-to:thread-other");
  });

  it("announces a note that appears, once, and a continuation that arrives with one", () => {
    const first = observeHandoffNotices(null, [thread("t1")]);
    const second = observeHandoffNotices(first.seen, [
      thread("t1", { movedTo: link({ note }) }),
      thread("t2", { movedFrom: link({ threadId: "t9", machineLabel: "M4", note }) }),
    ]);
    expect(second.notices.map((notice) => [notice.thread.id, notice.notice.title])).toEqual([
      ["t1", "Handed off to M5"],
      ["t2", "Continued here from M4"],
    ]);
    const third = observeHandoffNotices(second.seen, [
      thread("t1", { movedTo: link({ note }) }),
      thread("t2", { movedFrom: link({ threadId: "t9", machineLabel: "M4", note }) }),
    ]);
    expect(third.notices).toEqual([]);
  });

  it("stays quiet for a move by hand", () => {
    const first = observeHandoffNotices(null, [thread("t1")]);
    const second = observeHandoffNotices(first.seen, [
      thread("t1", { movedTo: link({}) }),
      thread("t2", { movedFrom: link({ threadId: "t1" }) }),
    ]);
    expect(second.notices).toEqual([]);
  });
});
