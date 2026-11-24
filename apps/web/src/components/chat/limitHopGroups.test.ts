import {
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { englishPhrase } from "../../i18n";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { foldLimitHops, limitHopsSummary, type LimitHopsRow } from "./limitHopGroups";

type VisibleTurnItem = Parameters<
  typeof deriveTimelineEntriesFromVisibleTurnItems
>[0]["visibleTurnItems"][number];
type TurnItem = VisibleTurnItem["item"];

const threadId = ThreadId.make("thread-ping-pong");
const at = (second: number) =>
  DateTime.makeUnsafe(new Date(Date.UTC(2026, 10, 1, 10, 0, second)).toISOString());

/** Builds a thread's turn items in order; each call takes the next ordinal. */
function thread() {
  const items: TurnItem[] = [];
  const base = (id: string, run: string) => {
    const ordinal = items.length;
    return {
      id: TurnItemId.make(id),
      threadId,
      runId: RunId.make(run),
      nodeId: NodeId.make(`node-${run}`),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(ordinal),
      completedAt: at(ordinal),
      updatedAt: at(ordinal),
    };
  };
  const api = {
    prompt(id: string, run: string, text = "Build it") {
      items.push({
        ...base(id, run),
        type: "user_message",
        messageId: MessageId.make(id),
        text,
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      });
      return api;
    },
    reply(id: string, run: string, text: string) {
      items.push({
        ...base(id, run),
        type: "assistant_message",
        messageId: MessageId.make(id),
        text,
        streaming: false,
      });
      return api;
    },
    limit(id: string, run: string, message = "Usage limit") {
      items.push({
        ...base(id, run),
        type: "error",
        status: "failed",
        failure: { class: "usage_limit", message, code: null, retryable: null },
      });
      return api;
    },
    /** The rule's switch and its "continue" request, which open the next run. */
    hop(stoppedRun: string, nextRun: string, from: string, to: string) {
      items.push({
        ...base(`handoff-${nextRun}`, nextRun),
        type: "handoff",
        contextHandoffId: ContextHandoffId.make(`context-${nextRun}`),
        fromProviderThreadIds: [],
        toProviderThreadId: ProviderThreadId.make(`provider-thread-${nextRun}`),
        fromProviderInstanceIds: [ProviderInstanceId.make(from)],
        toProviderInstanceId: ProviderInstanceId.make(to),
        strategy: "full_thread_summary",
      });
      const noteId = `limit-fallback:${threadId}:${stoppedRun}`;
      items.push({
        ...base(noteId, nextRun),
        type: "user_message",
        messageId: MessageId.make(noteId),
        text: "Continue where you left off.",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "server",
      });
      return api;
    },
    rows(
      expandedWorkGroupIds?: ReadonlySet<string>,
      timelineDetail: "concise" | "normal" | "verbose" = "normal",
    ) {
      const lastRun = items.at(-1)!.runId!;
      return deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items.map((item, position): VisibleTurnItem => ({
            position,
            visibility: "local",
            sourceThreadId: threadId,
            sourceItemId: item.id,
            item,
          })),
          optimisticMessages: [],
        }),
        latestRun: {
          runId: lastRun,
          status: "failed",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: DateTime.formatIso(at(items.length)),
        },
        isWorking: false,
        ...(expandedWorkGroupIds === undefined ? {} : { expandedWorkGroupIds }),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        timelineDetail,
      });
    },
  };
  return api;
}

/** Copilot and Cursor alternating: run-1 stops, run-2 continues on Cursor and stops, ... */
function pingPong(hops: number, refusalText = false) {
  const built = thread().prompt("prompt", "run-1").reply("answer", "run-1", "Starting the build.");
  for (let hop = 1; hop <= hops; hop += 1) {
    const run = `run-${hop}`;
    if (refusalText && hop > 1)
      built.reply(`refusal-${hop}`, run, "Error: You have exceeded your monthly quota");
    built.limit(`limit-${hop}`, run);
    const [from, to] = hop % 2 === 1 ? ["copilot", "cursor"] : ["cursor", "copilot"];
    built.hop(run, `run-${hop + 1}`, from, to);
  }
  return built;
}

const shape = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.map((row) =>
    row.kind === "message"
      ? `${row.message.role}:${row.message.id}`
      : row.kind === "limit-hops"
        ? `limit-hops:${row.hopCount}`
        : row.kind === "work"
          ? `work:${row.id}`
          : row.kind,
  );

