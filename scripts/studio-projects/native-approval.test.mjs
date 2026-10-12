import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_PLAN,
  APPROVAL_OPTIONS,
  WORKER_TASK,
  delegateInput,
  enableApprovalPolicy,
  armSelectedWorker,
  inspectApprovals,
  reserveApproval,
  approvalReceipt,
  completionReceipt,
  completionResultReceipt,
} from "./native-approval.mjs";
import {
  NATIVE_ORIGIN,
  createNativeScope,
  observeProjection,
  assertNativeRpc,
  nativeRpc,
} from "./native-rpc.mjs";
import { nativeObservationOrder, sanitizedFailure } from "./native-acceptance.mjs";

const projectId = "synthetic-project",
  coordinatorId = `project-coordinator:${projectId}`;
const review = () => ({
  schemaVersion: 2,
  authorization: "six-native-project-runs-with-exact-single-use-approvals",
  approvalPlan: structuredClone(APPROVAL_PLAN),
  maxRuns: 6,
  codex: { model: "codex-test" },
  claude: { model: "claude-test" },
});
function fixture(maxRuns = 6) {
  const scope = createNativeScope(projectId, true, maxRuns);
  enableApprovalPolicy(scope, { ...review(), maxRuns }, "followup-intent");
  assertNativeRpc(
    NATIVE_ORIGIN,
    "projects.coordinatorStart",
    { projectId, commandId: "start", prompt: "Synthetic first cycle" },
    scope,
  );
  const run = {
    id: "parent-run",
    ordinal: 1,
    threadId: coordinatorId,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "codex-test" },
    providerThreadId: "provider-thread",
    userMessageId: `coordinator-send:${projectId}:start`,
    rootNodeId: "root",
    activeAttemptId: "attempt",
    status: "running",
  };
  const owner = { runId: run.id, providerThreadId: run.providerThreadId, providerTurnId: "turn" };
  const call = {
    ...owner,
    id: "tool-item",
    nodeId: "tool-node",
    type: "dynamic_tool",
    toolName: "studio-code.delegate_task",
    input: delegateInput("claude-test"),
    ordinal: 1,
    status: "running",
  };
  const request = {
    id: "request",
    nodeId: "approval-node",
    providerTurnId: "turn",
    kind: "mcp-elicitation",
    status: "pending",
    resolvedAt: null,
    nativeRequestRef: {
      driver: "codex",
      nativeId: "mcp-elicitation:studio-code",
      strength: "strong",
    },
    responseCapability: { type: "live", providerSessionId: "session" },
  };
  const approval = {
    ...owner,
    id: "approval-item",
    nodeId: "approval-node",
    type: "approval_request",
    requestId: request.id,
    requestKind: "mcp-elicitation",
    appName: "studio-code",
    prompt: 'Allow the studio-code MCP server to run tool "delegate_task"?',
    options: structuredClone(APPROVAL_OPTIONS),
    ordinal: 2,
    status: "waiting",
  };
  const p = {
    thread: {
      id: coordinatorId,
      projectId,
      providerInstanceId: "codex",
      modelSelection: run.modelSelection,
      runtimeMode: "approval-required",
      activeProviderThreadId: "provider-thread",
    },
    runs: [run],
    runtimeRequests: [request],
    attempts: [
      {
        id: "attempt",
        runId: run.id,
        attemptOrdinal: 1,
        reason: "initial",
        status: "running",
        rootNodeId: "root",
        providerInstanceId: "codex",
        providerThreadId: "provider-thread",
        providerTurnId: "turn",
      },
    ],
    providerTurns: [
      {
        id: "turn",
        runAttemptId: "attempt",
        nodeId: "root",
        providerThreadId: "provider-thread",
        status: "running",
      },
    ],
    providerThreads: [
      {
        id: "provider-thread",
        appThreadId: coordinatorId,
        driver: "codex",
        providerInstanceId: "codex",
        providerSessionId: "session",
        status: "active",
      },
    ],
    providerSessions: [
      {
        id: "session",
        driver: "codex",
        providerInstanceId: "codex",
        model: "codex-test",
        status: "running",
      },
    ],
    nodes: [
      {
        ...owner,
        id: "tool-node",
        threadId: coordinatorId,
        rootNodeId: "root",
        kind: "tool_call",
        status: "running",
        nativeItemRef: { driver: "codex", nativeId: "call", strength: "strong" },
      },
      {
        ...owner,
        id: "approval-node",
        threadId: coordinatorId,
        rootNodeId: "root",
        kind: "approval_request",
        status: "waiting",
        runtimeRequestId: request.id,
        nativeItemRef: {
          driver: "codex",
          nativeId: "mcp-elicitation:studio-code",
          strength: "strong",
        },
      },
    ],
    turnItems: [call, approval],
    subagents: [],
  };
  observeProjection(scope, p);
  return { scope, p, run, call, request, approval, snapshots: new Map([[coordinatorId, p]]) };
}
function candidate(f) {
  return inspectApprovals(f.scope, f.snapshots);
}
function accept(f) {
  const command = reserveApproval(f.scope, candidate(f));
  assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope);
  return command;
}
test("schema-faithful projection without turn-item threadId binds one exact single-use accept", () => {
  const f = fixture();
  assert.equal(f.call.threadId, undefined);
  assert.equal(f.approval.threadId, undefined);
  const binding = candidate(f);
  assert.equal(binding.operation, "delegate_task");
  assert.equal(binding.runId, f.run.id);
  const command = reserveApproval(f.scope, binding);
  assert.deepEqual(Object.keys(command).sort(), [
    "commandId",
    "decision",
    "requestId",
    "threadId",
    "type",
  ]);
  assert.equal(command.decision, "accept");
  assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope);
  assert.equal(candidate(f), null, "pending readback never resubmits");
  assert.throws(
    () => assertNativeRpc(NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope),
    /repeated response/,
  );
  assert.equal(approvalReceipt(f.scope)[0].submitted, true);
});
test("nullable attempt backreference uses the unique live provider turn forward link", () => {
  const f = fixture();
  f.p.attempts[0].providerTurnId = null;
  assert.equal(candidate(f).providerTurnId, "turn");
  f.p.providerTurns.push({ ...f.p.providerTurns[0], id: "ambiguous" });
  assert.throws(() => candidate(f), /provider turn missing\/ambiguous/);
});

