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
  new URL("./native-wire/native-read-output.jsonl", import.meta.url),
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
function runToRead(last = 211) {
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

test("actual prefixes33–211 restore full read metadata with four genuine approvals and preserve all earlier guards", () => {
  const f = runToRead(),
    p = f.snapshots.get(coordinatorId),
    read = p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_read");
  assert.deepEqual(
    approvalReceipt(f.scope).map((a) => a.operation),
    ["delegate_task", "task_status", "studio_thread_send", "studio_thread_read"],
  );
  assert.equal(f.scope.runs.size, 5);
  assert.equal(read.status, "completed");
  assert.equal(read.output.thread.threadId, read.input.threadId);
  assert(read.output.thread.title);
  assert(Array.isArray(read.output.recentRuns));
  assert(Array.isArray(read.output.items));
  assert.deepEqual(
    read.output,
    prefix(211)
      .get(coordinatorId)
      .turnItems.find((i) => i.id === read.id).output,
  );
});
function readState() {
  const f = runToRead(210),
    raw = prefix(211);
  f.snapshots = prefix(211, true);
  for (const p of f.snapshots.values()) observeProjection(f.scope, p);
  const p = f.snapshots.get(coordinatorId);
  return {
    f,
    p,
    raw,
    wire: p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_read"),
    item: raw
      .get(coordinatorId)
      .turnItems.find((i) => i.toolName === "studio-code.studio_thread_read"),
  };
}
for (const [name, mutate] of Object.entries({
  "foreign nested wire ID": (s) => {
    s.wire.output.thread.threadId = "foreign";
  },
  "extra nested wire field": (s) => {
    s.wire.output.thread.title = s.item.output.thread.title;
  },
  "missing nested wire ID": (s) => {
    s.wire.output.thread = {};
  },
  "foreign full thread ID": (s) => {
    s.item.output.thread.threadId = "foreign";
  },
  "nonobject full thread": (s) => {
    s.item.output.thread = [];
  },
  "unrelated projected field conflict": (s) => {
    s.wire.output.threadId = "foreign";
  },
  "foreign stored owner": (s) => {
    s.item.threadId = "foreign";
  },
}))
  test(`actual read projection refuses ${name}`, () => {
    const s = readState();
    mutate(s);
    assert.throws(
      () =>
        hydrateApprovedToolOutputs(
          s.f.scope,
          s.p,
          (projectId, threadId, itemId) => ({
            projectId,
            threadId,
            item: s.raw.get(threadId).turnItems.find((i) => i.id === itemId),
          }),
          211,
        ),
      /Native tool detail refused/,
    );
    assert.equal(approvalReceipt(s.f.scope).length, 4);
  });
test("read projection restores no detail until the exact stored revision matches", () => {
  const s = readState(),
    reads = (projectId, threadId, itemId) => ({
      projectId,
      threadId,
      item: s.raw.get(threadId).turnItems.find((i) => i.id === itemId),
    });
  s.item.updatedAt = "2026-10-09T20:00:00.000Z";
  const pending = hydrateApprovedToolOutputs(s.f.scope, s.p, reads, 0);
  assert.equal(pending.ready, false);
  assert.deepEqual(pending.projection.turnItems.find((i) => i.id === s.wire.id).output, {
    thread: { threadId: s.wire.input.threadId },
  });
  s.wire.updatedAt = s.item.updatedAt;
  assert.equal(hydrateApprovedToolOutputs(s.f.scope, s.p, reads, 1).ready, true);
  assert.equal(approvalReceipt(s.f.scope).length, 4);
});

for (const operation of [
  "delegate_task",
  "task_status",
  "studio_thread_send",
  "studio_thread_wait",
  "studio_thread_read",
]) {
  for (const mutation of [
    "omitted output",
    "empty output",
    "missing canonical key",
    "extra canonical key",
    "foreign canonical value",
  ]) {
    test(`whole canonical ${operation} output refuses ${mutation}`, () => {
      const s = readState(),
        wire = s.p.turnItems.find((i) => i.toolName === `studio-code.${operation}`);
      const key = Object.keys(wire.output)[0];
      if (mutation === "omitted output") delete wire.output;
      else if (mutation === "empty output") wire.output = {};
      else if (mutation === "missing canonical key") delete wire.output[key];
      else if (mutation === "extra canonical key") wire.output.extra = "unreviewed";
      else wire.output[key] = key === "thread" ? { threadId: "foreign" } : "foreign";
      assert.throws(
        () =>
          hydrateApprovedToolOutputs(
            s.f.scope,
            s.p,
            (projectId, threadId, itemId) => ({
              projectId,
              threadId,
              item: s.raw.get(threadId).turnItems.find((i) => i.id === itemId),
            }),
            211,
          ),
        /canonical wire output conflicts/,
      );
      assert.equal(approvalReceipt(s.f.scope).length, 4);
    });
  }
}

for (const operation of [
  "delegate_task",
  "task_status",
  "studio_thread_send",
  "studio_thread_wait",
  "studio_thread_read",
]) {
  for (const marker of [undefined, false])
    test(`completed ${operation} refuses outputOmitted=${marker}`, () => {
      const s = readState(),
        wire = s.p.turnItems.find((i) => i.toolName === `studio-code.${operation}`);
      wire.outputOmitted = marker;
      delete wire.output;
      assert.throws(
        () =>
          hydrateApprovedToolOutputs(
            s.f.scope,
            s.p,
            (projectId, threadId, itemId) => ({
              projectId,
              threadId,
              item: s.raw.get(threadId).turnItems.find((i) => i.id === itemId),
            }),
            211,
          ),
        /completed wire output marker missing/,
      );
      assert.equal(approvalReceipt(s.f.scope).length, 4);
    });
}
test("send output cannot omit its second canonical messageId key", () => {
  const s = readState(),
    wire = s.p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_send");
  delete wire.output.messageId;
  assert.throws(
    () =>
      hydrateApprovedToolOutputs(
        s.f.scope,
        s.p,
        (projectId, threadId, itemId) => ({
          projectId,
          threadId,
          item: s.raw.get(threadId).turnItems.find((i) => i.id === itemId),
        }),
        211,
      ),
    /canonical wire output conflicts/,
  );
  assert.equal(approvalReceipt(s.f.scope).length, 4);
});