const hopsRow = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.find((row): row is LimitHopsRow => row.kind === "limit-hops");

const NAMES: Record<string, string> = { copilot: "Copilot", cursor: "Cursor" };
const summaryOf = (row: LimitHopsRow) =>
  limitHopsSummary(
    row.hopCount,
    row.sourceInstanceIds.map((id) => NAMES[id] ?? id),
    englishPhrase,
    (names) => new Intl.ListFormat("en", { type: "conjunction" }).format(names),
  );

describe("limit hop groups (1460 AC-06)", () => {
  it("folds alternating hops into one row with the count and each source once", () => {
    const rows = pingPong(14).rows();
    expect(rows.filter((row) => row.kind === "limit-hops")).toHaveLength(1);
    const row = hopsRow(rows)!;
    expect(row.hopCount).toBe(14);
    expect(row.sourceInstanceIds).toEqual(["copilot", "cursor"]);
    expect(row.expanded).toBe(false);
    expect(summaryOf(row)).toBe("Usage limits · switched 14 times between Copilot and Cursor");
    // The prompt and the first reply stay; no failure, switch or note shows.
    expect(shape(rows)).toEqual([
      "user:prompt",
      "assistant:answer",
      "assistant-meta",
      "limit-hops:14",
    ]);
  });

  it("takes a stopped run's refusal text into the group", () => {
    const rows = pingPong(3, true).rows();
    expect(shape(rows)).toEqual([
      "user:prompt",
      "assistant:answer",
      "assistant-meta",
      "limit-hops:3",
    ]);
  });

  it("keeps a stop that has not continued yet below the summary", () => {
    const rows = pingPong(3).limit("limit-4", "run-4").rows();
    expect(shape(rows).slice(-2)).toEqual(["limit-hops:3", "work:limit-4"]);
  });

  it("splits groups at a person's message", () => {
    const rows = pingPong(2)
      .prompt("nudge", "run-3", "Keep going")
      .limit("limit-3", "run-3")
      .hop("run-3", "run-4", "copilot", "cursor")
      .limit("limit-4", "run-4")
      .hop("run-4", "run-5", "cursor", "copilot")
      .rows();
    expect(
      shape(rows).filter((kind) => kind.startsWith("limit-hops") || kind === "user:nudge"),
    ).toEqual(["limit-hops:2", "user:nudge", "limit-hops:2"]);
  });

  it("splits groups at a reply from a run that did not stop", () => {
    const rows = thread()
      .prompt("prompt", "run-1")
      .limit("limit-1", "run-1")
      .hop("run-1", "run-2", "copilot", "cursor")
      .reply("real-answer", "run-2", "Here is the fix.")
      .prompt("next", "run-3", "Now the tests")
      .limit("limit-3", "run-3")
      .hop("run-3", "run-4", "cursor", "copilot")
      .limit("limit-4", "run-4")
      .hop("run-4", "run-5", "copilot", "cursor")
      .rows();
    const kinds = shape(rows);
    // The single hop before the reply is untouched: its failure, switch and note show.
    expect(kinds.slice(0, 4)).toEqual([
      "user:prompt",
      "work:limit-1",
      "event",
      `user:limit-fallback:${threadId}:run-1`,
    ]);
    expect(kinds).toContain("assistant:real-answer");
    expect(kinds.filter((kind) => kind.startsWith("limit-hops"))).toEqual(["limit-hops:2"]);
  });

  it("keeps a real answer from a run that later stopped in view", () => {
    const built = pingPong(2);
    built.reply("worked", "run-3", "I fixed the parser and the tests pass now.");
    built.limit("limit-3", "run-3").hop("run-3", "run-4", "copilot", "cursor");
    built.limit("limit-4", "run-4").hop("run-4", "run-5", "cursor", "copilot");
    const kinds = shape(built.rows());
    expect(kinds).toContain("assistant:worked");
    expect(kinds.filter((kind) => kind.startsWith("limit-hops"))).toEqual([
      "limit-hops:2",
      "limit-hops:2",
    ]);
  });

  it("takes the incident's Cursor refusal into the group by the run's own failure", () => {
    const cursor =
      "Gemini 4 Neon is not included in your weekly usage. Switch models or buy credits.";
    const built = thread()
      .prompt("prompt", "run-1")
      .reply("answer", "run-1", "Starting the build.");
    built.limit("limit-1", "run-1").hop("run-1", "run-2", "copilot", "cursor");
    built.reply("refusal-2", "run-2", cursor).limit("limit-2", "run-2", cursor);
    built.hop("run-2", "run-3", "cursor", "copilot");
    built.reply("refusal-3", "run-3", "Error: You have exceeded your monthly quota");
    built.limit("limit-3", "run-3", "Monthly quota used up on this provider.");
    built.hop("run-3", "run-4", "copilot", "cursor");
    expect(shape(built.rows())).toEqual([
      "user:prompt",
      "assistant:answer",
      "assistant-meta",
      "limit-hops:3",
    ]);
  });

  it("keeps a short answer that mentions a quota in view", () => {
    const built = pingPong(2);
    built.reply("bucket", "run-3", "The bucket quota is 5 GB; the upload exceeded it.");
    built.limit("limit-3", "run-3").hop("run-3", "run-4", "copilot", "cursor");
    built.limit("limit-4", "run-4").hop("run-4", "run-5", "cursor", "copilot");
    expect(shape(built.rows())).toContain("assistant:bucket");
  });

  it("stays open when earlier hops load above the one it was opened under", () => {
    const full = pingPong(5);
    const firstId = hopsRow(full.rows())!.groupId;
    const later = full
      .rows(new Set([firstId]))
      .find((row) => row.kind === "work" && row.id.includes("limit-3"))!;
    const laterId = `limit-hops:${later.id}`;
    const row = hopsRow(pingPong(5).rows(new Set([laterId])))!;
    expect(row.expanded).toBe(true);
    // Closing it removes the id it was opened under.
    expect(row.groupId).toBe(laterId);
  });

  it("leaves a single hop as it is", () => {
    const rows = pingPong(1).rows();
    expect(hopsRow(rows)).toBeUndefined();
    expect(shape(rows)).toEqual([
      "user:prompt",
      "assistant:answer",
      "work:limit-1",
      "assistant-meta",
      "event",
      `user:limit-fallback:${threadId}:run-1`,
    ]);
    const plain = rows.filter((row) => row.kind !== "limit-hops");
    expect(foldLimitHops(plain, () => false)).toEqual(plain);
  });

  it("shows the original rows under the open summary", () => {
    const closed = pingPong(3).rows();
    const groupId = hopsRow(closed)!.groupId;
    const open = pingPong(3).rows(new Set([groupId]));
    const row = hopsRow(open)!;
    expect(row.expanded).toBe(true);
    const index = open.indexOf(row);
    const originals = open.slice(index + 1);
    expect(originals).toHaveLength(9);
    expect(originals.every((original) => original.withinToolActivity === true)).toBe(true);
    expect(shape(originals).slice(0, 3)).toEqual([
      "work:limit-1",
      "event",
      `user:limit-fallback:${threadId}:run-1`,
    ]);
    // The id stays put as hops append, so an open group stays open.
    expect(hopsRow(pingPong(5).rows(new Set([groupId])))?.expanded).toBe(true);
  });

  it("folds the same way at every detail level; verbose opens it", () => {
    for (const detail of ["concise", "normal"] as const)
      expect(shape(pingPong(3, true).rows(undefined, detail)).slice(-1), detail).toEqual([
        "limit-hops:3",
      ]);
    const verbose = pingPong(3, true).rows(undefined, "verbose");
    expect(hopsRow(verbose)?.expanded).toBe(true);
    expect(verbose.filter((row) => row.withinToolActivity).length).toBeGreaterThan(8);
  });

  it("names one source or none plainly", () => {
    const tx = englishPhrase;
    const join = (names: ReadonlyArray<string>) => names.join(" and ");
    expect(limitHopsSummary(3, ["Copilot", "Copilot"], tx, join)).toBe(
      "Usage limits · 3 stops on Copilot",
    );
    expect(limitHopsSummary(2, [], tx, join)).toBe("Usage limits · 2 stops");
    expect(limitHopsSummary(4, ["Copilot", "Cursor", "Copilot"], tx, join)).toBe(
      "Usage limits · switched 4 times between Copilot and Cursor",
    );
  });
});