const mutations = {
  "foreign project": (f) => {
    f.p.thread.projectId = "foreign";
  },
  "foreign coordinator": (f) => {
    f.p.thread.id = "foreign";
  },
  "different provider": (f) => {
    f.p.thread.providerInstanceId = "other";
  },
  "different coordinator model": (f) => {
    f.p.thread.modelSelection = { instanceId: "codex", model: "other" };
  },
  "full access runtime": (f) => {
    f.p.thread.runtimeMode = "full-access";
  },
  "ordinary shell approval": (f) => {
    f.request.kind = "command-execution";
  },
  "resolved request with pending status": (f) => {
    f.request.resolvedAt = "2026-10-09T12:00:00Z";
  },
  "prior decision": (f) => {
    f.request.decision = "acceptAlways";
  },
  "different MCP server": (f) => {
    f.request.nativeRequestRef.nativeId = "mcp-elicitation:other";
  },
  "weak native ref": (f) => {
    f.request.nativeRequestRef.strength = "weak";
  },
  "not resumable": (f) => {
    f.request.responseCapability = { type: "not_resumable" };
  },
  "unknown session": (f) => {
    f.request.responseCapability.providerSessionId = "other";
  },
  "prompt mismatch": (f) => {
    f.approval.prompt += " also allow shell";
  },
  "app mismatch": (f) => {
    f.approval.appName = "other";
  },
  "ambiguous approval item": (f) => {
    f.p.turnItems.push({ ...f.approval, id: "duplicate" });
  },
  "changed choices": (f) => {
    f.approval.options[4].decision = "acceptAlways";
  },
  "extra choice": (f) => {
    f.approval.options.push({ decision: "allowAll", label: "All" });
  },
  "stale completed call": (f) => {
    f.call.status = "completed";
  },
  "different call provider turn": (f) => {
    f.call.providerTurnId = "other";
  },
  "different call provider thread": (f) => {
    f.call.providerThreadId = "other";
  },
  "explicit foreign turn item": (f) => {
    f.call.threadId = "foreign";
  },
  "wrong approval order": (f) => {
    f.approval.ordinal = 0;
  },
  "unreviewed tool": (f) => {
    f.call.toolName = "studio-code.exec";
  },
  "different worker model": (f) => {
    f.call.input.target.model = "other";
  },
  "different worker provider": (f) => {
    f.call.input.target.providerInstanceId = "codex";
  },
  "different worker prompt": (f) => {
    f.call.input.task += " Do extra work.";
  },
  "different idempotency ID": (f) => {
    f.call.input.clientRequestId = "other";
  },
  "extra tool input": (f) => {
    f.call.input.timeoutMs = 120000;
  },
  "unowned source message": (f) => {
    f.run.userMessageId = "other";
  },
  "completion wake": (f) => {
    f.run.delegatedCompletion = {};
  },
  "credit intent": (f) => {
    f.run.manualCodexCreditIntent = {};
  },
  "run provider drift": (f) => {
    f.run.providerInstanceId = "other";
  },
  "completed run": (f) => {
    f.run.status = "completed";
  },
  "run changed thread": (f) => {
    f.run.threadId = "other";
  },
  "wrong active attempt": (f) => {
    f.run.activeAttemptId = "other";
  },
  "provider retry": (f) => {
    f.p.attempts[0].reason = "retry";
  },
  "second attempt": (f) => {
    f.p.attempts[0].attemptOrdinal = 2;
  },
  "attempt turn drift": (f) => {
    f.p.attempts[0].providerTurnId = "other";
  },
  "provider turn attempt drift": (f) => {
    f.p.providerTurns[0].runAttemptId = "other";
  },
  "completed provider turn": (f) => {
    f.p.providerTurns[0].status = "completed";
  },
  "provider thread owner drift": (f) => {
    f.p.providerThreads[0].appThreadId = "other";
  },
  "inactive provider thread": (f) => {
    f.p.providerThreads[0].status = "idle";
  },
  "stopped provider session": (f) => {
    f.p.providerSessions[0].status = "stopped";
  },
  "session model fallback": (f) => {
    f.p.providerSessions[0].model = "other";
  },
  "node owner drift": (f) => {
    f.p.nodes[0].threadId = "other";
  },
  "node request drift": (f) => {
    f.p.nodes[1].runtimeRequestId = "other";
  },
  "node root drift": (f) => {
    f.p.nodes[0].rootNodeId = "other";
  },
  "unobserved shell execution node": (f) => {
    f.p.nodes.push({ kind: "tool_call", id: "shell" });
  },
  "extra same operation": (f) => {
    f.p.turnItems.push({ ...f.call, id: "extra-call" });
  },
  "multiple pending": (f) => {
    f.p.runtimeRequests.push({ ...f.request, id: "extra" });
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`approval rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => candidate(f), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  });
test("unobserved bindings and repeated/resolved request identities cannot reserve a grant", () => {
  const f = fixture(),
    binding = candidate(f);
  assert.throws(() => reserveApproval(f.scope, { ...binding, threadId: "other" }));
  accept(f);
  f.request.status = "resolved";
  candidate(f);
  f.request.status = "pending";
  assert.throws(() => candidate(f), /resolved request replay/);
  const replay = fixture();
  accept(replay);
  replay.request.id = "new-request";
  replay.approval.requestId = "new-request";
  replay.p.nodes[1].runtimeRequestId = "new-request";
  assert.throws(() => candidate(replay), /operation approval replay/);
});
test("always/session grants, extra response fields, foreign requests and arbitrary responses fail before transport", () => {
  for (const patch of [
    { decision: "acceptAlways" },
    { decision: "acceptForSession" },
    { requestId: "foreign" },
    { threadId: "foreign" },
    { runId: "parent-run" },
    { answers: {} },
    { commandId: "unreserved" },
  ]) {
    const f = fixture(),
      command = reserveApproval(f.scope, candidate(f));
    assert.throws(() =>
      assertNativeRpc(
        NATIVE_ORIGIN,
        "orchestration.dispatchCommand",
        { ...command, ...patch },
        f.scope,
      ),
    );
    assert.equal(approvalReceipt(f.scope)[0].submitted, false);
  }
  assert.throws(() =>
    assertNativeRpc(
      NATIVE_ORIGIN,
      "orchestration.dispatchCommand",
      {
        type: "runtime-request.respond",
        commandId: "invented",
        threadId: coordinatorId,
        requestId: "request",
        decision: "accept",
      },
      createNativeScope(projectId, true),
    ),
  );
});
test("failed approval transport consumes the grant and refuses any automatic retry", async () => {
  const f = fixture(),
    command = reserveApproval(f.scope, candidate(f));
  let calls = 0;
  const context = {
    request: {
      post: async () => {
        calls++;
        throw new Error("PRIVATE_CREDENTIAL");
      },
    },
  };
  await assert.rejects(
    nativeRpc(context, NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope),
  );
  await assert.rejects(
    nativeRpc(context, NATIVE_ORIGIN, "orchestration.dispatchCommand", command, f.scope),
    /repeated response/,
  );
  assert.equal(calls, 1);
  assert.equal(approvalReceipt(f.scope)[0].submitted, true);
});
test("six-run and turn budget remains an independent prerequisite to approvals", () => {
  for (const key of ["runs", "providerTurns", "attempts"]) {
    const f = fixture();
    for (let i = 0; i < 7; i++)
      key === "runs" ? f.scope[key].set(`extra-${i}`, {}) : f.scope[key].add(`extra-${i}`);
    assert.throws(() => candidate(f), /budget/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  }
});

function continuation() {
  const f = fixture();
  accept(f);
  f.call.output = { taskId: "owned-task", childThreadId: "worker", childRunId: "worker-first" };
  f.request.status = "resolved";
  f.request.resolvedAt = "2026-10-09T12:00:00Z";
  f.call.status = "completed";
  f.approval.status = "completed";
  for (const n of f.p.nodes) n.status = "completed";
  f.run.status = "completed";
  f.p.attempts[0].status = "completed";
  f.p.providerTurns[0].status = "completed";
  const worker = {
    thread: {
      id: "worker",
      projectId,
      providerInstanceId: "claudeAgent",
      modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
      runtimeMode: "approval-required",
    },
    runs: [{ id: "worker-first", threadId: "worker", status: "completed" }],
    turnItems: [],
    nodes: [],
    runtimeRequests: [],
    attempts: [],
    providerTurns: [],
    subagents: [],
  };
  f.p.subagents = [{ origin: "app_owned", childThreadId: "worker", status: "completed" }];
  f.snapshots.set("worker", worker);
  observeProjection(f.scope, worker);
  armSelectedWorker(f.scope, worker, f.p);
  assertNativeRpc(
    NATIVE_ORIGIN,
    "projects.coordinatorSend",
    { projectId, commandId: "send", prompt: "Synthetic second cycle", sourceThreadId: "worker" },
    f.scope,
  );
  const run = {
    ...f.run,
    id: "parent-followup",
    ordinal: 2,
    status: "running",
    userMessageId: `coordinator-send:${projectId}:send`,
    rootNodeId: "root2",
    activeAttemptId: "attempt2",
  };
  f.p.runs.push(run);
  f.p.attempts.push({
    ...f.p.attempts[0],
    id: "attempt2",
    runId: run.id,
    rootNodeId: "root2",
    providerTurnId: "turn2",
    status: "running",
  });
  f.p.providerTurns.push({
    ...f.p.providerTurns[0],
    id: "turn2",
    runAttemptId: "attempt2",
    nodeId: "root2",
    status: "running",
  });
  f.run = run;
  f.worker = worker;
  return f;
}
function requestOperation(f, operation, input) {
  if (f.request.status === "pending") {
    f.request.status = "resolved";
    f.request.resolvedAt = "2026-10-09T12:00:00Z";
    f.approval.status = "completed";
  }
  const owner = { runId: f.run.id, providerThreadId: "provider-thread", providerTurnId: "turn2" };
  f.call = {
    ...owner,
    id: `${operation}-item`,
    nodeId: `${operation}-node`,
    type: "dynamic_tool",
    toolName: `studio-code.${operation}`,
    input,
    status: "running",
    ordinal: f.p.turnItems.length + 1,
  };
  f.request = {
    id: `${operation}-request`,
    nodeId: `${operation}-approval-node`,
    providerTurnId: "turn2",
    kind: "mcp-elicitation",
    status: "pending",
    resolvedAt: null,
    nativeRequestRef: {
      driver: "codex",
      nativeId: "mcp-elicitation:studio-code",
      strength: "strong",
    },
    responseCapability: { type: "live", providerSessionId: "session" },
  };
  f.approval = {
    ...owner,
    id: `${operation}-approval`,
    nodeId: f.request.nodeId,
    type: "approval_request",
    requestId: f.request.id,
    requestKind: "mcp-elicitation",
    appName: "studio-code",
    prompt: `Allow the studio-code MCP server to run tool "${operation}"?`,
    options: structuredClone(APPROVAL_OPTIONS),
    status: "waiting",
    ordinal: f.call.ordinal + 1,
  };
  f.p.turnItems.push(f.call, f.approval);
  f.p.runtimeRequests.push(f.request);
  f.p.nodes.push(
    {
      ...owner,
      threadId: coordinatorId,
      rootNodeId: "root2",
      id: f.call.nodeId,
      kind: "tool_call",
      status: "running",
    },
    {
      ...owner,
      threadId: coordinatorId,
      rootNodeId: "root2",
      id: f.request.nodeId,
      kind: "approval_request",
      runtimeRequestId: f.request.id,
      status: "waiting",
    },
  );
  observeProjection(f.scope, f.p);
}
function sendComplete(f) {
  requestOperation(f, "studio_thread_send", {
    threadId: "worker",
    message: WORKER_TASK,
    mode: "auto",
    clientRequestId: "followup-intent",
  });
  accept(f);
  f.call.status = "completed";
  f.call.output = {
    threadId: "worker",
    messageId: "worker-message2",
    runId: "worker-second",
    status: "running",
    delivery: "started",
  };
  f.worker.runs.push({
    id: "worker-second",
    threadId: "worker",
    userMessageId: "worker-message2",
    status: "running",
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
  });
  observeProjection(f.scope, f.worker);
}
test("full offline delegate/send/wait/read cycle issues four exact one-time accepts within six runs", () => {
  const f = continuation();
  sendComplete(f);
  requestOperation(f, "studio_thread_wait", {
    threadId: "worker",
    runId: "worker-second",
    timeoutMs: 120000,
  });
  accept(f);
  f.call.status = "completed";
  f.call.output = { threadId: "worker", runId: "worker-second", status: "idle", timedOut: false };
  f.worker.runs[1].status = "completed";
  requestOperation(f, "studio_thread_read", { threadId: "worker", view: "messages" });
  accept(f);
  assert.deepEqual(
    approvalReceipt(f.scope).map((x) => x.operation),
    ["delegate_task", "studio_thread_send", "studio_thread_wait", "studio_thread_read"],
  );
  assert.equal(f.scope.runs.size, 4);
  assert.equal(candidate(f), null);
});
test("selected-worker send requires the exact owned worker, intent and text", () => {
  for (const patch of [
    { threadId: "foreign" },
    { clientRequestId: "other" },
    { message: "Extra task" },
    { mode: "restart" },
  ]) {
    const f = continuation();
    requestOperation(f, "studio_thread_send", {
      threadId: "worker",
      message: WORKER_TASK,
      mode: "auto",
      clientRequestId: "followup-intent",
      ...patch,
    });
    assert.throws(() => candidate(f));
  }
  const f = fixture();
  f.call.toolName = "studio-code.studio_thread_send";
  assert.throws(() => candidate(f), /source dispatch/);
});
test("wait binds direct completed send output to the exact second worker run", () => {
  for (const alter of [
    (f) => {
      f.call.output = [{ text: JSON.stringify(f.call.output) }];
    },
    (f) => {
      f.call.output.runId = "worker-first";
    },
    (f) => {
      f.call.output.messageId = "other";
    },
    (f) => {
      f.call.output.threadId = "other";
    },
    (f) => {
      f.worker.runs[1].modelSelection.model = "fallback";
    },
  ]) {
    const f = continuation();
    sendComplete(f);
    alter(f);
    requestOperation(f, "studio_thread_wait", {
      threadId: "worker",
      runId: "worker-second",
      timeoutMs: 120000,
    });
    assert.throws(() => candidate(f));
  }
  for (const patch of [{ runId: "worker-first" }, { timeoutMs: 120001 }, { threadId: "foreign" }]) {
    const f = continuation();
    sendComplete(f);
    requestOperation(f, "studio_thread_wait", {
      threadId: "worker",
      runId: "worker-second",
      timeoutMs: 120000,
      ...patch,
    });
    assert.throws(() => candidate(f));
  }
});
test("read cannot precede the one exact wait or follow timeout/foreign wait result", () => {
  for (const mode of ["no-wait", "timed-out", "foreign-run", "still-running"]) {
    const f = continuation();
    sendComplete(f);
    if (mode !== "no-wait") {
      requestOperation(f, "studio_thread_wait", {
        threadId: "worker",
        runId: "worker-second",
        timeoutMs: 120000,
      });
      accept(f);
      f.call.status = "completed";
      f.call.output = {
        threadId: "worker",
        runId: mode === "foreign-run" ? "other" : "worker-second",
        timedOut: mode === "timed-out",
      };
    }
    f.worker.runs[1].status = mode === "still-running" ? "running" : "completed";
    requestOperation(f, "studio_thread_read", { threadId: "worker", view: "messages" });
    assert.throws(() => candidate(f));
  }
});
test("guard diagnostics preserve their static reason while omitting mutated tool input", () => {
  const f = fixture();
  f.call.input.task = "PRIVATE_TOKEN";
  try {
    candidate(f);
    assert.fail("guard should reject");
  } catch (error) {
    const result = sanitizedFailure(error);
    assert.equal(result.reason, "Native approval refused: tool input differs");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  }
});

test("request-before-item waits at most two seconds without reserving a response", () => {
  const f = fixture(),
    approval = f.p.turnItems.pop();
  assert.equal(inspectApprovals(f.scope, f.snapshots, 1000), null);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 2999), null);
  assert.equal(approvalReceipt(f.scope).length, 0);
  f.p.turnItems.push(approval);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 2999).operation, "delegate_task");
  const expired = fixture();
  expired.p.turnItems.pop();
  assert.equal(inspectApprovals(expired.scope, expired.snapshots, 0), null);
  assert.throws(
    () => inspectApprovals(expired.scope, expired.snapshots, 2000),
    /publication deadline/,
  );
});
test("node-before-tool-item and approval-node-before-request hold only their exact linkage", () => {
  const f = fixture(),
    call = f.call,
    approval = f.approval,
    request = f.request;
  f.p.turnItems = [];
  f.p.runtimeRequests = [];
  f.p.nodes = [f.p.nodes[0]];
  assert.equal(inspectApprovals(f.scope, f.snapshots, 0), null);
  assert.throws(() => reserveApproval(f.scope, {}), /unobserved/);
  f.p.turnItems.push(call);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 100), null);
  const approvalNode = {
    ...f.p.nodes[0],
    id: "approval-node",
    kind: "approval_request",
    status: "waiting",
    runtimeRequestId: "request",
  };
  f.p.nodes.push(approvalNode);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 200), null);
  f.p.runtimeRequests.push(request);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 300), null);
  f.p.turnItems.push(approval);
  assert.equal(inspectApprovals(f.scope, f.snapshots, 400).operation, "delegate_task");
  assert.equal(approvalReceipt(f.scope).length, 0);
});
test("partial publication cannot hide foreign data, changed linkage, disappearances or delayed completion", () => {
  for (const alter of [
    (f) => {
      f.p.nodes[1].parentNodeId = "irrelevant";
      f.p.nodes[1].providerTurnId = "foreign";
    },
    (f) => {
      f.p.nodes[1].nativeItemRef.nativeId = "changed";
    },
    (f) => {
      f.p.nodes.pop();
    },
  ]) {
    const f = fixture();
    f.p.turnItems.pop();
    inspectApprovals(f.scope, f.snapshots, 0);
    alter(f);
    assert.throws(() => inspectApprovals(f.scope, f.snapshots, 1));
  }
  const f = fixture(),
    approval = f.p.turnItems.pop();
  inspectApprovals(f.scope, f.snapshots, 0);
  f.p.turnItems.push(approval);
  assert.throws(() => inspectApprovals(f.scope, f.snapshots, 2000), /deadline/);
  const unknown = fixture();
  unknown.p.turnItems.pop();
  unknown.call.toolName = "studio-code.shell";
  assert.throws(() => inspectApprovals(unknown.scope, unknown.snapshots, 0), /unreviewed tool/);
  const foreign = fixture();
  foreign.p.turnItems.pop();
  foreign.request.responseCapability.providerSessionId = "foreign";
  assert.throws(() => inspectApprovals(foreign.scope, foreign.snapshots, 0), /session binding/);
});

test("request and tool IDs cannot be reused across different approved operations", () => {
  const f = continuation();
  requestOperation(f, "studio_thread_send", {
    threadId: "worker",
    message: WORKER_TASK,
    mode: "auto",
    clientRequestId: "followup-intent",
  });
  f.p.runtimeRequests = f.p.runtimeRequests.filter((r) => r.id !== "request");
  f.p.turnItems = f.p.turnItems.filter((i) => i.id !== "approval-item");
  f.request.id = "request";
  f.approval.requestId = "request";
  f.p.nodes.at(-1).runtimeRequestId = "request";
  // Even if a poll missed the resolved state, a granted request identity is globally consumed.
  assert.throws(() => candidate(f), /request identity reused/);
  const reused = continuation();
  requestOperation(reused, "studio_thread_send", {
    threadId: "worker",
    message: WORKER_TASK,
    mode: "auto",
    clientRequestId: "followup-intent",
  });
  reused.call.id = "tool-item";
  assert.throws(() => candidate(reused), /tool identity reused/);
});

test("coordinator-first observation avoids a stale worker across a valid send-result publication", () => {
  function sample(order) {
    const f = continuation();
    requestOperation(f, "studio_thread_send", {
      threadId: "worker",
      message: WORKER_TASK,
      mode: "auto",
      clientRequestId: "followup-intent",
    });
    accept(f); // The send already has its exact single-use grant before observation starts.
    const samples = new Map();
    for (const id of order) {
      samples.set(id, structuredClone(id === coordinatorId ? f.p : f.worker));
      if (samples.size === 1) {
        // Causal provider sequence between the two independent HTTP reads.
        f.worker.runs.push({
          id: "worker-second",
          threadId: "worker",
          userMessageId: "worker-message2",
          status: "running",
          providerInstanceId: "claudeAgent",
          modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
        });
        f.call.status = "completed";
        f.call.output = {
          threadId: "worker",
          messageId: "worker-message2",
          runId: "worker-second",
          status: "running",
          delivery: "started",
        };
        requestOperation(f, "studio_thread_wait", {
          threadId: "worker",
          runId: "worker-second",
          timeoutMs: 120000,
        });
      }
    }
    f.snapshots = samples;
    return f;
  }
  // SQL shell order is updated_at ASC: the retained worker predates the coordinator's next user dispatch.
  const shellOrder = ["worker", coordinatorId];
  const stale = sample(shellOrder);
  assert.throws(() => candidate(stale), /send result run binding/);
  assert.equal(approvalReceipt(stale.scope).length, 2, "stale observations cannot grant the wait");
  const fresh = sample(nativeObservationOrder(shellOrder, coordinatorId));
  assert.equal(
    candidate(fresh),
    null,
    "the earlier coordinator read still shows the already-approved send",
  );
  fresh.snapshots = new Map([
    [coordinatorId, structuredClone(fresh.p)],
    ["worker", structuredClone(fresh.worker)],
  ]);
  assert.equal(candidate(fresh).operation, "studio_thread_wait");
  fresh.approval.prompt = "Allow unrelated work?";
  fresh.snapshots.set(coordinatorId, fresh.p);
  assert.throws(() => candidate(fresh), /approval tool\/prompt\/order/);
  assert.deepEqual(shellOrder, ["worker", coordinatorId], "input ordering is not mutated");
});
test("observation ordering retains every owner and works for the final pre-response refresh", () => {
  assert.deepEqual(nativeObservationOrder(new Set(["worker", coordinatorId]), coordinatorId), [
    coordinatorId,
    "worker",
  ]);
  assert.deepEqual(nativeObservationOrder(["extra", "worker", coordinatorId], coordinatorId), [
    coordinatorId,
    "extra",
    "worker",
  ]);
  assert.deepEqual(nativeObservationOrder(["worker"], coordinatorId), ["worker"]);
});

test("four-run approval policy accepts the reviewed cap and refuses any fifth observed run, turn or attempt", () => {
  for (const key of ["runs", "providerTurns", "attempts"]) {
    const f = fixture(4);
    for (let i = 1; i < 4; i++)
      key === "runs" ? f.scope[key].set(`extra-${i}`, {}) : f.scope[key].add(`extra-${i}`);
    assert.equal(candidate(f).operation, "delegate_task");
    key === "runs" ? f.scope[key].set("fifth", {}) : f.scope[key].add("fifth");
    assert.throws(() => candidate(f), /budget/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  }
  assert.throws(
    () => enableApprovalPolicy(createNativeScope(projectId, true, 4), review(), "followup"),
    /run limit differs/,
  );
});

// Synthetic projection fixtures follow the real mailbox state machine. The separate
// immutable event-prefix fixture still covers the actual original-run cohort failure.
function completedTask({ active = false, queued = false, skippedCohort = false } = {}) {
  const f = fixture(5);
  accept(f);
  f.request.status = "resolved";
  f.request.resolvedAt = "2026-10-09T14:00:00Z";
  f.approval.status = "completed";
  f.call.status = "completed";
  for (const node of f.p.nodes) node.status = "completed";
  f.call.output = {
    taskId: "owned-task",
    childThreadId: "worker",
    childRunId: "worker-first",
    status: "running",
  };
  const worker = {
    thread: {
      id: "worker",
      projectId,
      providerInstanceId: "claudeAgent",
      modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
      runtimeMode: "approval-required",
    },
    runs: [
      {
        id: "worker-first",
        threadId: "worker",
        userMessageId: "worker-message",
        status: "completed",
        providerInstanceId: "claudeAgent",
        modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
      },
    ],
    turnItems: [],
    nodes: [],
    runtimeRequests: [],
    attempts: [{ id: "worker-attempt" }],
    providerTurns: [{ id: "worker-turn" }],
    subagents: [],
  };
  const task = {
    id: "owned-task",
    threadId: coordinatorId,
    runId: f.run.id,
    parentNodeId: f.run.rootNodeId,
    origin: "app_owned",
    childThreadId: "worker",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    model: "claude-test",
    status: "completed",
    completionDelivery: { state: skippedCohort ? "delivered" : "claimed", observedByRunId: null },
  };
  f.p.subagents.push(task);
  f.snapshots.set("worker", worker);
  observeProjection(f.scope, worker);
  f.run.delegatedCompletion = {
    disposition: "open",
    nextGeneration: 2,
    delivery: skippedCohort
      ? null
      : { generation: 1, messageId: "completion-message", taskIds: [task.id] },
  };
  f.original = f.run;
  f.task = task;
  f.worker = worker;
  const message = {
    id: "completion-message",
    threadId: coordinatorId,
    runId: f.run.id,
    nodeId: f.run.rootNodeId,
    role: "user",
    createdBy: "agent",
    creationSource: "server",
    attachments: [],
    text: `Delegated task ${task.id} reached a terminal state. Use task_status with taskId ${task.id} to read the result.`,
    delegatedCompletion: { parentRunId: f.run.id, generation: 1, taskIds: [task.id] },
  };
  f.p.messages = [message];
  f.message = message;
  if (!active) {
    f.run.status = queued ? "waiting" : "completed";
    f.p.attempts[0].status = "completed";
    f.p.providerTurns[0].status = "completed";
    const wake = {
      ...f.run,
      id: "completion-wake",
      ordinal: 2,
      userMessageId: message.id,
      activeAttemptId: "attempt2",
      rootNodeId: "root2",
      status: queued ? "queued" : "running",
    };
    delete wake.delegatedCompletion;
    f.p.runs.push(wake);
    f.run = wake;
    message.runId = wake.id;
    message.nodeId = wake.rootNodeId;
    f.p.attempts.push({
      ...f.p.attempts[0],
      id: "attempt2",
      runId: wake.id,
      rootNodeId: "root2",
      providerTurnId: queued ? null : "turn2",
      status: queued ? "pending" : "running",
    });
    if (!queued)
      f.p.providerTurns.push({
        ...f.p.providerTurns[0],
        id: "turn2",
        runAttemptId: "attempt2",
        nodeId: "root2",
        status: "running",
      });
  }
  observeProjection(f.scope, f.p);
  return f;
}
function requestStatus(f, active = false) {
  requestOperation(f, "task_status", { taskId: f.task.id });
  if (active) {
    for (const item of [f.call, f.approval, ...f.p.nodes.slice(-2)]) item.providerTurnId = "turn";
    for (const node of f.p.nodes.slice(-2)) node.rootNodeId = "root";
    f.request.providerTurnId = "turn";
  }
}
function finishStatus(f) {
  accept(f);
  f.call.status = "completed";
  f.call.output = {
    taskId: f.task.id,
    childThreadId: "worker",
    childRunId: "worker-first",
    status: "completed",
    workState: "result_available",
    hasPendingChildRuns: false,
    providerInstanceId: "claudeAgent",
    model: "claude-test",
    waitTimedOut: false,
    summary: "PROOF synthetic markers",
  };
  f.request.status = "resolved";
  f.request.resolvedAt = "2026-10-09T14:00:00Z";
  f.approval.status = "completed";
  for (const node of f.p.nodes) node.status = "completed";
  f.task.completionDelivery = { state: "acknowledged", observedByRunId: f.run.id };
  f.original.delegatedCompletion.delivery = null;
}
test("owned completion wake binds one exact initial run and task-status result without a second user dispatch", () => {
  const f = completedTask();
  assert.equal(candidate(f), null);
  assert.equal(f.scope.runs.size, 3);
  assert.equal(f.scope.dispatches.size, 1);
  requestStatus(f);
  assert.equal(candidate(f).runId, "completion-wake");
  finishStatus(f);
  assert.deepEqual(completionResultReceipt(f.scope, f.p), {
    parentRunId: "parent-run",
    messageId: "completion-message",
    generation: 1,
    taskId: "owned-task",
    workerThreadId: "worker",
    workerRunId: "worker-first",
    deliveryRunId: "completion-wake",
    wakeRunId: "completion-wake",
    resultReadCallId: "task_status-item",
    resultReadRunId: "completion-wake",
  });
  assert.equal(candidate(f), null);
  assert.equal(approvalReceipt(f.scope).length, 2);
});
test("active same-turn completion reads its result without fabricating a wake", () => {
  const f = completedTask({ active: true });
  requestStatus(f, true);
  finishStatus(f);
  assert.equal(completionResultReceipt(f.scope, f.p).wakeRunId, null);
  assert.equal(completionResultReceipt(f.scope, f.p).deliveryRunId, "parent-run");
  assert.equal(f.scope.runs.size, 2);
  assert.equal(candidate(f), null);
});
test("queued wake while parent app run is settling waits without granting before a provider turn exists", () => {
  const f = completedTask({ queued: true });
  assert.equal(candidate(f), null);
  assert.equal(completionReceipt(f.scope).wakeRunId, "completion-wake");
  assert.equal(approvalReceipt(f.scope).length, 1);
});
test("a poll may first see an already delivered message after the original cohort was cleared", () => {
  const f = completedTask({ skippedCohort: true });
  assert.equal(candidate(f), null);
  requestStatus(f);
  finishStatus(f);
  assert.equal(completionResultReceipt(f.scope, f.p).taskId, "owned-task");
});
const wakeMutations = {
  "unapproved task": (f) => {
    f.call.id = "rebound-call";
  },
  "stopped delivery": (f) => {
    f.original.delegatedCompletion.disposition = "stopped";
    f.original.delegatedCompletion.delivery = null;
    f.task.completionDelivery.state = "delivered";
  },
  "failed child": (f) => {
    f.task.status = "failed";
  },
  "unfinished worker": (f) => {
    f.worker.runs[0].status = "running";
    observeProjection(f.scope, f.worker);
  },
  "wrong task": (f) => {
    f.message.delegatedCompletion.taskIds = ["foreign"];
  },
  "duplicate task": (f) => {
    f.message.delegatedCompletion.taskIds.push("owned-task");
  },
  "extra metadata": (f) => {
    f.message.delegatedCompletion.extra = true;
  },
  "wrong source parent": (f) => {
    f.message.delegatedCompletion.parentRunId = "other";
  },
  "wrong generation": (f) => {
    f.message.delegatedCompletion.generation = 2;
  },
  "advanced generation": (f) => {
    f.original.delegatedCompletion.nextGeneration = 3;
  },
  "changed message id": (f) => {
    f.message.id = "foreign";
  },
  "user-created message": (f) => {
    f.message.createdBy = "user";
  },
  "provider buffered message": (f) => {
    f.message.creationSource = "provider";
  },
  "foreign message owner": (f) => {
    f.message.threadId = "foreign";
  },
  "different message run": (f) => {
    f.message.runId = "foreign";
  },
  "message node": (f) => {
    f.message.nodeId = "foreign";
  },
  "context injection": (f) => {
    f.message.context = {};
  },
  "scheduled wake": (f) => {
    f.message.scheduledTaskId = "other";
  },
  "foreign sender": (f) => {
    f.message.senderThreadId = "other";
  },
  "arbitrary wake text": (f) => {
    f.message.text = "Do extra work";
  },
  attachment: (f) => {
    f.message.attachments = [{ type: "image" }];
  },
  "missing source message": (f) => {
    f.p.messages = [];
  },
  "duplicate source message": (f) => {
    f.p.messages.push({ ...f.message, id: "second" });
  },
  "duplicate wake": (f) => {
    f.p.runs.push({ ...f.run, id: "second-wake" });
  },
  "unrelated run without tools": (f) => {
    f.p.runs.push({ ...f.run, id: "unrelated", userMessageId: "foreign" });
  },
  "wrong wake ordinal": (f) => {
    f.run.ordinal = 3;
  },
  "new provider thread": (f) => {
    f.run.providerThreadId = "other";
  },
  "wrong model": (f) => {
    f.run.modelSelection = { instanceId: "codex", model: "wrong" };
  },
  "wrong provider": (f) => {
    f.run.providerInstanceId = "claudeAgent";
  },
  "live original provider turn": (f) => {
    f.p.providerTurns[0].status = "running";
  },
  "wake cohort": (f) => {
    f.run.delegatedCompletion = {};
  },
  "wake credit": (f) => {
    f.run.manualCodexCreditIntent = {};
  },
  "wake restart": (f) => {
    f.run.restartContinuationOfRunId = f.original.id;
  },
  "retry attempt": (f) => {
    f.p.attempts[1].reason = "retry";
  },
  "second attempt": (f) => {
    f.p.attempts[1].attemptOrdinal = 2;
  },
  "ambiguous attempts": (f) => {
    f.p.attempts.push({ ...f.p.attempts[1], id: "extra" });
  },
  "wrong active attempt": (f) => {
    f.run.activeAttemptId = "other";
  },
  "attempt root": (f) => {
    f.p.attempts[1].rootNodeId = "other";
  },
  "attempt provider thread": (f) => {
    f.p.attempts[1].providerThreadId = "other";
  },
  "attempt provider turn": (f) => {
    f.p.attempts[1].providerTurnId = "other";
  },
  "provider turn root": (f) => {
    f.p.providerTurns[1].nodeId = "other";
  },
  "duplicate provider turns": (f) => {
    f.p.providerTurns.push({ ...f.p.providerTurns[1], id: "other" });
  },
  "provider session changed": (f) => {
    f.p.providerThreads[0].providerSessionId = "other";
    f.p.providerSessions[0].id = "other";
  },
  "provider session model": (f) => {
    f.p.providerSessions[0].model = "other";
  },
  "unaccepted skipped cohort": (f) => {
    f.original.delegatedCompletion.delivery = null;
  },
};
for (const [name, mutate] of Object.entries(wakeMutations))
  test(`completion wake rejects ${name} before any response`, () => {
    const f = completedTask();
    mutate(f);
    assert.throws(() => candidate(f), /Native approval refused/);
    assert.equal(approvalReceipt(f.scope).length, 1);
  });
test("completion wake pin rejects later identity changes even without another tool call", () => {
  const f = completedTask();
  candidate(f);
  f.run.rootNodeId = "rebound";
  f.p.attempts[1].rootNodeId = "rebound";
  f.p.providerTurns[1].nodeId = "rebound";
  f.message.nodeId = "rebound";
  assert.throws(() => candidate(f), /wake identity changed/);
});
test("task_status refuses foreign inputs, extra fields, duplicate calls and permanent approvals", () => {
  for (const patch of [{ taskId: "foreign" }, { extra: true }]) {
    const f = completedTask();
    requestStatus(f);
    Object.assign(f.call.input, patch);
    assert.throws(() => candidate(f), /tool input differs/);
  }
  const f = completedTask();
  requestStatus(f);
  finishStatus(f);
  f.p.turnItems.push({ ...f.call, id: "another-status" });
  assert.throws(() => candidate(f), /extra or changed tool call/);
  const g = completedTask();
  requestStatus(g);
  const command = reserveApproval(g.scope, candidate(g));
  assert.throws(() =>
    assertNativeRpc(
      NATIVE_ORIGIN,
      "orchestration.dispatchCommand",
      { ...command, decision: "acceptAlways" },
      g.scope,
    ),
  );
});
test("completion result proof rejects wrong or incomplete task-status results", () => {
  const patches = [
    { taskId: "foreign" },
    { childThreadId: "foreign" },
    { childRunId: "foreign" },
    { status: "running" },
    { workState: "working" },
    { hasPendingChildRuns: true },
    { providerInstanceId: "codex" },
    { model: "other" },
    { waitTimedOut: true },
    { summary: "" },
  ];
  for (const patch of patches) {
    const f = completedTask();
    requestStatus(f);
    finishStatus(f);
    Object.assign(f.call.output, patch);
    assert.throws(() => completionResultReceipt(f.scope, f.p), /output binding/);
  }
});
test("five-run ceiling accepts the owned wake plus controlled continuation and refuses a sixth run", () => {
  const f = completedTask();
  requestStatus(f);
  finishStatus(f);
  f.run.status = "completed";
  f.p.attempts[1].status = "completed";
  f.p.providerTurns[1].status = "completed";
  armSelectedWorker(f.scope, f.worker, f.p);
  assertNativeRpc(
    NATIVE_ORIGIN,
    "projects.coordinatorSend",
    { projectId, commandId: "send", prompt: "Synthetic second cycle", sourceThreadId: "worker" },
    f.scope,
  );
  f.run = {
    ...f.run,
    id: "parent-followup",
    ordinal: 3,
    userMessageId: `coordinator-send:${projectId}:send`,
    status: "running",
    activeAttemptId: "attempt3",
    rootNodeId: "root3",
  };
  f.p.runs.push(f.run);
  f.p.attempts.push({
    ...f.p.attempts[1],
    id: "attempt3",
    runId: f.run.id,
    rootNodeId: "root3",
    providerTurnId: "turn3",
    status: "running",
  });
  f.p.providerTurns.push({
    ...f.p.providerTurns[1],
    id: "turn3",
    runAttemptId: "attempt3",
    nodeId: "root3",
    status: "running",
  });
  function op(name, input) {
    requestOperation(f, name, input);
    for (const item of [f.call, f.approval, ...f.p.nodes.slice(-2)]) item.providerTurnId = "turn3";
    for (const node of f.p.nodes.slice(-2)) node.rootNodeId = "root3";
    f.request.providerTurnId = "turn3";
  }
  op("studio_thread_send", {
    threadId: "worker",
    message: WORKER_TASK,
    mode: "auto",
    clientRequestId: "followup-intent",
  });
  accept(f);
  f.call.status = "completed";
  f.call.output = {
    threadId: "worker",
    messageId: "worker-message2",
    runId: "worker-second",
    status: "running",
    delivery: "started",
  };
  f.worker.runs.push({
    ...f.worker.runs[0],
    id: "worker-second",
    userMessageId: "worker-message2",
    status: "running",
  });
  observeProjection(f.scope, f.worker);
  op("studio_thread_wait", { threadId: "worker", runId: "worker-second", timeoutMs: 120000 });
  accept(f);
  f.call.status = "completed";
  f.call.output = { threadId: "worker", runId: "worker-second", timedOut: false };
  f.worker.runs[1].status = "completed";
  observeProjection(f.scope, f.worker);
  op("studio_thread_read", { threadId: "worker", view: "messages" });
  accept(f);
  assert.equal(f.scope.runs.size, 5);
  assert.deepEqual(
    approvalReceipt(f.scope).map((a) => a.operation),
    APPROVAL_PLAN.operations,
  );
  assert.equal(candidate(f), null);
  f.p.runs.push({ ...f.run, id: "sixth" });
  assert.throws(() => observeProjection(f.scope, f.p), /run ceiling/);
  assert.equal(f.scope.runs.size, 6);
});

test("five-run ceiling independently retains and rejects a sixth attempt or provider turn", () => {
  for (const field of ["providerTurns", "attempts"]) {
    const f = fixture(5);
    for (let i = 0; i < 5; i++) f.scope[field].add(`extra-${i}`);
    assert.equal(f.scope[field].size, 6);
    assert.throws(() => candidate(f), /budget/);
    assert.equal(approvalReceipt(f.scope).length, 0);
  }
});
test("completion wake cannot silently replace its first observed provider turn", () => {
  const f = completedTask();
  candidate(f);
  f.p.providerTurns[1].id = "replacement";
  f.p.attempts[1].providerTurnId = "replacement";
  assert.throws(() => candidate(f), /turn identity changed/);
});

test("result output alone cannot replace the exact persisted task acknowledgment", () => {
  for (const patch of [
    { state: "delivered", observedByRunId: null },
    { state: "acknowledged", observedByRunId: "foreign" },
  ]) {
    const f = completedTask();
    requestStatus(f);
    finishStatus(f);
    f.task.completionDelivery = patch;
    assert.throws(() => completionResultReceipt(f.scope, f.p), /not acknowledged/);
  }
});

// The HTTP projection deliberately compacts tool output; only the owned stored item is complete.
const { hydrateApprovedToolOutputs, readOwnedToolItem, canonicalNativeToolOutput } =
  await import("./native-tool-detail.mjs");
function compactCompleted(f, item = f.call) {
  f.detailRows ??= new Map();
  // The real HTTP response compacts every completed item, including earlier calls.
  for (const current of f.p.turnItems.filter(
    (i) => i.type === "dynamic_tool" && i.status === "completed" && i.outputOmitted !== true,
  )) {
    current.createdAt = "2026-10-09T18:00:00.000Z";
    current.updatedAt = "2026-10-09T18:00:01.000Z";
    const raw = structuredClone({ ...current, threadId: f.p.thread.id });
    current.output = canonicalNativeToolOutput(raw.output);
    current.outputOmitted = true;
    f.detailRows.set(current.id, {
      projectId: f.scope.projectId,
      threadId: f.p.thread.id,
      item: raw,
    });
  }
  return f.detailRows.get(item.id);
}
function hydrate(f, row, now) {
  const result = hydrateApprovedToolOutputs(
    f.scope,
    f.p,
    (project, thread, item) => {
      assert.equal(project, f.scope.projectId);
      assert.equal(thread, row.threadId);
      const selected = item === row.item.id ? row : f.detailRows.get(item);
      assert(selected);
      return selected;
    },
    now,
  );
  if (result.ready) {
    f.p = result.projection;
    f.snapshots.set(f.p.thread.id, f.p);
  }
  return result;
}
test("wire-only delegate output reproduces failure, then exact stored detail restores original completion guard", () => {
  const f = completedTask(),
    row = compactCompleted(f);
  assert.deepEqual(f.call.output, { taskId: "owned-task" });
  assert.throws(() => candidate(f), /completion task binding/);
  assert.equal(hydrate(f, row).ready, true);
  assert.equal(candidate(f), null);
  assert.equal(approvalReceipt(f.scope).length, 1);
});
test("wire-only task_status detail restores exact terminal result assertions", () => {
  const f = completedTask();
  requestStatus(f);
  finishStatus(f);
  const row = compactCompleted(f);
  assert.throws(() => completionResultReceipt(f.scope, f.p), /completion result output binding/);
  hydrate(f, row);
  assert.equal(completionResultReceipt(f.scope, f.p).taskId, "owned-task");
  assert.equal(approvalReceipt(f.scope).length, 2);
});
test("wire-only send detail restores returned run binding for the exact subsequent wait", () => {
  const f = continuation();
  sendComplete(f);
  const row = compactCompleted(f);
  requestOperation(f, "studio_thread_wait", {
    threadId: "worker",
    runId: "worker-second",
    timeoutMs: 120000,
  });
  assert.throws(() => candidate(f), /send result shape/);
  hydrate(f, row);
  assert.equal(candidate(f).operation, "studio_thread_wait");
  assert.equal(approvalReceipt(f.scope).length, 2);
});
for (const operation of ["studio_thread_wait", "studio_thread_read"])
  test(`wire-only ${operation} detail retains its approved output without creating a grant`, () => {
    const f = continuation();
    sendComplete(f);
    requestOperation(f, "studio_thread_wait", {
      threadId: "worker",
      runId: "worker-second",
      timeoutMs: 120000,
    });
    accept(f);
    f.call.status = "completed";
    f.call.output = { threadId: "worker", runId: "worker-second", status: "idle", timedOut: false };
    f.worker.runs[1].status = "completed";
    if (operation === "studio_thread_read") {
      requestOperation(f, operation, { threadId: "worker", view: "messages" });
      accept(f);
      f.call.status = "completed";
      f.call.output = {
        thread: { threadId: "worker" },
        recentRuns: [],
        items: [{ role: "assistant", text: "Synthetic result" }],
        nextPosition: null,
        hasMore: false,
      };
    }
    const count = approvalReceipt(f.scope).length,
      row = compactCompleted(f);
    hydrate(f, row);
    assert.deepEqual(f.p.turnItems.find((i) => i.id === row.item.id).output, row.item.output);
    assert.equal(approvalReceipt(f.scope).length, count);
  });
const detailMutations = {
  "foreign project": (f, row) => {
    row.projectId = "foreign";
  },
  "foreign stored thread": (f, row) => {
    row.item.threadId = "foreign";
  },
  "rebound item": (f, row) => {
    row.item.id = "foreign";
  },
  "rebound run": (f, row) => {
    row.item.runId = "foreign";
  },
  "changed node": (f, row) => {
    row.item.nodeId = "foreign";
  },
  "changed provider turn": (f, row) => {
    row.item.providerTurnId = "foreign";
  },
  "changed provider thread": (f, row) => {
    row.item.providerThreadId = "foreign";
  },
  "changed input": (f, row) => {
    row.item.input.task = "PRIVATE_CHANGED_INPUT";
  },
  "changed status": (f, row) => {
    row.item.status = "running";
  },
  "changed ordinal": (f, row) => {
    row.item.ordinal += 1;
  },
  "changed created timestamp": (f, row) => {
    row.item.createdAt = "2026-10-10T00:00:00Z";
  },
  "missing revision": (f, row) => {
    delete row.item.updatedAt;
  },
  "missing full output": (f, row) => {
    delete row.item.output;
  },
  "still omitted output": (f, row) => {
    row.item.outputOmitted = true;
  },
  "conflicting present field": (f, row) => {
    row.item.output.taskId = "foreign";
  },
  "missing present field": (f, row) => {
    delete row.item.output.taskId;
  },
  "unapproved call": (f) => {
    f.call.id = "unapproved";
  },
  "foreign wire thread": (f) => {
    f.call.threadId = "foreign";
  },
  "changed wire input": (f) => {
    f.call.input.task = "PRIVATE_CHANGED_INPUT";
  },
  "changed attempt": (f) => {
    f.p.attempts[0].id = "foreign";
  },
  "changed session": (f) => {
    f.p.providerSessions[0].id = "foreign";
  },
};
for (const [name, mutate] of Object.entries(detailMutations))
  test(`stored detail rejects ${name} without another grant`, () => {
    const f = completedTask(),
      row = compactCompleted(f);
    mutate(f, row);
    assert.throws(
      () => hydrateApprovedToolOutputs(f.scope, f.p, () => row),
      /Native tool detail refused/,
    );
    assert.equal(approvalReceipt(f.scope).length, 1);
  });
test("newer or older stored revision with stable identity withholds detail until a coherent observation", () => {
  for (const stamp of ["2026-10-09T18:00:00.500Z", "2026-10-09T18:00:02.000Z"]) {
    const f = completedTask(),
      row = compactCompleted(f);
    row.item.updatedAt = stamp;
    assert.equal(hydrate(f, row, 100).ready, false);
    assert.equal(f.call.output.childThreadId, undefined);
    f.call.updatedAt = stamp;
    assert.equal(hydrate(f, row, 150).ready, true);
    assert.equal(candidate(f), null);
  }
});
test("unresolved detail revision times out; an identity conflict never waits", () => {
  const f = completedTask(),
    row = compactCompleted(f);
  row.item.updatedAt = "2026-10-09T18:00:02.000Z";
  assert.equal(hydrate(f, row, 100).ready, false);
  assert.throws(() => hydrate(f, row, 2101), /publication changed or timed out/);
  const other = completedTask(),
    conflict = compactCompleted(other);
  conflict.item.updatedAt = row.item.updatedAt;
  conflict.item.output.taskId = "foreign";
  assert.throws(() => hydrate(other, conflict, 100), /canonical wire output conflicts/);
});
test("missing stored row refuses; noncompleted wire item never triggers a stored read", () => {
  const f = completedTask();
  compactCompleted(f);
  assert.throws(() => hydrateApprovedToolOutputs(f.scope, f.p, () => null), /stored item owner/);
  f.call.status = "running";
  let reads = 0;
  hydrateApprovedToolOutputs(f.scope, f.p, () => {
    reads++;
  });
  assert.equal(reads, 0);
});
test("owned raw lookup binds project, thread and item in one SQLite statement", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, deleted_at TEXT); CREATE TABLE orchestration_v2_projection_turn_items(turn_item_id TEXT, thread_id TEXT, payload_json TEXT)",
    );
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES(?,?,NULL)").run("t", "p");
    db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?)").run(
      "i",
      "t",
      JSON.stringify({ id: "i", threadId: "t" }),
    );
    assert.equal(readOwnedToolItem(db, "p", "t", "i").item.id, "i");
    for (const args of [
      ["foreign", "t", "i"],
      ["p", "foreign", "i"],
      ["p", "t", "foreign"],
    ])
      assert.throws(() => readOwnedToolItem(db, ...args), /stored item missing/);
    db.prepare("UPDATE orchestration_v2_projection_threads SET deleted_at=?").run("deleted");
    assert.throws(() => readOwnedToolItem(db, "p", "t", "i"), /stored item missing/);
  } finally {
    db.close();
  }
});
test("completed capability discovery stays compact and passes through without any stored read", () => {
  const f = fixture();
  f.call.toolName = "studio-code.orchestrator_capabilities";
  f.call.input = {};
  f.call.status = "completed";
  f.call.outputOmitted = true;
  f.call.output = {};
  // No discovery approval exists. Hydration must leave the original guard's discovery policy intact.
  let reads = 0;
  const result = hydrateApprovedToolOutputs(f.scope, f.p, () => {
    reads++;
  });
  assert.equal(reads, 0);
  assert.strictEqual(result.projection.turnItems[0], f.call);
});

for (const [name, mutate] of Object.entries({
  removed: (f) => {
    f.p.turnItems = f.p.turnItems.filter((i) => i.id !== f.call.id);
  },
  running: (f) => {
    f.call.status = "running";
  },
  unmarked: (f) => {
    f.call.outputOmitted = false;
  },
}))
  test(`pending exact tool detail rejects ${name} publication`, () => {
    const f = completedTask(),
      row = compactCompleted(f);
    row.item.updatedAt = "2026-10-09T18:00:02.000Z";
    assert.equal(hydrateApprovedToolOutputs(f.scope, f.p, () => row, 0).ready, false);
    mutate(f);
    assert.throws(
      () => hydrateApprovedToolOutputs(f.scope, f.p, () => row, 1),
      /detail publication disappeared|detail publication reverted/,
    );
  });

function promptlessWait() {
  const f = continuation();
  sendComplete(f);
  f.request.status = "resolved";
  f.request.resolvedAt = "2026-10-09T12:00:00Z";
  f.approval.status = "completed";
  for (const n of f.p.nodes) n.status = "completed";
  f.worker.runs[1].status = "completed";
  observeProjection(f.scope, f.worker);
  const owner = { runId: f.run.id, providerThreadId: "provider-thread", providerTurnId: "turn2" };
  f.call = {
    ...owner,
    id: "promptless-wait",
    nodeId: "promptless-wait-node",
    type: "dynamic_tool",
    toolName: "studio-code.studio_thread_wait",
    input: { threadId: "worker", runId: "worker-second", timeoutMs: 120000 },
    status: "completed",
    ordinal: f.p.turnItems.length + 1,
    output: { threadId: "worker", runId: "worker-second", status: "completed", timedOut: false },
  };
  f.p.turnItems.push(f.call);
  f.p.nodes.push({
    ...owner,
    id: f.call.nodeId,
    threadId: coordinatorId,
    rootNodeId: "root2",
    kind: "tool_call",
    status: "completed",
  });
  observeProjection(f.scope, f.p);
  return f;
}
test("readonly wait restores exact stored output without manufacturing a grant; read still uses its actual contract and approval", () => {
  const f = promptlessWait(),
    row = compactCompleted(f);
  hydrate(f, row);
  assert.equal(candidate(f), null);
  assert.deepEqual(
    approvalReceipt(f.scope).map((g) => g.operation),
    ["delegate_task", "studio_thread_send"],
  );
  requestOperation(f, "studio_thread_read", { threadId: "worker", view: "messages" });
  accept(f);
  f.call.status = "completed";
  f.call.output = {
    thread: { ...structuredClone(f.worker.thread), threadId: f.worker.thread.id },
    recentRuns: structuredClone(f.worker.runs),
    items: [],
    nextPosition: null,
    hasMore: false,
  };
  const read = compactCompleted(f);
  hydrate(f, read);
  assert.deepEqual(f.p.turnItems.find((i) => i.id === read.item.id).output, read.item.output);
  assert.equal(approvalReceipt(f.scope).length, 3);
});
test("read without a submitted grant remains refused after the exact promptless wait", () => {
  const f = promptlessWait();
  requestOperation(f, "studio_thread_read", { threadId: "worker", view: "messages" });
  f.call.status = "completed";
  f.call.output = {
    thread: { ...f.worker.thread, threadId: f.worker.thread.id },
    recentRuns: [],
    items: [],
    nextPosition: null,
    hasMore: false,
  };
  const row = compactCompleted(f);
  assert.throws(() => hydrate(f, row), /submitted grant missing/);
});
const promptlessMutations = {
  "wrong worker": (f) => {
    f.call.input.threadId = "foreign";
  },
  "wrong worker run": (f) => {
    f.call.input.runId = "worker-first";
  },
  "extra input": (f) => {
    f.call.input.extra = true;
  },
  "wrong timeout": (f) => {
    f.call.input.timeoutMs = 1;
  },
  "missing authorized send": (f) => {
    f.p.turnItems = f.p.turnItems.filter((i) => i.toolName !== "studio-code.studio_thread_send");
  },
  "wrong send result": (f) => {
    f.p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_send").output.runId =
      "worker-first";
  },
  "different turn": (f) => {
    f.call.providerTurnId = "foreign";
  },
  "different session": (f) => {
    f.p.providerSessions[0].id = "foreign";
  },
  "model fallback": (f) => {
    f.worker.runs[1].modelSelection.model = "other";
    observeProjection(f.scope, f.worker);
  },
  "duplicate wait": (f) => {
    f.p.turnItems.push({ ...f.call, id: "duplicate" });
  },
  "unanswered wait approval": (f) => {
    f.p.turnItems.push({
      type: "approval_request",
      runId: f.run.id,
      prompt: 'Allow the studio-code MCP server to run tool "studio_thread_wait"?',
    });
  },
  "foreign root": (f) => {
    f.p.nodes.at(-1).rootNodeId = "foreign";
  },
};
for (const [name, mutate] of Object.entries(promptlessMutations))
  test(`promptless wait refuses ${name}`, () => {
    const f = promptlessWait();
    mutate(f);
    const row = compactCompleted(f);
    assert.throws(() => hydrate(f, row), /Native (approval|tool detail) refused/);
    assert.equal(approvalReceipt(f.scope).length, 2);
  });
test("send-first hydration retains reversed timeline order and withholds wait until exact send revision agrees", () => {
  const f = promptlessWait(),
    send = f.p.turnItems.find((i) => i.toolName === "studio-code.studio_thread_send");
  const sendRow = compactCompleted(f, send),
    waitRow = compactCompleted(f);
  f.p.turnItems.reverse();
  const order = f.p.turnItems.map((i) => i.id),
    reads = [];
  sendRow.item.updatedAt = "2026-10-09T18:00:02.000Z";
  const read = (projectId, threadId, itemId) => {
    reads.push(itemId);
    return f.detailRows.get(itemId);
  };
  const earlier = f.p.turnItems
    .filter(
      (i) =>
        i.type === "dynamic_tool" &&
        i.status === "completed" &&
        i.id !== send.id &&
        i.id !== f.call.id,
    )
    .map((i) => i.id);
  const pending = hydrateApprovedToolOutputs(f.scope, f.p, read, 0);
  assert.equal(pending.ready, false);
  assert.deepEqual(reads, [send.id, ...earlier]);
  assert.equal(pending.projection.turnItems[0].output.runId, undefined);
  send.updatedAt = sendRow.item.updatedAt;
  reads.length = 0;
  const ready = hydrateApprovedToolOutputs(f.scope, f.p, read, 1);
  assert.equal(ready.ready, true);
  assert.deepEqual(
    ready.projection.turnItems.map((i) => i.id),
    order,
  );
  assert.deepEqual(reads, [send.id, ...earlier, f.call.id]);
  assert.equal(approvalReceipt(f.scope).length, 2);
});
