import assert from "node:assert/strict";
import { safeFailure } from "./rpc.mjs";
import { hasApprovalPolicy, consumeApprovalCommand } from "./native-approval.mjs";

export const NATIVE_ORIGIN = "http://127.0.0.1:8431";
export const MAX_NATIVE_RUNS = 6;
export const ACTIVE_RUNS = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const READS = new Set(["server.getConfig", "projects.workspaceRead", "projects.memoryRead", "projects.usageRead"]);
const WRITES = new Set(["projects.memoryWrite", "projects.coordinatorStart", "projects.coordinatorSend"]);

// This fence is independent of provider prompts. It permits only one fresh project,
// two explicit user dispatches, and exact observed-run interrupts. Autonomous runs
// are observed by the monitor; excess is a failed receipt, never silently omitted.
export function createNativeScope(projectId, execute = false, maxRuns = MAX_NATIVE_RUNS) {
  assert.ok([4, 5, 6].includes(maxRuns), "Native run limit must be exactly 4, 5 or 6");
  return Object.defineProperty({ projectId, execute, threadIds: new Set(), runs: new Map(), providerTurns: new Set(), attempts: new Set(), dispatches: new Map() },
    'maxRuns', { value: maxRuns, enumerable: true });
}
export function userDispatchReceipt(scope) {
  return [...scope.dispatches.values()].map(value => {
    const { tag, payload } = JSON.parse(value);
    return { tag, commandId: payload.commandId, projectId: payload.projectId, sourceThreadId: payload.sourceThreadId ?? null };
  });
}
export function observeProjection(scope, projection) {
  assert.equal(projection.thread.projectId, scope.projectId, "Foreign project refused");
  const threadId = projection.thread.id;
  scope.threadIds.add(threadId);
  for (const run of projection.runs) {
    const prior = scope.runs.get(run.id);
    assert.ok(!prior || prior.threadId === threadId, "Run changed owner");
    scope.runs.set(run.id, { id: run.id, threadId, status: run.status, providerInstanceId: run.providerInstanceId, model: run.modelSelection?.model });
  }
  for (const turn of projection.providerTurns ?? []) scope.providerTurns.add(turn.id);
  for (const attempt of projection.attempts ?? []) scope.attempts.add(attempt.id);
  assert.ok(scope.providerTurns.size <= scope.maxRuns && scope.attempts.size <= scope.maxRuns, "Native attempt/turn ceiling exceeded");
  assert.ok(scope.runs.size <= scope.maxRuns, "Native run ceiling exceeded");
  assert.ok(scope.threadIds.size <= 2, "Unexpected extra worker");
  assert.ok(hasApprovalPolicy(scope) || !projection.runtimeRequests.some((r) => r.status === "pending"), "Native permission request; approval withheld");
  assert.ok(!projection.subagents.some((s) => s.origin !== "app_owned" || !s.childThreadId), "Unbudgeted native subagent");
}
export function assertNativeRpc(origin, tag, payload, scope) {
  assert.equal(origin, NATIVE_ORIGIN, "Only owned native port8431 is allowed");
  assert.ok(READS.has(tag) || WRITES.has(tag) || tag === "orchestration.dispatchCommand", "Native RPC method refused");
  const allowedKeys = {
    "server.getConfig": [],
    "projects.workspaceRead": ["projectId"],
    "projects.memoryRead": ["projectId", "name"],
    "projects.usageRead": ["projectId"],
    "projects.memoryWrite": ["projectId", "name", "content", "expectedRevision"],
    "projects.coordinatorStart": ["projectId", "commandId", "prompt"],
    "projects.coordinatorSend": ["projectId", "commandId", "prompt", "sourceThreadId"],
    "orchestration.dispatchCommand": payload.type === "runtime-request.respond"
      ? ["type", "commandId", "threadId", "requestId", "decision"] : ["type", "commandId", "threadId", "runId"],
  };
  assert.ok(Object.keys(payload).every((key) => allowedKeys[tag].includes(key)), "Unreviewed RPC field refused");
  if (tag !== "server.getConfig" && tag !== "orchestration.dispatchCommand")
    assert.equal(payload.projectId, scope.projectId, "Foreign project refused");
  if (payload.sourceThreadId !== undefined)
    assert.ok(scope.threadIds.has(payload.sourceThreadId), "Foreign worker hint refused");
  if (tag === "projects.coordinatorStart" || tag === "projects.coordinatorSend") {
    assert.equal(scope.execute, true, "Native execution requires reviewed authorization");
    assert.equal(typeof payload.prompt, "string");
    assert.ok(payload.prompt.length > 0 && payload.prompt.length <= 8000);
    assert.equal(typeof payload.commandId, "string");
    const serialized = JSON.stringify({ tag, payload });
    const prior = scope.dispatches.get(payload.commandId);
    assert.ok(prior === undefined || prior === serialized, "Dispatch ID reused with changed intent");
    if (prior === undefined) {
      assert.ok(scope.dispatches.size < 2, "Only two native user dispatches are allowed");
      assert.ok(scope.runs.size < scope.maxRuns, "Native run budget exhausted");
      scope.dispatches.set(payload.commandId, serialized);
    }
  }
  if (tag === "orchestration.dispatchCommand") {
    if (payload.type === "runtime-request.respond") {
      assert.equal(scope.execute, true, "Native execution requires reviewed authorization");
      consumeApprovalCommand(scope, payload);
      return;
    }
    assert.equal(payload.type, "run.interrupt", "Only exact observed-run interrupt is allowed");
    assert.ok(scope.threadIds.has(payload.threadId), "Foreign thread refused");
    const run = scope.runs.get(payload.runId);
    assert.ok(run && run.threadId === payload.threadId, "Unobserved or foreign run refused");
  }
}
export async function nativeRpc(context, origin, tag, payload = {}, scope) {
  assertNativeRpc(origin, tag, payload, scope);
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", { headers: { Origin: origin } });
  assert.equal(response.status(), 200, "Ticket exchange failed");
  const { ticket } = await response.json();
  assert.equal(typeof ticket, "string");
  const url = new URL(origin);
  url.protocol = "ws:"; url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket); url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); ws.close(); fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Private native RPC timeout")), 20000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })));
    ws.addEventListener("error", () => finish(reject, new Error("Private native transport failure")));
    ws.addEventListener("close", () => { if (!settled) finish(reject, new Error("Private native transport closed")); });
    ws.addEventListener("message", (event) => {
      let decoded;
      try { decoded = JSON.parse(event.data); } catch { return; }
      for (const item of Array.isArray(decoded) ? decoded : [decoded]) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        if (item.exit?._tag === "Success") finish(resolve, item.exit.value);
        else finish(reject, new Error(`Native RPC denied: ${safeFailure(item.exit) ?? "unknown"}`));
      }
    });
  });
}
