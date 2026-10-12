import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPROVAL_PLAN,
  enableApprovalPolicy,
  inspectApprovals,
  reserveApproval,
  approvalReceipt,
  approvalObservationReady,
  armSelectedWorker,
  completionResultReceipt,
} from "./native-approval.mjs";
import {
  createNativeScope,
  observeProjection,
  assertNativeRpc,
  NATIVE_ORIGIN,
} from "./native-rpc.mjs";
import { hydrateApprovedToolOutputs } from "./native-tool-detail.mjs";
const [metadata, ...events] = readFileSync(
  new URL("./native-wire/native-readonly-wait.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map(JSON.parse);
const projectId = metadata.projectId,
  coordinatorId = `project-coordinator:${projectId}`;
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
  message: "messages",
};
function prefix(sequence, wire = false) {
  const snapshots = new Map();
  for (const e of events.filter((e) => e.sequence <= sequence)) {
    const entity = e.type.split(".")[0];
    if (!snapshots.has(e.streamId))
      snapshots.set(e.streamId, Object.fromEntries(Object.values(fields).map((k) => [k, []])));
    const p = snapshots.get(e.streamId),
      value = structuredClone(wire && e.wirePayload ? e.wirePayload : e.payload);
    if (entity === "thread") p.thread = { ...p.thread, ...value };
    else {
      const rows = p[fields[entity]],
        i = rows.findIndex((r) => r.id === value.id);
      if (wire && entity === "turn-item") delete value.threadId;
      if (i < 0) rows.push(value);
      else rows[i] = { ...rows[i], ...value };
    }
  }
  return snapshots;
}
function replay() {
  const scope = createNativeScope(projectId, true, 5),
    p = prefix(33).get(coordinatorId),
    run = p.runs[0];
  enableApprovalPolicy(
    scope,
    {
      schemaVersion: 2,
      authorization: "six-native-project-runs-with-exact-single-use-approvals",
      approvalPlan: structuredClone(APPROVAL_PLAN),
      maxRuns: 5,
      codex: { model: run.modelSelection.model },
      claude: { model: "claude-haiku-5-5" },
    },
    metadata.followupId,
  );
  const dispatch = metadata.userDispatches[0];
  assertNativeRpc(
    NATIVE_ORIGIN,
    dispatch.tag,
    {
      projectId,
      commandId: dispatch.commandId,
      prompt: "Recorded synthetic dispatch; offline only.",
    },
    scope,
  );
  return { scope, snapshots: new Map() };
}
function hydrate(f, sequence) {
  const raw = prefix(sequence);
  f.snapshots = prefix(sequence, true);
  for (const p of f.snapshots.values()) observeProjection(f.scope, p);
  for (const [id, p] of f.snapshots) {
    const result = hydrateApprovedToolOutputs(
      f.scope,
      p,
      (projectId, threadId, itemId) => ({
        projectId,
        threadId,
        item: raw.get(threadId).turnItems.find((i) => i.id === itemId),
      }),
      sequence,
    );
    assert(result.ready);
    f.snapshots.set(id, result.projection);
  }
  return f.snapshots.get(coordinatorId);
}
function runToWait(last = 198) {
  const f = replay();
  for (let sequence = 33; sequence <= last; sequence++) {
    if (sequence === 141) {
      const d = metadata.userDispatches[1],
        parent = f.snapshots.get(coordinatorId),
        worker = f.snapshots.get(d.sourceThreadId);
      completionResultReceipt(f.scope, parent);
      armSelectedWorker(f.scope, worker, parent);
      assertNativeRpc(
        NATIVE_ORIGIN,
        d.tag,
        {
          projectId,
          commandId: d.commandId,
          sourceThreadId: d.sourceThreadId,
          prompt: "Recorded synthetic follow-up; offline only.",
        },
        f.scope,
      );
    }
    hydrate(f, sequence);
    const binding = inspectApprovals(f.scope, f.snapshots, sequence);
    if (sequence === 141) assert.equal(approvalObservationReady(f.scope), false);
    if (sequence === 142) assert.equal(approvalObservationReady(f.scope), true);
    if (binding) {
      assert([33, 116, 161].includes(sequence), `unexpected approval sequence ${sequence}`);
      const command = reserveApproval(f.scope, binding);
      assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope);
    }
    if (sequence === 197) {
      const p = f.snapshots.get(coordinatorId),
        wait = p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_wait");
      assert.equal(wait.status, "running");
      assert.equal(p.nodes.find((n) => n.id === wait.nodeId).status, "completed");
    }
  }
  return f;
}
test("actual event prefixes33–198 preserve three approvals and hydrate the completed unprompted wait after node publication", () => {
  const f = runToWait(),
    p = f.snapshots.get(coordinatorId),
    wait = p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_wait");
  assert.deepEqual(
    approvalReceipt(f.scope).map((a) => a.operation),
    ["delegate_task", "task_status", "studio_thread_send"],
  );
  assert.equal(f.scope.runs.size, 5);
  assert.equal(wait.status, "completed");
  assert.equal(wait.output.status, "completed");
  assert.equal(wait.output.timedOut, false);
  assert.equal(wait.output.runId, wait.input.runId);
  assert.equal(wait.output.threadId, metadata.userDispatches[1].sourceThreadId);
  assert.equal(
    p.turnItems.some((i) => i.toolName === "studio-code.studio_thread_read"),
    false,
  );
});
test("actual readonly wait has no approval request and the wire retains only its thread identity", () => {
  const raw = prefix(198).get(coordinatorId),
    wire = prefix(198, true).get(coordinatorId),
    wait = wire.turnItems.find((i) => i.toolName === "studio-code.studio_thread_wait");
  assert.deepEqual(Object.keys(wait.output), ["threadId"]);
  assert.equal(wait.outputOmitted, true);
  assert.equal(raw.turnItems.filter((i) => i.type === "approval_request").length, 3);
  assert(
    !raw.turnItems.some(
      (i) => i.type === "approval_request" && i.prompt.includes("studio_thread_wait"),
    ),
  );
  assert.equal(events.find((e) => e.sequence === 196).payload.status, "running");
  assert.equal(events.find((e) => e.sequence === 198).payload.status, "completed");
});

