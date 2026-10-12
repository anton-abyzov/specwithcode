import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPROVAL_PLAN,
  enableApprovalPolicy,
  inspectApprovals,
  reserveApproval,
  approvalReceipt,
} from "./native-approval.mjs";
import {
  createNativeScope,
  observeProjection,
  assertNativeRpc,
  NATIVE_ORIGIN,
} from "./native-rpc.mjs";

const [metadata, ...events] = readFileSync(
  new URL("./native-wire/native-completion-cohort.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map(JSON.parse);
const coordinatorId = `project-coordinator:${metadata.projectId}`;
const fields = {
  run: "runs",
  "run-attempt": "attempts",
  node: "nodes",
  "turn-item": "turnItems",
  "runtime-request": "runtimeRequests",
  "provider-thread": "providerThreads",
  "provider-turn": "providerTurns",
  "provider-session": "providerSessions",
  subagent: "subagents",
};
function prefix(sequence) {
  const snapshots = new Map();
  for (const event of events.filter((e) => e.sequence <= sequence)) {
    const entity = event.type.split(".")[0];
    if (!snapshots.has(event.streamId))
      snapshots.set(event.streamId, Object.fromEntries(Object.values(fields).map((k) => [k, []])));
    const p = snapshots.get(event.streamId),
      value = structuredClone(event.payload);
    if (entity === "thread") p.thread = { ...p.thread, ...value };
    else {
      const rows = p[fields[entity]],
        index = rows.findIndex((row) => row.id === value.id);
      if (entity === "turn-item") delete value.threadId; // The API DTO strips this redundant field.
      if (index < 0) rows.push(value);
      else rows[index] = { ...rows[index], ...value };
    }
  }
  return snapshots;
}
function replay(approve = true) {
  const scope = createNativeScope(metadata.projectId, true);
  enableApprovalPolicy(
    scope,
    {
      schemaVersion: 2,
      authorization: "six-native-project-runs-with-exact-single-use-approvals",
      approvalPlan: structuredClone(APPROVAL_PLAN),
      maxRuns: 6,
      codex: { model: metadata.coordinatorModel },
      claude: { model: metadata.workerModel },
    },
    "offline-followup",
  );
  const snapshots = prefix(33),
    p = snapshots.get(coordinatorId),
    run = p.runs[0];
  const commandId = run.userMessageId.slice(`coordinator-send:${metadata.projectId}:`.length);
  assertNativeRpc(
    NATIVE_ORIGIN,
    "projects.coordinatorStart",
    {
      projectId: metadata.projectId,
      commandId,
      prompt: "Recorded synthetic dispatch; offline replay only.",
    },
    scope,
  );
  for (const projection of snapshots.values()) observeProjection(scope, projection);
  const binding = inspectApprovals(scope, snapshots);
  if (approve) {
    const approval = reserveApproval(scope, binding);
    assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", approval, scope); // Consumes locally; no transport.
  }
  return { scope, run: structuredClone(run), snapshots };
}
function inspect(f, sequence) {
  f.snapshots = prefix(sequence);
  for (const projection of f.snapshots.values()) observeProjection(f.scope, projection);
  return inspectApprovals(f.scope, f.snapshots);
}
test("immutable native event prefixes retain original user run across completion delivery, clearing and stop", () => {
  const f = replay();
  for (const sequence of [50, 56, 57, 62, 65, 67, 75]) {
    assert.equal(inspect(f, sequence), null, `prefix ${sequence} must not grant another response`);
    const p = f.snapshots.get(coordinatorId);
    assert.equal(p.runs.length, 1);
    assert.equal(p.runs[0].id, f.run.id);
    assert.equal(p.runs[0].userMessageId, f.run.userMessageId);
    assert.equal(p.runs[0].ordinal, 1);
    assert.equal(p.attempts.length, 1);
    assert.equal(p.attempts[0].attemptOrdinal, 1);
    assert.equal(approvalReceipt(f.scope).length, 1);
  }
  assert.equal(f.scope.runs.size, 2);
  assert.equal(f.scope.providerTurns.size, 1);
  const worker = [...f.snapshots.values()].find((p) => p.thread.id !== coordinatorId);
  assert.equal(worker.runs[0].status, "failed");
  assert.equal(worker.providerTurns.length, 0);
});
const mutations = {
  "actual wake message": (p) => {
    p.runs[0].userMessageId = p.runs[0].delegatedCompletion.delivery.messageId;
  },
  "rebound user run": (p) => {
    p.runs[0].id = "unreviewed-run";
    for (const item of p.turnItems) item.runId = "unreviewed-run";
    p.attempts[0].runId = "unreviewed-run";
  },
  "changed ordinal": (p) => {
    p.runs[0].ordinal = 2;
  },
  "duplicated source dispatch": (p) => {
    p.runs.push({ ...p.runs[0], id: "extra-run", ordinal: 2 });
  },
  "retry attempt": (p) => {
    p.attempts[0].reason = "retry";
  },
  "second attempt": (p) => {
    p.attempts[0].attemptOrdinal = 2;
  },
  "extra attempt": (p) => {
    p.attempts.push({ ...p.attempts[0], id: "retry" });
  },
  "credit intent": (p) => {
    p.runs[0].manualCodexCreditIntent = {};
  },
  "restart run": (p) => {
    p.runs[0].restartContinuationOfRunId = "prior";
  },
  "wake-shaped completion": (p) => {
    p.runs[0].delegatedCompletion = { parentRunId: p.runs[0].id, generation: 1, taskIds: [] };
  },
  "empty cohort": (p) => {
    p.runs[0].delegatedCompletion = {};
  },
  "extra cohort field": (p) => {
    p.runs[0].delegatedCompletion.parentRunId = "prior";
  },
  "bad generation": (p) => {
    p.runs[0].delegatedCompletion.nextGeneration = 999;
  },
  "generation mismatch": (p) => {
    p.runs[0].delegatedCompletion.delivery.generation = 2;
  },
  "source message reused": (p) => {
    p.runs[0].delegatedCompletion.delivery.messageId = p.runs[0].userMessageId;
  },
  "foreign task": (p) => {
    p.runs[0].delegatedCompletion.delivery.taskIds = ["foreign"];
  },
  "duplicate task": (p) => {
    p.runs[0].delegatedCompletion.delivery.taskIds.push(p.subagents[0].id);
  },
  "foreign task owner": (p) => {
    p.subagents[0].runId = "foreign";
  },
  "foreign child": (p) => {
    p.subagents[0].childThreadId = "foreign";
  },
  "provider native task": (p) => {
    p.subagents[0].origin = "provider_native";
  },
  "wrong worker model": (p) => {
    p.subagents[0].model = "other";
  },
  "not terminal task": (p) => {
    p.subagents[0].status = "running";
  },
  "delegate output rebound": (p) => {
    p.turnItems.find((i) => i.toolName === "studio-code.delegate_task").output.taskId = "foreign";
  },
  "new pending call": (p) => {
    const call = p.turnItems.find((i) => i.toolName === "studio-code.delegate_task");
    p.turnItems.push({ ...call, id: "extra-call", status: "running" });
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`original completion cohort rejects ${name}`, () => {
    const f = replay();
    inspect(f, 56);
    f.snapshots = prefix(57);
    mutate(f.snapshots.get(coordinatorId));
    assert.throws(() => inspectApprovals(f.scope, f.snapshots), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 1, "metadata never authorizes another response");
  });
test("completion metadata cannot replace the exact submitted delegation approval", () => {
  const f = replay(false);
  assert.throws(() => inspect(f, 57), /completion delegation not approved/);
  assert.equal(approvalReceipt(f.scope).length, 0);
});
test("completion metadata cannot establish the first observed run binding", () => {
  const f = replay(),
    other = createNativeScope(metadata.projectId, true);
  enableApprovalPolicy(
    other,
    {
      schemaVersion: 2,
      authorization: "six-native-project-runs-with-exact-single-use-approvals",
      approvalPlan: structuredClone(APPROVAL_PLAN),
      maxRuns: 6,
      codex: { model: metadata.coordinatorModel },
      claude: { model: metadata.workerModel },
    },
    "offline-followup",
  );
  for (const [key, value] of f.scope.dispatches) other.dispatches.set(key, value);
  const snapshots = prefix(57);
  for (const p of snapshots.values()) observeProjection(other, p);
  assert.throws(() => inspectApprovals(other, snapshots), /Native approval refused/);
  assert.equal(approvalReceipt(other).length, 0);
});
