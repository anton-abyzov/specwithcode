import {
  USAGE_DELIVERED_OTHER_THREADS_NAMED,
  USAGE_DELIVERED_THREADS_PER_INCREMENT,
  UsageDeliveredReport,
  type UsageDeliveredCost,
  type UsageDeliveredGroup,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  attributeThread,
  buildDeliveredReport,
  deliveredDaySpan,
  incrementKey,
  makeRangeTest,
  mergedPullRequest,
  readLedgerMerges,
  type DeliveredBindingCandidate,
  type DeliveredCostRow,
  type DeliveredIncrementFacts,
  type DeliveredInput,
  type DeliveredThreadFacts,
} from "./usageDeliveredCore.ts";

const P = "project-1";

function row(threadId: string | null, costUsd: number, extra: Partial<DeliveredCostRow> = {}) {
  return {
    threadId,
    sessionKey: threadId ?? "native-1",
    driver: "claudeAgent",
    provider: "claude",
    model: "claude-opus-5-5",
    costUsd,
    tokens: 1000,
    records: 2,
    unpricedRecords: 0,
    ...extra,
  } satisfies DeliveredCostRow;
}

function thread(extra: Partial<DeliveredThreadFacts> = {}): DeliveredThreadFacts {
  return {
    title: null,
    projectId: P,
    parentThreadId: null,
    isCoordinator: false,
    pullRequests: [],
    ...extra,
  };
}

function bind(
  incrementId: string,
  binding: DeliveredBindingCandidate["binding"] = "claim",
): DeliveredBindingCandidate {
  return { projectId: P, incrementId, binding };
}

function facts(incrementId: string, extra: Partial<DeliveredIncrementFacts> = {}) {
  return {
    projectId: P,
    incrementId,
    title: `Increment ${incrementId}`,
    status: "active",
    createdAt: "2026-11-10T10:00:00.000Z",
    closedAt: null,
    merges: [],
    pullRequests: [],
    tasks: [],
    ...extra,
  } satisfies DeliveredIncrementFacts;
}

function input(extra: Partial<DeliveredInput>): DeliveredInput {
  return {
    timeZone: "UTC",
    sinceDay: "2026-11-01",
    untilDay: "2026-11-30",
    rows: [],
    threads: new Map(),
    bindings: new Map(),
    increments: new Map(),
    ...extra,
  };
}

function sum(parts: readonly UsageDeliveredCost[]): UsageDeliveredCost {
  return parts.reduce(
    (total, part) => ({
      costUsd: total.costUsd + part.costUsd,
      tokens: total.tokens + part.tokens,
      records: total.records + part.records,
      unpricedRecords: total.unpricedRecords + part.unpricedRecords,
    }),
    { costUsd: 0, tokens: 0, records: 0, unpricedRecords: 0 },
  );
}

function expectReconciled(body: ReturnType<typeof buildDeliveredReport>) {
  const total = sum([
    ...body.increments.map((increment) => increment.cost),
    body.coordinators.cost,
    body.otherThreads.cost,
    body.outsideApp.cost,
  ]);
  expect(total.costUsd).toBeCloseTo(body.measured.costUsd, 5);
  expect(total.tokens).toBe(body.measured.tokens);
  expect(total.records).toBe(body.measured.records);
  expect(total.unpricedRecords).toBe(body.measured.unpricedRecords);
}

function groupThreads(group: UsageDeliveredGroup) {
  return group.threads.map((entry) => entry.threadId);
}

describe("deliveredDaySpan and makeRangeTest", () => {
  it("counts days inclusively and rejects non-dates", () => {
    expect(deliveredDaySpan("2026-11-01", "2026-11-01")).toBe(1);
    expect(deliveredDaySpan("2026-11-01", "2026-11-30")).toBe(30);
    expect(deliveredDaySpan("2026-11-02", "2026-11-01")).toBe(0);
    expect(deliveredDaySpan("nope", "2026-11-01")).toBeNull();
  });

  it("buckets times by the report's time zone", () => {
    const test = makeRangeTest("America/Los_Angeles", "2026-11-10", "2026-11-12");
    // 2026-11-13T05:00Z is still November 12 in Los Angeles.
    expect(test("2026-11-13T05:00:00.000Z")).toBe(true);
    expect(test("2026-11-13T09:00:00.000Z")).toBe(false);
    expect(test("2026-11-10T07:59:00.000Z")).toBe(false);
    expect(test(null)).toBe(false);
    expect(test("garbage")).toBe(false);
  });
});