test("actual follow-up run141 may await attempt142 for at most two seconds without readiness or another grant", () => {
  const f = runToWait(141);
  assert.equal(approvalObservationReady(f.scope), false);
  assert.equal(approvalReceipt(f.scope).length, 2);
  assert.throws(
    () => completionResultReceipt(f.scope, f.snapshots.get(coordinatorId)),
    /publication incomplete/,
  );
  assert.throws(
    () => inspectApprovals(f.scope, f.snapshots, 2142),
    /publication changed or timed out/,
  );
});
for (const [name, mutate] of Object.entries({
  "wrong run identity": (p) => {
    p.runs.at(-1).rootNodeId = "foreign";
  },
  "wrong present attempt": (p) => {
    p.attempts.at(-1).reason = "retry";
  },
  "extra attempt": (p) => {
    p.attempts.push({ ...p.attempts.at(-1), id: "extra" });
  },
  "foreign attempt owner": (p) => {
    p.attempts.at(-1).runId = "foreign";
  },
  "run disappearance": (p) => {
    p.runs.pop();
  },
}))
  test(`actual follow-up publication refuses ${name}`, () => {
    const f = runToWait(141);
    const p = hydrate(f, 142);
    mutate(p);
    assert.throws(() => inspectApprovals(f.scope, f.snapshots, 142), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 2);
  });
test("a previously published source attempt cannot disappear into publication defer", () => {
  const f = runToWait(142),
    p = f.snapshots.get(coordinatorId);
  p.attempts.pop();
  assert.throws(
    () => inspectApprovals(f.scope, f.snapshots, 143),
    /source initial publication binding/,
  );
});
