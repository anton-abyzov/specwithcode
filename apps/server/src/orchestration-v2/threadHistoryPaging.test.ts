import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildBoundedThreadProjection,
  boundedTimelineEncodedBytes,
  computeLatestLocalTurnOrdinal,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_CURSOR_MAX_LENGTH,
  THREAD_HISTORY_PAGE_POLICY,
  WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function interruptRow(
  index: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): OrchestrationV2ProjectedTurnItem {
  const item = interruptItem(
    type === "run_interrupt_request" ? "interrupt-req" : "interrupt-res",
    type,
    index + 1,
  );
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: item.id,
    item,
  };
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}

function humanTurnStart(row: OrchestrationV2ProjectedTurnItem): OrchestrationV2ProjectedTurnItem {
  return {
    ...row,
    item: {
      ...row.item,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: MessageId.make(`prompt-${row.sourceItemId}`),
      text: "Continue",
      attachments: [],
    },
  } as OrchestrationV2ProjectedTurnItem;
}

/** One human turn: its prompt, then `steps` tool rows. */
function humanTurn(steps: number, outputBytes?: number): OrchestrationV2ProjectedTurnItem[] {
  const items = Array.from({ length: steps + 1 }, (_, index) =>
    makeRow(index, outputBytes === undefined ? undefined : { outputBytes }),
  );
  items[0] = humanTurnStart(items[0]!);
  return items;
}

/** Walks every older page from `cursor` and returns rows oldest first. */
function pageBack(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  cursor: string | null,
): { readonly rows: OrchestrationV2ProjectedTurnItem[]; readonly pages: number } {
  const rows: OrchestrationV2ProjectedTurnItem[] = [];
  let pages = 0;
  while (cursor !== null) {
    expect(pages).toBeLessThan(items.length);
    const page = selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 1 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxTurnItems);
    const pageBytes = page.items.reduce((total, row) => total + projectedRowEncodedBytes(row), 0);
    expect(page.items.length === 1 || pageBytes <= THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes).toBe(
      true,
    );
    rows.unshift(...page.items);
    cursor = page.nextCursor;
    pages += 1;
  }
  return { rows, pages };
}