describe("mergedPullRequest", () => {
  it("finds the pull request a merge note names", () => {
    expect(mergedPullRequest("Merged anton-abyzov/specwithcode#823 as 2c6a3d06")).toBe(823);
    expect(mergedPullRequest("PR #814 merged as e0b8e31b9; green")).toBe(814);
    expect(mergedPullRequest("Reviewed, merged as #609, released")).toBe(609);
    expect(mergedPullRequest("27/27 PR #802 checks green; squash-merged as 8d61cba3f")).toBe(802);
    expect(mergedPullRequest("PR 667 merged, released in v1.0.382")).toBe(667);
    expect(
      mergedPullRequest("merged https://github.com/anton-abyzov/specwithcode/pull/850 today"),
    ).toBe(850);
  });

  it("ignores negations and merges with no pull request", () => {
    expect(mergedPullRequest("PR #12 is not merged yet")).toBeUndefined();
    expect(mergedPullRequest("PR #12 unmerged")).toBeUndefined();
    expect(mergedPullRequest("Merged main into the branch")).toBeUndefined();
    expect(mergedPullRequest("opened PR #44")).toBeUndefined();
  });
});

describe("readLedgerMerges", () => {
  it("reads merges with their times and pull requests newest first", () => {
    const ledger = [
      JSON.stringify({ t: "T-01", e: "done", at: "2026-11-03T10:00:00Z", line: "opened PR #40" }),
      JSON.stringify({
        t: "T-02",
        e: "done",
        at: "2026-11-04T10:00:00Z",
        evidence: "tests pass",
        link: "https://github.com/a/b/pull/41",
      }),
      "{torn",
      JSON.stringify({ t: "*", e: "note", at: "2026-11-05T10:00:00Z", note: "Merged a/b#41" }),
    ].join("\n");
    const read = readLedgerMerges(ledger);
    expect(read.merges).toEqual([{ at: "2026-11-05T10:00:00.000Z", pullRequest: 41 }]);
    expect(read.pullRequests).toEqual([41]);
  });
});

describe("attributeThread", () => {
  it("takes the strongest binding: manual > claim > branch > checkpoint > name", () => {
    const threads = new Map([["t", thread()]]);
    const bindings = new Map([
      ["t", [bind("0003", "name"), bind("0002", "branch"), bind("0001", "claim")]],
    ]);
    expect(attributeThread("t", threads, bindings)).toEqual({
      kind: "increment",
      key: incrementKey(P, "0001"),
      binding: "claim",
    });
    bindings.set("t", [bind("0003", "checkpoint"), bind("0004", "manual")]);
    expect(attributeThread("t", threads, bindings).key).toBe(incrementKey(P, "0004"));
  });

  it("falls back to the nearest ancestor's increment as parent", () => {
    const threads = new Map([
      ["root", thread()],
      ["mid", thread({ parentThreadId: "root" })],
      ["leaf", thread({ parentThreadId: "mid" })],
    ]);
    const bindings = new Map([["root", [bind("0007", "branch")]]]);
    expect(attributeThread("leaf", threads, bindings)).toEqual({
      kind: "increment",
      key: incrementKey(P, "0007"),
      binding: "parent",
    });
  });

  it("stops at five ancestors and at a lineage loop", () => {
    const threads = new Map<string, DeliveredThreadFacts>();
    threads.set("a0", thread());
    for (let index = 1; index <= 6; index += 1) {
      threads.set(`a${index}`, thread({ parentThreadId: `a${index - 1}` }));
    }
    const bindings = new Map([["a0", [bind("0001")]]]);
    expect(attributeThread("a5", threads, bindings).kind).toBe("increment");
    expect(attributeThread("a6", threads, bindings).kind).toBe("other");
    const loop = new Map([
      ["x", thread({ parentThreadId: "y" })],
      ["y", thread({ parentThreadId: "x" })],
    ]);
    expect(attributeThread("x", loop, new Map()).kind).toBe("other");
  });

  it("never assigns a coordinator, and workers do not inherit through one", () => {
    const threads = new Map([
      ["coord", thread({ isCoordinator: true })],
      ["worker", thread({ parentThreadId: "coord" })],
    ]);
    const bindings = new Map([["coord", [bind("0001", "manual")]]]);
    expect(attributeThread("coord", threads, bindings)).toEqual({ kind: "coordinator" });
    expect(attributeThread("worker", threads, bindings)).toEqual({ kind: "other" });
  });
});

