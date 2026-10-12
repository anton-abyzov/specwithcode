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
// Prefixes reconstruct retained event order, not SQL commit boundaries or observed HTTP responses.
// Atomic writer batches may make intermediate prefixes unobservable; this tests defensive read skew.
const [metadata, ...events] = readFileSync(
  new URL("./native-wire/native-initial-publication.jsonl", import.meta.url),
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
function runToFinal(last = 224) {
  const f = replay();
  for (let sequence = 1; sequence <= last; sequence++) {
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
    if (sequence === 6) assert.equal(approvalObservationReady(f.scope), false);
    if (sequence === 7) assert.equal(approvalObservationReady(f.scope), true);
    if (sequence === 141) assert.equal(approvalObservationReady(f.scope), false);
    if (sequence === 142) assert.equal(approvalObservationReady(f.scope), true);
    if (binding) {
      assert([33, 116, 161, 206].includes(sequence), `unexpected approval sequence ${sequence}`);
      const command = reserveApproval(f.scope, binding);
      assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope);
    }
    if (sequence === 210) {
      const p = f.snapshots.get(coordinatorId),
        read = p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_read");
      assert.equal(read.status, "running");
      assert.equal(p.nodes.find((n) => n.id === read.nodeId).status, "completed");
    }
  }
  return f;
}

test("all recorded prefixes1–224 retain exact guarded lineage; final interrupted case remains a failure", () => {
  const f = runToFinal();
  assert.deepEqual(
    approvalReceipt(f.scope).map((a) => a.operation),
    ["delegate_task", "task_status", "studio_thread_send", "studio_thread_read"],
  );
  assert.equal(f.scope.runs.size, 5);
  assert.equal(
    f.scope.runs.get(f.snapshots.get(coordinatorId).runs.at(-1).id).status,
    "interrupted",
  );
  assert.equal(
    [...f.scope.runs.values()].every((r) => r.status === "completed"),
    false,
    "same waitSettled completion condition remains false",
  );
});
test("initial run publication6 withholds readiness/receipt/approvals until bound attempt7", () => {
  const f = runToFinal(6);
  assert.equal(approvalObservationReady(f.scope), false);
  assert.equal(approvalReceipt(f.scope).length, 0);
  assert.throws(
    () => completionResultReceipt(f.scope, f.snapshots.get(coordinatorId)),
    /publication incomplete/,
  );
  hydrate(f, 7);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 7), null);
  assert.equal(approvalObservationReady(f.scope), true);
  assert.equal(approvalReceipt(f.scope).length, 0);
});
test("initial run publication deadline does not authorize a native retry or delayed attempt", () => {
  const f = runToFinal(6);
  assert.throws(
    () => inspectApprovals(f.scope, f.snapshots, 2007),
    /publication changed or timed out/,
  );
  const g = runToFinal(6);
  hydrate(g, 7);
  assert.throws(
    () => inspectApprovals(g.scope, g.snapshots, 2007),
    /publication changed or timed out/,
  );
});
for (const [name, mutate] of Object.entries({
  "different run identity": (p) => {
    p.runs[0].rootNodeId = "foreign";
  },
  "different provider link": (p) => {
    p.providerThreads[0].providerSessionId = "foreign";
  },
  "wrong first attempt": (p) => {
    p.attempts[0].reason = "retry";
  },
  "second attempt": (p) => {
    p.attempts.push({ ...p.attempts[0], id: "extra" });
  },
  "foreign attempt owner": (p) => {
    p.attempts[0].runId = "foreign";
  },
  "run disappears": (p) => {
    p.runs = [];
  },
}))
  test(`initial publication refuses ${name}`, () => {
    const f = runToFinal(6),
      p = hydrate(f, 7);
    mutate(p);
    assert.throws(() => inspectApprovals(f.scope, f.snapshots, 7), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  });
for (const [name, mutate] of Object.entries({
  "wrong model": (p) => {
    p.runs[0].modelSelection.model = "other";
  },
  "unreviewed source": (p) => {
    p.runs[0].userMessageId = "foreign";
  },
  "extra first run": (p) => {
    p.runs.push({ ...p.runs[0], id: "extra" });
  },
  "extra provider": (p) => {
    p.providerThreads.push({ ...p.providerThreads[0], id: "extra" });
  },
  "foreign provider owner": (p) => {
    p.providerThreads[0].appThreadId = "foreign";
  },
  "loaded native identity": (p) => {
    p.providerThreads[0].nativeThreadRef = { nativeId: "foreign" };
  },
  "session before attempt": (p) => {
    p.providerSessions.push({ id: "foreign" });
  },
  "work before attempt": (p) => {
    p.turnItems.push({ id: "foreign", type: "dynamic_tool" });
  },
}))
  test(`first initial observation refuses ${name}`, () => {
    const f = replay(),
      p = hydrate(f, 6);
    mutate(p);
    assert.throws(() => inspectApprovals(f.scope, f.snapshots, 6), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  });
test("published first attempt cannot disappear into initial defer", () => {
  const f = runToFinal(7),
    p = f.snapshots.get(coordinatorId);
  p.attempts = [];
  assert.throws(
    () => inspectApprovals(f.scope, f.snapshots, 8),
    /initial source publication binding/,
  );
});
