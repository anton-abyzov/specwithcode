import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  isOutageProgress,
  lostWorkNoteEvents,
  openNativeSubagentWork,
  outageProgress,
  PERSON_STOP_PROGRESS,
  settleNativeSubagents,
  stopIntent,
  stopSettlement,
  type SubagentSettlementProjection,
} from "./SubagentSettlement.ts";
import {
  LIVE_SILENT_RUN_REASON,
  PROVIDER_TURN_START_TIMEOUT_MESSAGE,
  STALE_FINISHED_RUN_REASON,
} from "./systemInterruptReasons.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instance = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread_settlement");
const providerA = ProviderThreadId.make("provider_a");
const providerB = ProviderThreadId.make("provider_b");
const now = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");

let nextId = 0;
const allocateEventId = () => Effect.sync(() => EventId.make(`event_${(nextId += 1)}`));

function subagent(
  id: string,
  runId: string,
  providerThreadId: ProviderThreadId,
  origin = "provider_native",
) {
  const nodeId = NodeId.make(id);
  const childThreadId =
    origin === "app_owned" ? ThreadId.make(`thread:delegated-task:${id}`) : null;
  return {
    row: {
      id: nodeId,
      runId: RunId.make(runId),
      origin,
      childThreadId,
      providerThreadId,
      driver,
      providerInstanceId: instance,
      title: `Task ${id}`,
      prompt: `Do ${id}`,
      status: "running",
    },
    node: { id: nodeId, runId: RunId.make(runId), kind: "subagent", status: "running" },
    item: {
      id: TurnItemId.make(`item:${id}`),
      runId: RunId.make(runId),
      nodeId,
      providerThreadId,
      type: "subagent",
      status: "running",
      subagentId: nodeId,
      origin,
      childThreadId,
      providerInstanceId: instance,
      title: `Task ${id}`,
      prompt: `Do ${id}`,
    },
  };
}

function projection(
  entries: ReadonlyArray<ReturnType<typeof subagent>>,
  extra: { rowsOnly?: string[] } = {},
) {
  const rowsOnly = new Set(extra.rowsOnly ?? []);
  return {
    thread: { id: threadId, providerInstanceId: instance },
    runs: [
      {
        id: RunId.make("run_1"),
        ordinal: 1,
        status: "completed",
        providerThreadId: providerA,
        providerInstanceId: instance,
        completedAt: now,
      },
      {
        id: RunId.make("run_2"),
        ordinal: 2,
        status: "failed",
        providerThreadId: providerA,
        providerInstanceId: instance,
        completedAt: DateTime.add(now, { minutes: 1 }),
      },
      {
        id: RunId.make("run_b"),
        ordinal: 3,
        status: "completed",
        providerThreadId: providerB,
        providerInstanceId: instance,
        completedAt: DateTime.add(now, { minutes: 2 }),
      },
    ],
    nodes: entries.map((entry) => entry.node),
    subagents: entries.map((entry) => entry.row),
    turnItems: entries.filter((entry) => !rowsOnly.has(entry.row.id)).map((entry) => entry.item),
    providerThreads: [],
  } as unknown as SubagentSettlementProjection;
}

// 1048 review F-01: the watchdog's and start timeout's interrupts carry no
// cause, like a person's Stop. Their subagents are an outage, never "Stopped by you".
it.each([STALE_FINISHED_RUN_REASON, LIVE_SILENT_RUN_REASON, PROVIDER_TURN_START_TIMEOUT_MESSAGE])(
  "settles subagents a server interrupt ended as an outage (%s)",
  (message) => {
    assert.equal(stopIntent({ message }), "system");
    assert.deepEqual(stopSettlement("system", "claudeAgent"), {
      status: "interrupted",
      progress: "Stopped when the provider session ended",
      outage: true,
    });
  },
);

it("keeps who stopped a run for the subagents it ends", () => {
  assert.isNull(stopIntent(null));
  assert.equal(stopIntent({ message: "Interrupt requested" }), "person");
  assert.equal(stopIntent({}), "person");
  assert.equal(stopIntent({ cause: "user", message: LIVE_SILENT_RUN_REASON }), "person");
  assert.equal(stopIntent({ cause: "agent", message: "Interrupt requested" }), "agent");
  assert.equal(stopIntent({ cause: "delegated_cancel", message: "x" }), "agent");
  assert.equal(stopIntent({ cause: "service_update", message: "x" }), "service_update");
  assert.deepEqual(stopSettlement("person", null), {
    status: "cancelled",
    progress: PERSON_STOP_PROGRESS,
    outage: false,
  });
  assert.deepEqual(stopSettlement("agent", null), {
    status: "cancelled",
    progress: "Stopped by an agent",
    outage: false,
  });
  assert.deepEqual(stopSettlement("service_update", null), {
    status: "interrupted",
    progress: "Stopped when SpecWithCode restarted for an update",
    outage: true,
  });
});

