// 1465 AC-07: the chaos checker on synthetic projections, one good and one bad case per rule.
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { check, LIMIT_FALLBACK_PREFIX } from "./check.mjs";

const T = "chaos-thread";
const at = (seconds) => new Date(Date.UTC(2026, 10, 24, 12, 0, seconds)).toISOString();
const runId = (ordinal) => `run:thread:${T}:ordinal:${ordinal}`;
const fallbackOf = (ordinal) => `${LIMIT_FALLBACK_PREFIX}${T}:${runId(ordinal)}`;

function run(ordinal, instanceId, status, userMessageId, seconds = ordinal * 5) {
  return {
    id: runId(ordinal),
    threadId: T,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "chaos" },
    userMessageId,
    status,
    requestedAt: at(seconds),
    completedAt: status === "running" ? null : at(seconds + 1),
  };
}
const limitItem = (ordinal, resetAt = null) => ({
  runId: runId(ordinal),
  type: "error",
  failure: { class: "usage_limit", message: "Usage limit reached on this provider.", resetAt },
});
const session = (instanceId, ordinal) => `chaos-${instanceId}-${ordinal}`;
function view({ runs, turnItems = [], subagents = [] }) {
  return {
    thread: { id: T },
    runs,
    turnItems,
    subagents,
    messages: [],
    providerThreads: runs.map((r) => ({
      nativeThreadRef: { nativeId: session(r.providerInstanceId, r.ordinal) },
    })),
  };
}
const answered = (runs) =>
  runs
    .filter((r) => r.status === "completed")
    .map((r) => ({
      sessionId: session(r.providerInstanceId, r.ordinal),
      outcome: "answered",
      text: "",
    }));
const collect = (views, { turns, dispatched = [] } = {}) => ({
  threads: views,
  turns: turns ?? views.flatMap((v) => answered(v.runs)),
  dispatched,
});
const rules = (result) => result.violations.map((v) => v.rule);

NodeTest.test("a fallback that skips held sources passes", () => {
  const runs = [
    run(1, "a", "failed", "m1"),
    run(2, "b", "failed", fallbackOf(1)),
    run(3, "c", "completed", fallbackOf(2)),
  ];
  const result = check(
    collect([view({ runs, turnItems: [limitItem(1), limitItem(2)] })], {
      dispatched: [{ threadId: T, messageId: "m1" }],
    }),
  );
  NodeAssert.deepEqual(result.violations, []);
  NodeAssert.equal(result.summary.limitStops, 2);
  NodeAssert.equal(result.summary.switches, 2);
});

NodeTest.test("the m4 ping-pong (a, b, a) violates no-return-before-reset", () => {
  const runs = [
    run(1, "a", "failed", "m1"),
    run(2, "b", "failed", fallbackOf(1)),
    run(3, "a", "failed", fallbackOf(2)),
  ];
  const result = check(
    collect([view({ runs, turnItems: [limitItem(1), limitItem(2), limitItem(3)] })]),
  );
  NodeAssert.deepEqual(rules(result), ["no-return-before-reset"]);
  NodeAssert.match(result.violations[0].detail, /fallback run 3 went back to a\/chaos/);
});

NodeTest.test("a return after the named reset is allowed", () => {
  const runs = [
    run(1, "a", "failed", "m1", 0),
    run(2, "b", "failed", fallbackOf(1), 5),
    run(3, "a", "completed", fallbackOf(2), 20),
  ];
  const result = check(collect([view({ runs, turnItems: [limitItem(1, at(10)), limitItem(2)] })]));
  NodeAssert.deepEqual(result.violations, []);
});

NodeTest.test("the hold without a named reset follows holdMs", () => {
  const runs = [
    run(1, "a", "failed", "m1", 0),
    run(2, "b", "failed", fallbackOf(1), 5),
    run(3, "a", "completed", fallbackOf(2), 20),
  ];
  const items = [limitItem(1), limitItem(2)];
  NodeAssert.deepEqual(rules(check(collect([view({ runs, turnItems: items })]))), [
    "no-return-before-reset",
  ]);
  NodeAssert.deepEqual(
    check(collect([view({ runs, turnItems: items })]), { holdMs: 10_000 }).violations,
    [],
  );
});

NodeTest.test("a person's own message on the held source is no switch", () => {
  const runs = [
    run(1, "a", "failed", "m1"),
    run(2, "b", "failed", fallbackOf(1)),
    run(3, "b", "failed", "m2"),
  ];
  const result = check(
    collect([view({ runs, turnItems: [limitItem(1), limitItem(2), limitItem(3)] })]),
  );
  NodeAssert.deepEqual(rules(result), []);
  NodeAssert.equal(result.notes.length, 1, "m1 was overtaken by m2 after a visible stop");
});

