import { describe, expect, it } from "vite-plus/test";

import { type BlockerRow, personWaitThreads, summarizeBlockers } from "./ServiceUpdateBlockers.ts";

const row = (
  kind: BlockerRow["kind"],
  threadId: string | null,
  requestKind?: string,
): BlockerRow => ({
  kind,
  threadId,
  threadTitle: threadId,
  projectId: "p1",
  projectTitle: "Project",
  ...(requestKind === undefined ? {} : { requestKind }),
});

describe("personWaitThreads", () => {
  it("marks a turn paused on a question or approval as waiting on a person", () => {
    const rows = [
      row("run", "paused"),
      row("session", "paused"),
      row("request", "paused", "user_input"),
      row("request", "approval", "command"),
      row("run", "working"),
    ];
    expect([...personWaitThreads(rows)].toSorted()).toEqual(["approval", "paused"]);
  });

  it("leaves a thread with a sign-in, a tool call, a queued message or an effect as work", () => {
    const rows = [
      row("request", "sign-in", "auth_refresh"),
      row("request", "tool", "dynamic_tool_call"),
      row("request", "queued", "user_input"),
      row("queued", "queued"),
      row("request", "effect", "command"),
      row("effect", "effect"),
      row("request", "mixed", "permission"),
      row("request", "mixed", "auth_refresh"),
    ];
    expect([...personWaitThreads(rows)]).toEqual([]);
  });

  it("needs a request: a run alone is work", () => {
    expect([...personWaitThreads([row("run", "t1"), row("session", "t1")])]).toEqual([]);
  });
});

describe("summarizeBlockers", () => {
  it("flags every blocker of a thread that only waits on a person", () => {
    const blockers = summarizeBlockers([
      row("run", "paused"),
      row("request", "paused", "file-change"),
      row("run", "working"),
    ]);
    expect(
      blockers.map((blocker) => [blocker.kind, blocker.threadId, blocker.waitsOnPerson]),
    ).toEqual([
      ["run", "paused", true],
      ["run", "working", undefined],
      ["request", "paused", true],
    ]);
  });
});