it("names the outage that ended a subagent", () => {
  assert.equal(
    outageProgress({ driver: "claudeAgent", failureClass: "usage_limit" }),
    "Stopped when Claude's usage limit ended the parent's session",
  );
  assert.equal(
    outageProgress({ driver: "codex", failureClass: "transport_error" }),
    "Stopped when Codex failed and ended the parent's session",
  );
  assert.equal(
    outageProgress({ driver: null, failureClass: "service_update" }),
    "Stopped when SpecWithCode restarted for an update",
  );
  assert.equal(
    outageProgress({ driver: null, failureClass: null }),
    "Stopped when the provider session ended",
  );
  assert.isTrue(isOutageProgress(outageProgress({ driver: null, failureClass: null })));
  assert.isFalse(isOutageProgress(PERSON_STOP_PROGRESS));
});

it("selects open native work only, within the run and provider thread scope", () => {
  const work = projection(
    [
      subagent("native_1", "run_1", providerA),
      subagent("native_2", "run_2", providerA),
      subagent("row_only", "run_1", providerA),
      subagent("native_b", "run_b", providerB),
      subagent("delegated", "run_1", providerA, "app_owned"),
    ],
    { rowsOnly: ["row_only"] },
  );
  const all = openNativeSubagentWork(work);
  assert.deepEqual(
    all.items.map((item) => item.subagentId),
    ["native_1", "native_2", "native_b"],
  );
  assert.deepEqual(
    all.rows.map((row) => row.id),
    ["row_only"],
  );
  const scoped = openNativeSubagentWork(work, {
    throughRunOrdinal: 1,
    providerThreadIds: new Set([providerA]),
  });
  assert.deepEqual(
    scoped.items.map((item) => item.subagentId),
    ["native_1"],
  );
});

it.effect("reports outage-settled work as lost and a Stop as final", () =>
  Effect.gen(function* () {
    const work = projection([
      subagent("native_1", "run_1", providerA),
      subagent("native_b", "run_b", providerB),
    ]);
    const outage = yield* settleNativeSubagents({
      projection: work,
      status: "interrupted",
      progress: "Stopped when the provider session ended",
      now,
      allocateEventId,
    });
    assert.deepEqual(
      [...outage.lostWork].map(([providerThreadId, lost]) => [
        providerThreadId,
        lost.map((entry) => entry.id),
      ]),
      [
        [providerA, ["native_1"]],
        [providerB, ["native_b"]],
      ],
    );
    const updates = outage.events.filter((event) => event.type === "subagent.updated");
    assert.deepEqual(
      updates.map(
        (event) =>
          event.type === "subagent.updated" && [
            event.payload.id,
            event.payload.status,
            event.payload.progress,
          ],
      ),
      [
        ["native_1", "interrupted", "Stopped when the provider session ended"],
        ["native_b", "interrupted", "Stopped when the provider session ended"],
      ],
    );
    const stop = yield* settleNativeSubagents({
      projection: work,
      status: "cancelled",
      progress: PERSON_STOP_PROGRESS,
      now,
      allocateEventId,
    });
    assert.equal(stop.lostWork.size, 0);
    assert.isTrue(
      stop.events.every(
        (event) =>
          event.type !== "subagent.updated" || event.payload.progress === PERSON_STOP_PROGRESS,
      ),
    );
  }),
);

it.effect("notes lost work once, on the provider thread's latest started run", () =>
  Effect.gen(function* () {
    const work = projection([subagent("native_1", "run_1", providerA)]);
    const { lostWork } = yield* settleNativeSubagents({
      projection: work,
      status: "interrupted",
      progress: "Stopped when the provider session ended",
      now,
      allocateEventId,
    });
    const first = yield* lostWorkNoteEvents({ projection: work, lostWork, now, allocateEventId });
    assert.equal(first.length, 1);
    const note = first[0]!;
    assert.equal(
      note.type === "run.background-work-cancelled" && note.payload.runId,
      RunId.make("run_2"),
    );
    // Once a run records it, settling the same subagent again tells nobody.
    const recorded = {
      ...work,
      runs: work.runs.map((run) =>
        run.id === "run_1" && note.type === "run.background-work-cancelled"
          ? { ...run, restartCancelledBackgroundWork: note.payload.restartCancelledBackgroundWork }
          : run,
      ),
    };
    const again = yield* lostWorkNoteEvents({
      projection: recorded,
      lostWork,
      now,
      allocateEventId,
    });
    assert.equal(again.length, 0);
  }),
);