describe("buildDeliveredReport", () => {
  it("puts every row in one part, so the parts add up to measured", () => {
    const threads = new Map<string, DeliveredThreadFacts>([
      ["coord", thread({ isCoordinator: true, title: "Coordinator" })],
      ["coord-sub", thread({ isCoordinator: true, parentThreadId: "coord" })],
      ["worker", thread({ title: "Worker", pullRequests: [77] })],
      ["sub", thread({ parentThreadId: "worker" })],
      ["chat", thread({ title: "Chat" })],
    ]);
    const body = buildDeliveredReport(
      input({
        rows: [
          row("coord", 1.25),
          row("coord-sub", 0.5),
          row("worker", 2.5, { model: "claude-sonnet-5" }),
          row("worker", 0, { unpricedRecords: 1, records: 1, costUsd: 0 }),
          row("sub", 0.75, { driver: "codex", provider: "codex", model: "gpt-6.2" }),
          row("chat", 0.333333),
          row("missing-thread-row", 0.2),
          row(null, 3, { sessionKey: "native-a" }),
          row(null, 1, { sessionKey: "native-b" }),
          row(null, 1, { sessionKey: "native-a" }),
          row("copilot-thread", 0, {
            driver: "copilot",
            provider: null,
            model: "gpt-5",
            unpricedRecords: 1,
            records: 1,
          }),
        ],
        threads,
        bindings: new Map([["worker", [bind("0010", "claim")]]]),
        increments: new Map([[incrementKey(P, "0010"), facts("0010")]]),
      }),
    );
    expectReconciled(body);
    expect(body.measured.records).toBe(20);
    expect(body.increments).toHaveLength(1);
    const increment = body.increments[0]!;
    expect(increment.cost.costUsd).toBeCloseTo(3.25, 6);
    expect(increment.threadCount).toBe(2);
    expect(increment.threads.map((entry) => [entry.threadId, entry.binding])).toEqual([
      ["worker", "claim"],
      ["sub", "parent"],
    ]);
    expect(increment.byModel.map((model) => model.model)).toEqual([
      "claude-sonnet-5",
      "gpt-6.2",
      "claude-opus-5-5",
    ]);
    expect(increment.pullRequests).toEqual([77]);
    expect(groupThreads(body.coordinators)).toEqual(["coord", "coord-sub"]);
    expect(body.otherThreads.threadCount).toBe(3);
    expect(groupThreads(body.otherThreads)).toEqual([
      "chat",
      "missing-thread-row",
      "copilot-thread",
    ]);
    expect(body.outsideApp.threadCount).toBe(2);
    expect(body.outsideApp.cost.costUsd).toBe(5);
    expect(body.outsideApp.threads).toEqual([]);
  });

  it("caps the listed threads but sums all of them", () => {
    const rows: DeliveredCostRow[] = [];
    const bindings = new Map<string, DeliveredBindingCandidate[]>();
    for (let index = 0; index < USAGE_DELIVERED_THREADS_PER_INCREMENT + 3; index += 1) {
      rows.push(row(`inc-${index}`, 1 + index / 100));
      bindings.set(`inc-${index}`, [bind("0001")]);
    }
    for (let index = 0; index < USAGE_DELIVERED_OTHER_THREADS_NAMED + 5; index += 1) {
      rows.push(row(`other-${index}`, 0.01 * (index + 1)));
    }
    const body = buildDeliveredReport(input({ rows, bindings }));
    expectReconciled(body);
    const increment = body.increments[0]!;
    expect(increment.threads).toHaveLength(USAGE_DELIVERED_THREADS_PER_INCREMENT);
    expect(increment.threadCount).toBe(USAGE_DELIVERED_THREADS_PER_INCREMENT + 3);
    expect(increment.threads[0]!.threadId).toBe(`inc-${USAGE_DELIVERED_THREADS_PER_INCREMENT + 2}`);
    expect(body.otherThreads.threads).toHaveLength(USAGE_DELIVERED_OTHER_THREADS_NAMED);
    expect(body.otherThreads.threadCount).toBe(USAGE_DELIVERED_OTHER_THREADS_NAMED + 5);
    // An increment the facts do not describe still lists, as unknown.
    expect(increment.status).toBe("unknown");
    expect(increment.state).toBe("in_progress");
  });

  it("lists increments delivered in the range without spend, and their states", () => {
    const increments = new Map<string, DeliveredIncrementFacts>([
      [
        incrementKey(P, "0001"),
        facts("0001", {
          status: "completed",
          closedAt: "2026-11-20T10:00:00.000Z",
          merges: [{ at: "2026-11-19T10:00:00.000Z", pullRequest: 5 }],
        }),
      ],
      [
        incrementKey(P, "0002"),
        facts("0002", {
          merges: [
            { at: "2026-10-01T10:00:00.000Z", pullRequest: 6 },
            { at: "2026-11-21T10:00:00.000Z", pullRequest: 7 },
            { at: "2026-11-22T10:00:00.000Z", pullRequest: 8 },
          ],
        }),
      ],
      [
        incrementKey(P, "0003"),
        facts("0003", {
          tasks: [
            { status: "done", doneAt: "2026-11-15T10:00:00.000Z" },
            { status: "done", doneAt: "2026-10-15T10:00:00.000Z" },
            { status: "skipped" },
            { status: "planned" },
          ],
        }),
      ],
      // Merged and closed before the range: not delivered in it.
      [
        incrementKey(P, "0004"),
        facts("0004", {
          status: "completed",
          closedAt: "2026-10-20T10:00:00.000Z",
          merges: [{ at: "2026-10-19T10:00:00.000Z", pullRequest: 9 }],
        }),
      ],
      // A merge only before the range is not "merged".
      [
        incrementKey(P, "0005"),
        facts("0005", { merges: [{ at: "2026-10-19T10:00:00.000Z", pullRequest: 10 }] }),
      ],
    ]);
    const body = buildDeliveredReport(
      input({
        rows: [row("t5", 1)],
        bindings: new Map([["t5", [bind("0005")]]]),
        increments,
      }),
    );
    const byId = new Map(body.increments.map((increment) => [increment.incrementId, increment]));
    expect([...byId.keys()].toSorted()).toEqual(["0001", "0002", "0003", "0005"]);
    expect(byId.get("0001")).toMatchObject({
      state: "closed",
      closedAt: "2026-11-20T10:00:00.000Z",
      mergedAt: "2026-11-19T10:00:00.000Z",
    });
    expect(byId.get("0002")).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-22T10:00:00.000Z",
      closedAt: null,
    });
    expect(byId.get("0003")).toMatchObject({
      state: "in_progress",
      tasks: { total: 4, done: 3, doneInRange: 1 },
    });
    expect(byId.get("0005")).toMatchObject({ state: "in_progress", mergedAt: null });
    expect(byId.get("0001")!.deliveredInRange).toBe(true);
    expect(byId.get("0002")!.deliveredInRange).toBe(true);
    expect(byId.get("0003")!.deliveredInRange).toBe(false);
    expect(body.increments[0]!.incrementId).toBe("0005");
  });

  it("does not count a closure after the range as delivered in it", () => {
    const body = buildDeliveredReport(
      input({
        rows: [row("t6", 2)],
        bindings: new Map([["t6", [bind("0006")]]]),
        increments: new Map([
          [
            incrementKey(P, "0006"),
            facts("0006", { status: "completed", closedAt: "2026-12-05T10:00:00.000Z" }),
          ],
        ]),
      }),
    );
    expect(body.increments[0]).toMatchObject({
      incrementId: "0006",
      state: "closed",
      deliveredInRange: false,
    });
  });

  it("flags an increment created before the range", () => {
    const increments = new Map([
      [incrementKey(P, "0001"), facts("0001", { createdAt: "2026-10-20T10:00:00.000Z" })],
      [incrementKey(P, "0002"), facts("0002", { createdAt: "2026-11-02T10:00:00.000Z" })],
    ]);
    const body = buildDeliveredReport(
      input({
        rows: [row("a", 1), row("b", 2)],
        bindings: new Map([
          ["a", [bind("0001")]],
          ["b", [bind("0002")]],
        ]),
        increments,
      }),
    );
    const byId = new Map(body.increments.map((increment) => [increment.incrementId, increment]));
    expect(byId.get("0001")!.createdAt).toBe("2026-10-20T10:00:00.000Z");
    expect(byId.get("0002")!.createdAt).toBeNull();
  });

  it("encodes as the contract's report", () => {
    const body = buildDeliveredReport(
      input({
        rows: [row("a", 1.5), row(null, 2), row("coord", 1)],
        threads: new Map([["coord", thread({ isCoordinator: true })]]),
        bindings: new Map([["a", [bind("0001", "name")]]]),
        increments: new Map([[incrementKey(P, "0001"), facts("0001")]]),
      }),
    );
    const report = {
      version: 1,
      readAt: "2026-11-24T10:00:00.000Z",
      timeZone: "UTC",
      sinceDay: "2026-11-01",
      untilDay: "2026-11-30",
      projects: [{ projectId: P, title: "Project", specweave: true }],
      ...body,
      sourceKeys: ["k"],
      cursorHistoryExcluded: false,
    };
    expect(() => Schema.encodeUnknownSync(UsageDeliveredReport)(report)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(UsageDeliveredReport)(report)).not.toThrow();
  });
});