NodeTest.test("one limit stop starting two fallbacks is a double switch", () => {
  const runs = [
    run(1, "a", "failed", "m1"),
    run(2, "b", "completed", fallbackOf(1)),
    run(3, "c", "completed", fallbackOf(1)),
  ];
  const result = check(collect([view({ runs, turnItems: [limitItem(1)] })]));
  NodeAssert.ok(rules(result).includes("no-return-before-reset"));
  NodeAssert.ok(result.violations.some((v) => /started 2 fallbacks/.test(v.detail)));
  NodeAssert.ok(rules(result).includes("runs-once"), "m1 completed twice");
});

NodeTest.test("a message that ends with no answer and no reason is silent loss", () => {
  const runs = [run(1, "a", "failed", "m1"), run(2, "a", "completed", "m2")];
  const result = check(collect([view({ runs })]));
  NodeAssert.deepEqual(rules(result), ["runs-once"]);
  NodeAssert.match(result.violations[0].detail, /nothing in the timeline says why/);
});

NodeTest.test("messages must run in the order they were sent", () => {
  const runs = [run(1, "a", "completed", "m2"), run(2, "a", "completed", "m1")];
  const dispatched = [
    { threadId: T, messageId: "m1" },
    { threadId: T, messageId: "m2" },
  ];
  const result = check(collect([view({ runs })], { dispatched }));
  NodeAssert.deepEqual(rules(result), ["runs-once"]);
  NodeAssert.match(result.violations[0].detail, /ran as m2, m1/);
});

NodeTest.test("the agents' answered turns must match the server's completed runs", () => {
  const runs = [run(1, "a", "completed", "m1")];
  const extra = [...answered(runs), { sessionId: session("a", 1), outcome: "answered", text: "" }];
  const result = check(collect([view({ runs })], { turns: extra }));
  NodeAssert.deepEqual(rules(result), ["runs-once"]);
  NodeAssert.match(result.violations[0].detail, /answered 2 turns but the server completed 1/);
});

const worker = (overrides = {}) => ({
  id: "node:delegated-task:w1",
  childThreadId: "thread:delegated-task:w1",
  origin: "app_owned",
  status: "completed",
  prompt: "CHAOS-RESULT worker-1\n\nfooter",
  result: "Chaos agent w answered.\n\nResult worker-1 from w.",
  completionDelivery: { state: "delivered", observedByRunId: null },
  ...overrides,
});
const wake = (runs) => [
  ...answered(runs),
  {
    sessionId: session("a", 1),
    outcome: "answered",
    text: "Delegated tasks node:delegated-task:w1 reached terminal states. Use task_status.",
  },
];

NodeTest.test("a delivered worker the launcher was told about passes", () => {
  const runs = [run(1, "a", "completed", "m1"), run(2, "a", "completed", "wake")];
  const turns = wake(runs).filter((_, index) => index !== 1);
  const result = check(collect([view({ runs, subagents: [worker()] })], { turns }));
  NodeAssert.deepEqual(result.violations, []);
});

NodeTest.test("a single worker's wake says 'reached a terminal state'", () => {
  const runs = [run(1, "a", "completed", "m1"), run(2, "a", "completed", "wake")];
  const turns = [
    ...answered(runs).filter((_, index) => index === 0),
    {
      sessionId: session("a", 2),
      outcome: "answered",
      text: "Delegated task node:delegated-task:w1 reached a terminal state.",
    },
  ];
  NodeAssert.deepEqual(
    check(collect([view({ runs, subagents: [worker()] })], { turns })).violations,
    [],
  );
});

NodeTest.test("a worker stuck pending, or never announced, violates result-delivered", () => {
  const runs = [run(1, "a", "completed", "m1")];
  const pending = check(
    collect([view({ runs, subagents: [worker({ completionDelivery: { state: "pending" } })] })]),
  );
  NodeAssert.deepEqual(rules(pending), ["result-delivered"]);
  NodeAssert.match(pending.violations[0].detail, /delivery is pending/);
  const silent = check(collect([view({ runs, subagents: [worker()] })]));
  NodeAssert.deepEqual(rules(silent), ["result-delivered"]);
  NodeAssert.match(silent.violations[0].detail, /no prompt to the launcher's agent named task/);
});

NodeTest.test("a worker whose result lost its agent's answer violates result-delivered", () => {
  const runs = [run(1, "a", "completed", "m1"), run(2, "a", "completed", "wake")];
  const turns = wake(runs).filter((_, index) => index !== 1);
  const result = check(collect([view({ runs, subagents: [worker({ result: "" })] })], { turns }));
  NodeAssert.deepEqual(rules(result), ["result-delivered"]);
});

NodeTest.test("a still-running worker is not judged yet", () => {
  const runs = [run(1, "a", "completed", "m1")];
  const result = check(
    collect([
      view({
        runs,
        subagents: [worker({ status: "running", completionDelivery: { state: "pending" } })],
      }),
    ]),
  );
  NodeAssert.deepEqual(result.violations, []);
});
