import { describe, expect, it } from "vite-plus/test";
import {
  coordinatorReplySources,
  type CoordinatorSourceMessage,
} from "./coordinatorReplySources.ts";

const reply = (id = "reply", runId: string | null = "run"): CoordinatorSourceMessage => ({
  id,
  role: "assistant",
  runId,
});
const sender = (threadId: string, runId = "run"): CoordinatorSourceMessage => ({
  id: threadId,
  role: "user",
  runId,
  senderThreadId: threadId,
});

describe("coordinator reply sources", () => {
  it("joins several persisted triggers by run and deduplicates thread identities", () => {
    expect(
      coordinatorReplySources(
        [sender("a"), sender("b"), sender("a"), sender("old", "other"), reply()],
        "local",
      ).get("reply"),
    ).toEqual([
      { kind: "thread", threadId: "a", environmentId: "local" },
      { kind: "thread", threadId: "b", environmentId: "local" },
    ]);
  });
  it("preserves remote identity and distinguishes identical IDs on different environments", () => {
    const trigger = {
      id: "event",
      role: "system",
      runId: "run",
      notification: {
        source: { kind: "background_task" },
        replySources: [
          {
            kind: "thread" as const,
            threadId: "a",
            environmentId: "remote",
            title: "Remote worker",
          },
        ],
      },
    };
    expect(coordinatorReplySources([sender("a"), trigger, reply()], "local").get("reply")).toEqual([
      { kind: "thread", threadId: "a", environmentId: "local" },
      { kind: "thread", threadId: "a", environmentId: "remote", title: "Remote worker" },
    ]);
  });
  it("retains source data across JSON reload and applies it to every streaming/final reply in that run", () => {
    const messages = JSON.parse(
      JSON.stringify([sender("a"), reply("stream"), reply("final")]),
    ) as CoordinatorSourceMessage[];
    const sources = coordinatorReplySources(messages, "local");
    expect(sources.get("stream")).toEqual(sources.get("final"));
    expect(sources.get("final")).toHaveLength(1);
  });
  it("uses childThreadId for legacy task records without parsing their prose", () => {
    expect(
      coordinatorReplySources(
        [
          {
            id: "trigger",
            role: "user",
            runId: "run",
            notification: { source: { kind: "delegated_task", childThreadId: "child" } },
          },
          reply(),
        ],
        "local",
      ).get("reply"),
    ).toEqual([{ kind: "thread", threadId: "child", environmentId: "local" }]);
  });
  it("does not attribute an unrelated or unbound trigger to a user turn", () => {
    expect(
      coordinatorReplySources(
        [sender("a", "other"), { ...sender("b"), runId: null }, reply(), reply("unbound", null)],
        "local",
      ).size,
    ).toBe(0);
  });
  it("uses a validated PR link and refuses executable or credential-bearing URLs", () => {
    const messages: CoordinatorSourceMessage[] = [
      {
        id: "pr",
        role: "system",
        runId: "run",
        notification: {
          source: { kind: "monitor" },
          replySources: [
            { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "PR #1" },
            { kind: "pull_request", url: "javascript:alert(1)", title: "PR #2" },
            { kind: "pull_request", url: "https://secret@github.com/o/r/pull/3", title: "PR #3" },
          ],
        },
      },
      reply(),
    ];
    expect(coordinatorReplySources(messages, "local").get("reply")).toEqual([
      { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "PR #1" },
      { kind: "event", title: "PR #2" },
      { kind: "event", title: "PR #3" },
    ]);
  });
  it("keeps a historical monitor visible without inventing a thread or URL", () => {
    expect(
      coordinatorReplySources(
        [
          {
            id: "monitor",
            role: "system",
            runId: "run",
            notification: { source: { kind: "monitor" } },
          },
          reply(),
        ],
        "local",
      ).get("reply"),
    ).toEqual([{ kind: "event", title: "Monitor update" }]);
  });
});

it("bounds foreign source titles to one short line", () => {
  const result = coordinatorReplySources(
    [
      {
        id: "trigger",
        role: "system",
        runId: "run",
        notification: {
          source: { kind: "background_task" },
          replySources: [
            { kind: "thread", threadId: "worker", title: "A".repeat(200) + "\nHidden detail" },
            { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "PR #1\nExtra" },
            { kind: "event", title: "Monitor\nExtra" },
          ],
        },
      },
      reply(),
    ],
    "local",
  ).get("reply")!;
  expect(result.map((source) => source.title)).toEqual(["A".repeat(79) + "…", "PR #1", "Monitor"]);
});

it("drops receiving-thread references while retaining PR and same-ID remote sources", () => {
  const sources = coordinatorReplySources(
    [
      {
        id: "trigger",
        role: "system",
        runId: "run",
        notification: {
          source: { kind: "monitor" },
          replySources: [
            { kind: "thread", threadId: "coord" },
            { kind: "thread", threadId: "coord", environmentId: "remote" },
            { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "PR #1" },
          ],
        },
      },
      sender("coord"),
      reply(),
    ],
    "local",
    "coord",
  ).get("reply");
  expect(sources).toEqual([
    { kind: "thread", threadId: "coord", environmentId: "remote" },
    { kind: "pull_request", url: "https://github.com/o/r/pull/1", title: "PR #1" },
  ]);
});
