import * as NodeAssert from "node:assert/strict";

const assert = NodeAssert;
const PROJECT_METHODS = new Set([
  "projects.workspaceRead",
  "projects.environmentRead",
  "projects.environmentPrepare",
  "projects.connectionsRead",
  "projects.connectionSave",
  "projects.connectionCheck",
  "projects.connectionRevoke",
  "projects.planRead",
  "projects.planAuthorityRead",
  "projects.planReplace",
  "projects.planConfigure",
  "projects.memoryRead",
  "projects.memoryWrite",
  "projects.memoryDelete",
  "projects.usageRead",
  "projects.coordinatorStart",
  "projects.coordinatorSend",
]);
const ROUTINE_METHODS = new Set([
  "scheduledTasks.upsert",
  "scheduledTasks.runNow",
  "scheduledTasks.delete",
]);
const ERROR_CODES = new Set([
  "not_found",
  "denied",
  "changed",
  "outcome_unknown",
  "source_invalid",
  "source_unavailable",
  "conflict",
  "invalid",
  "paused",
  "archived",
  "model_required",
  "busy",
  "operation_failed",
  "project_not_found",
  "read_failed",
  "run_outcome_unknown",
  "run_command_conflict",
]);
// Return only typed, non-content error labels. Provider errors/messages and causes
// may contain private prompts or credentials; never serialize them into evidence.
export function safeFailure(value) {
  if (!value || typeof value !== "object") return null;
  if (ERROR_CODES.has(value.code)) return value.code;
  if (ERROR_CODES.has(value.reason)) return value.reason;
  if (
    typeof value._tag === "string" &&
    ["ScheduledTaskError", "EnvironmentAuthorizationError", "ProjectMutationError"].includes(
      value._tag,
    )
  )
    return value._tag;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const found = safeFailure(nested);
      if (found) return found;
    }
  }
  return null;
}
export function assertRpcScope(origin, tag, payload, scope) {
  assert.equal(origin, "http://127.0.0.1:8428", "Only the owned acceptance port is allowed");
  assert.ok(
    PROJECT_METHODS.has(tag) ||
      ROUTINE_METHODS.has(tag) ||
      [
        "projects.createNew",
        "server.getConfig",
        "server.getSettings",
        "scheduledTasks.list",
        "orchestration.dispatchCommand",
      ].includes(tag),
    "RPC method outside acceptance allowlist",
  );
  if (tag === "projects.createNew") {
    assert.equal(payload.name, "Acceptance Personal");
    assert.equal(payload.kind, "personal");
    assert.equal(scope.providersDisabled, true);
  }
  if (tag === "projects.environmentPrepare") assert.equal(payload.mode, "match");
  if (tag === "projects.connectionSave") {
    assert.ok(typeof scope.connectionCommand === "string" && scope.connectionCommand.length > 0);
    assert.ok(Array.isArray(scope.connectionArgs) && scope.connectionArgs.length > 0);
    assert.equal(payload.config.command, scope.connectionCommand);
    assert.deepEqual(payload.config.args, scope.connectionArgs);
    assert.deepEqual(payload.config.envKeys, []);
    assert.equal(payload.id, "owned-tools");
  }
  if (tag === "projects.connectionCheck" || tag === "projects.connectionRevoke")
    assert.equal(payload.id, "owned-tools");
  if (PROJECT_METHODS.has(tag) || tag === "scheduledTasks.upsert")
    assert.ok(scope.projectIds.has(payload.projectId), "Foreign project mutation/read refused");
  if (ROUTINE_METHODS.has(tag))
    assert.ok(scope.routineIds.has(payload.id), "Foreign routine mutation refused");
  if (tag === "orchestration.dispatchCommand") {
    assert.equal(payload.type, "thread.create", "Only inert synthetic thread creation is allowed");
    assert.ok(scope.projectIds.has(payload.projectId));
    assert.equal(scope.providersDisabled, true);
    assert.equal(payload.importedNativeThread, undefined);
    assert.equal(payload.branch, null);
    assert.equal(payload.worktreePath, null);
  }
  if (payload.sourceThreadId)
    assert.ok(scope.threadIds.has(payload.sourceThreadId), "Foreign source thread refused");
  if (tag === "projects.coordinatorSend")
    for (const attachment of payload.attachments ?? [])
      assert.ok(scope.attachmentIds?.has(attachment.id), "Unowned attachment refused");
  if (payload.threadId)
    assert.ok(scope.threadIds.has(payload.threadId), "Foreign thread destination refused");
  if (
    tag === "projects.coordinatorStart" ||
    tag === "projects.coordinatorSend" ||
    tag === "scheduledTasks.runNow"
  )
    assert.equal(scope.providersDisabled, true, "Admission checks may not execute providers");
}
export async function rpc(context, origin, tag, payload = {}, scope) {
  assertRpcScope(origin, tag, payload, scope);
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", {
    headers: { Origin: origin },
  });
  assert.equal(response.status(), 200, "Ticket exchange failed");
  const { ticket } = await response.json();
  assert.equal(typeof ticket, "string");
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("RPC timeout; private transport output omitted")),
      20000,
    );
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("error", () => finish(reject, new Error("RPC transport failed")));
    ws.addEventListener("close", () => {
      if (!settled) finish(reject, new Error("RPC closed before result"));
    });
    ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        if (item.exit?._tag === "Success") finish(resolve, { ok: true, value: item.exit.value });
        else finish(resolve, { ok: false, code: safeFailure(item.exit) ?? "unknown_rpc_failure" });
      }
    });
  });
}
export async function requiredRpc(...args) {
  const result = await rpc(...args);
  assert.equal(result.ok, true, `RPC failed: ${result.code ?? "unknown"}`);
  return result.value;
}