describe("threadHistoryPaging", () => {
  it("keeps a human turn whole up to the turn row budget and pages a longer one from inside", () => {
    const whole = selectRecentTimelineWindow({ items: humanTurn(179), snapshotSequence: 1 });
    expect(whole.items).toHaveLength(180);
    expect(whole.hasMoreHistory).toBe(false);

    const items = humanTurn(THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 99);
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });
    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    const older = pageBack(items, recent.nextCursor);
    expect([...older.rows, ...recent.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });

  it("bounds a 5,000-step human turn and pages back to its first item", () => {
    const items = humanTurn(4_999, 2_048);
    expect(items).toHaveLength(5_000);
    const fullBytes = Buffer.byteLength(JSON.stringify(makeProjection(items)), "utf8");
    expect(fullBytes).toBeGreaterThan(10 * THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);

    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(items),
      snapshotSequence: 1,
    });
    const snapshot = {
      projection: bounded.projection,
      historyCursor: bounded.historyCursor,
      hasMoreHistory: bounded.hasMoreHistory,
      windowTurnStart: bounded.windowTurnStart,
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
    );
    const window = bounded.projection.visibleTurnItems;
    expect(window.length).toBeGreaterThan(0);
    expect(window.length).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxTurnItems);
    expect(window.at(-1)?.sourceItemId).toBe("item-4999");
    expect(bounded.hasMoreHistory).toBe(true);
    // The prompt rides beside the window instead of inside it.
    expect(bounded.windowTurnStart?.sourceItemId).toBe("item-0");
    expect(bounded.windowTurnStart?.item.type).toBe("user_message");
    expect(window.some((row) => row.sourceItemId === "item-0")).toBe(false);

    const older = pageBack(items, bounded.historyCursor);
    const loaded = [...older.rows, ...window].map((row) => row.sourceItemId);
    expect(loaded[0]).toBe("item-0");
    expect(new Set(loaded).size).toBe(loaded.length);
    expect(loaded).toEqual(items.map((row) => row.sourceItemId));
  });

  it("sends no window turn start when the window holds the turn's prompt", () => {
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(humanTurn(40)),
      snapshotSequence: 1,
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(41);
    expect(bounded.windowTurnStart).toBeNull();
  });

  it("uses the store's turn start when the loaded rows hold none", () => {
    const items = humanTurn(600);
    const loaded = items.slice(-THREAD_HISTORY_PAGE_POLICY.maxItems - 2);
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(loaded),
      snapshotSequence: 1,
      latestUserTurnStart: items[0],
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(bounded.windowTurnStart?.sourceItemId).toBe("item-0");
    expect(bounded.projection.messages).toEqual([]);
  });

  it("keeps long turns whole for clients that do not bound them", () => {
    const items = humanTurn(1_000);
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(items),
      snapshotSequence: 1,
      policy: WHOLE_TURN_THREAD_HISTORY_PAGE_POLICY,
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(items.length);
    expect(bounded.windowTurnStart).toBeNull();
    expect(bounded.hasMoreHistory).toBe(false);
  });

  it("charges the prompt's bytes only when it rides beside the window", () => {
    const items = humanTurn(40, 2_000);
    items[0] = {
      ...items[0]!,
      item: { ...items[0]!.item, text: "p".repeat(300_000) },
    } as OrchestrationV2ProjectedTurnItem;
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(items),
      snapshotSequence: 1,
      latestUserTurnStart: items[0],
    });
    // The prompt counts once, inside the window, so the whole turn fits.
    expect(bounded.projection.visibleTurnItems).toHaveLength(items.length);
    expect(bounded.windowTurnStart).toBeNull();
    expect(bounded.hasMoreHistory).toBe(false);
  });

  it("reports more history when the store left older rows out", () => {
    const loaded = humanTurn(20);
    const window = selectRecentTimelineWindow({
      items: loaded,
      snapshotSequence: 1,
      olderRowsUnloaded: true,
    });
    expect(window.items).toHaveLength(loaded.length);
    expect(window.hasMoreHistory).toBe(true);
    expect(decodeThreadHistoryCursor(window.nextCursor!).si).toBe("item-0");
  });

  it("resumes below a vanished cursor row by ordinal, not position", () => {
    const items = humanTurn(1_200);
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });
    const cursor = decodeThreadHistoryCursor(recent.nextCursor!);
    expect(cursor.o).toBe(items.length - THREAD_HISTORY_PAGE_POLICY.maxItems + 1);
    expect(cursor.b).toBe(1);
    // The long run is rolled back: its rows after item-300 leave the timeline.
    const remaining = items.slice(0, 301);
    const page = selectHistoryPageFromCursor({
      items: remaining,
      cursor: recent.nextCursor!,
      snapshotSequence: 2,
    });
    expect(page.items.at(-1)?.sourceItemId).toBe("item-300");
    const older = pageBack(remaining, page.nextCursor);
    expect([...older.rows, ...page.items].map((row) => row.sourceItemId)).toEqual(
      remaining.map((row) => row.sourceItemId),
    );
  });

  it("builds a resumable bounded socket snapshot frame", () => {
    const projection = makeProjection(Array.from({ length: 90 }, (_, index) => makeRow(index)));
    const item = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 23,
      projection,
    });

    expect(item.kind).toBe("snapshot");
    expect(item.snapshotSequence).toBe(23);
    expect(item.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(item.historyCursor).not.toBeNull();
    expect(item.hasMoreHistory).toBe(true);
    expect(item.latestLocalTurnOrdinal).toBe(90);
  });

  it("keeps background turns with user turns, with main's 150-turn fan-out ceiling", () => {
    const items = Array.from({ length: 161 }, (_, turn) => {
      const row = makeRow(turn * 2);
      if (row.item.type !== "command_execution") throw new Error("Expected command fixture");
      const prompt: OrchestrationV2ProjectedTurnItem = {
        ...row,
        item: {
          ...row.item,
          type: "user_message",
          createdBy: turn === 0 ? "user" : "agent",
          creationSource: "provider",
          inputIntent: "turn_start",
          messageId: MessageId.make(`prompt-${turn}`),
          text: `Prompt ${turn}`,
          attachments: [],
        },
      };
      return [prompt, makeRow(turn * 2 + 1)];
    }).flat();
    // Generous row and byte budgets isolate the raw-turn ceiling.
    const policy = { ...THREAD_HISTORY_PAGE_POLICY, maxItems: 1_000, maxEncodedBytes: 10_000_000 };
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
    expect(first.items).toHaveLength(300);
    expect(first.items[0]?.sourceItemId).toBe("item-22");
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
      policy,
    });
    expect(older.items).toHaveLength(22);
    expect(older.hasMoreHistory).toBe(false);
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });

  it("pages agent-only child transcripts instead of dropping their earlier activity", () => {
    const commandRows = Array.from({ length: 90 }, (_, index) => makeRow(index + 1));
    const first = makeRow(0);
    const prompt = {
      ...first,
      item: {
        ...first.item,
        type: "user_message" as const,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        inputIntent: "turn_start" as const,
        messageId: MessageId.make("child-prompt"),
        text: "Inspect this project",
        attachments: [],
      },
    } as OrchestrationV2ProjectedTurnItem;
    const items = [prompt, ...commandRows];
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });

    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(recent.hasMoreHistory).toBe(true);
    const older = selectHistoryPageFromCursor({
      items,
      cursor: recent.nextCursor!,
      snapshotSequence: 1,
    });
    expect(older.items[0]?.item.type).toBe("user_message");
    expect([...older.items, ...recent.items]).toHaveLength(items.length);
  });

  it("encodes opaque cursors with stable source identity", () => {
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 9,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-3"),
      position: 3,
    });
    expect(cursor.includes("{")).toBe(false);
    expect(decodeThreadHistoryCursor(cursor)).toEqual({
      v: 1,
      seq: 9,
      st: "thread-1",
      si: "item-3",
      p: 3,
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeThreadHistoryCursor("not-valid")).toThrow(InvalidThreadHistoryCursorError);
    expect(() =>
      decodeThreadHistoryCursor(Buffer.from("{}", "utf8").toString("base64url")),
    ).toThrow(InvalidThreadHistoryCursorError);
  });

  it("rejects cursors longer than the maximum length before decoding", () => {
    const oversized = "A".repeat(THREAD_HISTORY_CURSOR_MAX_LENGTH + 1);
    expect(() => decodeThreadHistoryCursor(oversized)).toThrow(InvalidThreadHistoryCursorError);
  });

  it("selects a recent window by item count", () => {
    const items = Array.from({ length: 120 }, (_, index) => makeRow(index));
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 4,
      policy: { maxItems: 10, maxEncodedBytes: 10_000_000 },
    });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]?.sourceItemId).toBe("item-110");
    expect(page.items[9]?.sourceItemId).toBe("item-119");
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const cursor = decodeThreadHistoryCursor(page.nextCursor!);
    expect(cursor.si).toBe("item-110");
    expect(cursor.seq).toBe(4);
  });

  it("always includes at least one pathological oversized item", () => {
    const items = [makeRow(0, { outputBytes: 2_000_000 }), makeRow(1, { outputBytes: 10 })];
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceItemId).toBe("item-1");
    expect(page.hasMoreHistory).toBe(true);

    const older = selectHistoryPageFromCursor({
      items,
      cursor: page.nextCursor!,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(older.items).toHaveLength(1);
    expect(older.items[0]?.sourceItemId).toBe("item-0");
    expect(older.hasMoreHistory).toBe(false);
    expect(older.nextCursor).toBeNull();
  });

  it("recovers identity-miss cursors when position is past a shrunken timeline", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeRow(index));
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-deleted-long-ago"),
      position: 40,
    });
    const page = selectHistoryPageFromCursor({
      items,
      cursor,
      snapshotSequence: 3,
      policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
    });
    // Clamp exclusive end to items.length and page backward so the client can
    // dedupe and advance rather than permanently 400 on a dead cursor.
    expect(page.items.map((row) => row.sourceItemId)).toEqual(["item-3", "item-4"]);
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("keeps cursor resolution stable when newer items append", () => {
    const initial = Array.from({ length: 20 }, (_, index) => makeRow(index));
    const recent = selectRecentTimelineWindow({
      items: initial,
      snapshotSequence: 2,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    const cursor = recent.nextCursor!;
    const grown = [...initial, makeRow(20), makeRow(21)];
    const older = selectHistoryPageFromCursor({
      items: grown,
      cursor,
      snapshotSequence: 5,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(older.items.map((row) => row.sourceItemId)).toEqual([
      "item-10",
      "item-11",
      "item-12",
      "item-13",
      "item-14",
    ]);
    expect(older.hasMoreHistory).toBe(true);
  });

  it("builds a bounded projection that preserves non-timeline control state", () => {
    const full = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.runs).toEqual(full.runs);
    expect(bounded.projection.runtimeRequests).toEqual(full.runtimeRequests);
    expect(bounded.projection.attempts).toEqual(full.attempts);
    expect(bounded.projection.visibleTurnItems).toHaveLength(5);
    expect(bounded.projection.turnItems).toHaveLength(5);
    expect(bounded.hasMoreHistory).toBe(true);
    expect(bounded.historyCursor).not.toBeNull();
    expect(bounded.projection.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    // Watermark comes from the full projection, not the trimmed window.
    expect(bounded.latestLocalTurnOrdinal).toBe(40);
    expect(computeLatestLocalTurnOrdinal(full.turnItems)).toBe(40);
  });

  it("preserves linked control rows as one coherent graph", () => {
    const base = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const linked = {
      ...base,
      runs: [{ id: "run-linked", threadId: THREAD }],
      attempts: [{ id: "attempt-linked", runId: "run-linked" }],
      nodes: [{ id: "node-linked", runId: "run-linked", attemptId: "attempt-linked" }],
      providerThreads: [{ id: "provider-thread-linked", runId: "run-linked" }],
      providerTurns: [
        {
          id: "provider-turn-linked",
          providerThreadId: "provider-thread-linked",
          nodeId: "node-linked",
        },
      ],
      checkpointScopes: [{ id: "scope-linked", runId: "run-linked" }],
      checkpoints: [{ id: "checkpoint-linked", scopeId: "scope-linked" }],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({
      projection: linked,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.runs).toEqual(linked.runs);
    expect(bounded.projection.attempts).toEqual(linked.attempts);
    expect(bounded.projection.nodes).toEqual(linked.nodes);
    expect(bounded.projection.providerThreads).toEqual(linked.providerThreads);
    expect(bounded.projection.providerTurns).toEqual(linked.providerTurns);
    expect(bounded.projection.checkpointScopes).toEqual(linked.checkpointScopes);
    expect(bounded.projection.checkpoints).toEqual(linked.checkpoints);
  });

  it("carries a full-projection watermark when the bounded window is inherited-only", () => {
    const localOlder = makeRow(0);
    const localMid = makeRow(1);
    const inherited = {
      ...makeRow(2),
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("parent-thread"),
      item: {
        ...makeRow(2).item,
        threadId: ThreadId.make("parent-thread"),
      },
    };
    // Full projection still has local turnItems even if the recent window is
    // only the inherited row (e.g. after aggressive byte budget on a large
    // local item that is not selected into the recent page). Use a synthetic
    // projection with local turnItems and inherited-only visible window.
    const full = makeProjection([localOlder, localMid, inherited]);
    // Force an inherited-only visible window by rebuilding with only inherited
    // visible rows while retaining full local turnItems for the watermark.
    const inheritedOnly = {
      ...full,
      visibleTurnItems: [inherited],
      turnItems: [localOlder.item, localMid.item],
    };
    const bounded = buildBoundedThreadProjection({
      projection: inheritedOnly,
      snapshotSequence: 2,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      String(inherited.sourceItemId),
    ]);
    expect(bounded.latestLocalTurnOrdinal).toBe(2);
    expect(computeLatestLocalTurnOrdinal([])).toBeNull();
  });

  it("retains an out-of-window run_interrupt_request needed by a visible result", () => {
    // Older request sits outside a 1-row recent window; result is visible alone.
    const request = interruptRow(0, "run_interrupt_request");
    const filler = makeRow(1);
    const result = interruptRow(2, "run_interrupt_result");
    const full = makeProjection([request, filler, result]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 3,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "interrupt-res",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "interrupt-res",
    ]);
    expect(bounded.hasMoreHistory).toBe(true);
  });

  it("retains all run_interrupt_request items even when no result is in the initial window", () => {
    // Cold open: recent window is only filler. Request and result both live on
    // older pages, but the request must still ride in turnItems so a later
    // history page can introduce the result safely under live attempt updates.
    const request = interruptRow(0, "run_interrupt_request");
    const result = interruptRow(1, "run_interrupt_result");
    const recent = makeRow(2);
    const full = makeProjection([request, result, recent]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 4,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-2",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "item-2",
    ]);
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(
      true,
    );
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(
      false,
    );
  });

  it("charges local row.item duplication when measuring bounded timeline bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => makeRow(index, { outputBytes: 2_000 }));
    const full = makeProjection(rows);
    const maxEncodedBytes = 12_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });

    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeLessThanOrEqual(maxEncodedBytes);
    expect(bounded.projection.visibleTurnItems.length).toBeGreaterThan(0);
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(rows.length);

    // History pages only charge the projected row once (no turnItems copy).
    const historyPage = selectRecentTimelineWindow({
      items: rows,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });
    const historyBytes = historyPage.items.reduce(
      (sum, row) => sum + projectedRowEncodedBytes(row),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(maxEncodedBytes);
    expect(historyPage.items.length).toBeGreaterThan(bounded.projection.visibleTurnItems.length);

    // Dual-cost for one local row exceeds the plain row cost.
    const sample = rows[0]!;
    expect(projectedRowBoundedSnapshotEncodedBytes(sample, THREAD)).toBeGreaterThan(
      projectedRowEncodedBytes(sample),
    );
  });

  it("allows a single pathological bounded row to exceed the configured cap", () => {
    const huge = makeRow(0, { outputBytes: 50_000 });
    const full = makeProjection([huge]);
    const maxEncodedBytes = 1_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 10, maxEncodedBytes },
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(1);
    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeGreaterThan(maxEncodedBytes);
  });

  it("exposes conservative default page budgets", () => {
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeGreaterThanOrEqual(50);
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeLessThanOrEqual(100);
    expect(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes).toBe(1_048_576);
  });

  it("does not carry the full duplicated message table into a bounded snapshot", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const full = {
      ...projection,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`message-${index}`),
        threadId: THREAD,
        runId: RunId.make(`old-run-${index}`),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 9,
    });

    expect(bounded.projection.messages).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection), "utf8")).toBeLessThan(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes + 100_000,
    );
  });

  it("omits historical control details that remain available from history items", () => {
    const projection = makeProjection(Array.from({ length: 200 }, (_, index) => makeRow(index)));
    const populated = {
      ...projection,
      plans: Array.from({ length: 120 }, (_, index) => ({
        id: `plan-${index}`,
        threadId: THREAD,
        runId: null,
        nodeId: `node-${index}`,
        status: "completed",
        kind: "proposed_plan",
        markdown: "p".repeat(2_097_152),
      })),
      contextHandoffs: Array.from({ length: 120 }, (_, index) => ({
        id: `handoff-${index}`,
        threadId: THREAD,
        targetRunId: "run-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "provider-thread-1",
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "superseded",
        summaryMessageId: null,
        summaryText: "h".repeat(2_097_152),
        createdByProviderInstanceId: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: projectThreadProjectionForWire(populated),
      snapshotSequence: 9,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded.projection), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
    expect(bounded.projection.plans).toEqual([]);
    expect(bounded.projection.contextHandoffs).toEqual([]);
    expect(populated.plans).toHaveLength(120);
    expect(
      populated.plans[0]?.kind === "proposed_plan" ? populated.plans[0].markdown.length : 0,
    ).toBe(2_097_152);
  });

  it("preserves oversized actionable state past the byte budget", () => {
    const projection = makeProjection([]);
    const actionable = {
      ...projection,
      plans: [
        {
          id: "plan-actionable",
          threadId: THREAD,
          runId: null,
          nodeId: "node-actionable",
          status: "active",
          kind: "proposed_plan",
          markdown: "a".repeat(2_097_152),
        },
      ],
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: actionable, snapshotSequence: 9 });

    expect(bounded.projection.plans[0]).toEqual(actionable.plans[0]);
  });

  it("keeps paged historical plan detail in the turn item and only status in its artifact", () => {
    const detail = "Implement the historical plan exactly.\n".repeat(1_000);
    const item = {
      ...makeRow(0).item,
      type: "proposed_plan",
      planId: "plan-historical-visible",
      markdown: detail,
      streaming: false,
    } as OrchestrationV2TurnItem;
    const row = {
      ...makeRow(0),
      sourceItemId: item.id,
      item,
    } as OrchestrationV2ProjectedTurnItem;
    const base = makeProjection([row]);
    const projection = {
      ...base,
      plans: [
        {
          id: "plan-historical-visible",
          threadId: THREAD,
          runId: null,
          nodeId: "node-historical-visible",
          status: "completed",
          kind: "proposed_plan",
          markdown: detail,
        },
      ],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 9 });

    expect(bounded.projection.visibleTurnItems[0]?.item).toMatchObject({
      type: "proposed_plan",
      markdown: detail,
    });
    expect(bounded.projection.plans[0]).toMatchObject({
      status: "completed",
      markdown: "",
      detailInTurnItem: true,
    });
  });
});
