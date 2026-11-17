import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2HistoricalMessage,
} from "@specweave-studio/contracts";
import { historyCost, selectHistory } from "./ContextHandoffBudget.ts";

const message = (id: string, kind: string, text: string): OrchestrationV2HistoricalMessage => ({
  itemId: TurnItemId.make(id),
  threadId: ThreadId.make("coordinator"),
  runId: null,
  providerThreadId: null,
  status: "completed",
  kind,
  role: kind === "user_message" ? "user" : "assistant",
  text,
});
const anchors = [
  message("original", "user_message", "Preserve the original constraint."),
  message("request", "user_message", "Continue the migration."),
  message(
    "answer",
    "assistant_message",
    "Plan: preserve the current partial answer. " + "x".repeat(400),
  ),
];
const worker = (i: number, kind = "subagent", origin = "app_owned", status = "running") => ({
  ...message(
    `${kind}:${i}`,
    kind,
    `Historical worker ${i}. Read its current state before continuing.`,
  ),
  worker: { key: `child:${i}`, origin, status },
});

it.each([4096, 16000])(
  "preserves conversational anchors among 50 worker records at %i bytes",
  (budget) => {
    const records = Array.from({ length: 50 }, (_, i) => worker(i));
    const selected = selectHistory({
      messages: [...anchors, ...records],
      coverage: "History",
      budget,
    });
    for (const anchor of anchors)
      assert.include(
        selected.messages.map((m) => m.itemId),
        anchor.itemId,
      );
    assert.isAtMost(selected.messages.filter((m) => m.worker).length, 8);
    assert.equal(selected.omittedItems, 53 - selected.messages.length);
    assert.isAtMost(historyCost(selected.messages, selected.context), budget);
  },
);
it("preserves the actual answer when later tools and questions are attributed to the assistant", () => {
  const tools = Array.from({ length: 10 }, (_, i) =>
    message(`tool:${i}`, "dynamic_tool", "Read receipt. ".repeat(30)),
  );
  const question = message("question", "user_input_request", "Which target?");
  const selected = selectHistory({
    messages: [...anchors, ...tools, question],
    coverage: "History",
    budget: 4096,
  });
  for (const anchor of anchors)
    assert.include(
      selected.messages.map((m) => m.itemId),
      anchor.itemId,
    );
  assert.isAtMost(historyCost(selected.messages, selected.context), 4096);
});
it("collapses launch plus child records and favors active app-owned work", () => {
  const candidates = [
    worker(1, "thread_created"),
    worker(1),
    ...Array.from({ length: 20 }, (_, i) =>
      worker(i + 2, "subagent", "provider_native", "completed"),
    ),
    worker(50, "subagent", "app_owned", "completed"),
    worker(51),
  ];
  const selected = selectHistory({
    messages: [...anchors, ...candidates],
    coverage: "History",
    budget: 4096,
  });
  const refs = selected.messages.filter((m) => m.worker);
  assert.equal(refs.filter((m) => m.worker?.key === "child:1").length, 1);
  assert.include(
    refs.map((m) => m.itemId),
    "subagent:1",
  );
  assert.include(
    refs.map((m) => m.itemId),
    "subagent:51",
  );
  assert.isAtMost(refs.length, 8);
});
it("keeps the latest answer at a tight budget even when a worker reference cannot fit", () => {
  const selected = selectHistory({
    messages: [...anchors, worker(1)],
    coverage: "History",
    budget: 1700,
  });
  assert.include(
    selected.messages.map((m) => m.itemId),
    "answer",
  );
  assert.isAtMost(historyCost(selected.messages, selected.context), 1700);
});
