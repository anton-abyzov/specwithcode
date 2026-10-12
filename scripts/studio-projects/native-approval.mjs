// Test-harness policy, never a product permission default. No transport or provider I/O.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const WORKER_TASK =
  "Without using any tools, report the goal marker and current memory marker from the injected project context. Reply only PROOF followed by the two marker values. Do not delegate, edit, or send any messages.";
export const APPROVAL_PLAN = Object.freeze({
  schemaVersion: 2,
  decision: "accept",
  maxResponses: 5,
  operations: Object.freeze([
    "delegate_task",
    "task_status",
    "studio_thread_send",
    "studio_thread_wait",
    "studio_thread_read",
  ]),
  eachOperation: "at-most-once",
  binding: "owned-project-dispatch-run-attempt-turn-session-exact-input-and-completion-lineage",
  retry: false,
  persistentGrants: false,
});
export const APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "acceptAlways", label: "Always allow" },
  { decision: "accept", label: "Approve" },
];
const policies = new WeakMap();
const failures = new WeakMap();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inflight = (value) => ["running", "waiting"].includes(value?.status);
function guard(condition, reason) {
  if (condition) return;
  const error = new assert.AssertionError({ message: `Native approval refused: ${reason}` });
  failures.set(error, error.message);
  throw error;
}
export function approvalFailureReason(error) {
  return failures.get(error);
}
function one(rows, predicate, reason) {
  const found = rows.filter(predicate);
  guard(found.length === 1, reason);
  return found[0];
}
function equal(actual, expected, reason) {
  guard(isDeepStrictEqual(actual, expected), reason);
}
function state(scope) {
  const value = policies.get(scope);
  guard(value, "reviewed policy missing");
  return value;
}
export function hasApprovalPolicy(scope) {
  return policies.has(scope);
}
export function enableApprovalPolicy(scope, review, followupId) {
  guard(scope.execute && !policies.has(scope), "policy initialization");
  equal(review.approvalPlan, APPROVAL_PLAN, "reviewed plan differs");
  guard(
    review.schemaVersion === 2 &&
      review.authorization === "six-native-project-runs-with-exact-single-use-approvals",
    "review schema",
  );
  guard(
    [4, 5, 6].includes(review.maxRuns) && scope.maxRuns === review.maxRuns,
    "reviewed run limit differs",
  );
  guard(typeof followupId === "string" && followupId.length > 0, "follow-up intent missing");
  policies.set(scope, {
    projectId: scope.projectId,
    coordinatorId: `project-coordinator:${scope.projectId}`,
    codexModel: review.codex.model,
    workerModel: review.claude.model,
    followupId,
    calls: new Map(),
    callOwners: new Map(),
    approvals: new Map(),
    reserved: new Map(),
    resolved: new Set(),
    publications: new Map(),
    sourceRuns: new Map(),
    completion: null,
    wake: null,
    worker: null,
  });
}
export function delegateInput(model) {
  return {
    mode: "async",
    title: "Native marker worker",
    role: "test",
    target: { providerInstanceId: "claudeAgent", model },
    runtimeMode: "approval-required",
    clientRequestId: "native-proof-initial",
    task: WORKER_TASK,
  };
}
function completionCohort(scope, p, run, policy) {
  const cohort = run.delegatedCompletion;
  guard(cohort && !Array.isArray(cohort), "completion cohort shape");
  equal(
    Object.keys(cohort).sort(),
    ["delivery", "disposition", "nextGeneration"],
    "completion cohort fields",
  );
  guard(
    ["open", "stopped", "disposed"].includes(cohort.disposition) &&
      Number.isSafeInteger(cohort.nextGeneration) &&
      cohort.nextGeneration >= 2 &&
      cohort.nextGeneration <= 3,
    "completion cohort generation/disposition",
  );
  const grant = policy.approvals.get("delegate_task");
  guard(grant?.submitted && grant.binding.runId === run.id, "completion delegation not approved");
  const call = one(
    p.turnItems,
    (i) =>
      i.id === grant.binding.callId &&
      i.runId === run.id &&
      i.toolName === "studio-code.delegate_task" &&
      i.status === "completed",
    "completion delegation missing",
  );
  equal(call.input, delegateInput(policy.workerModel), "completion delegation input");
  const child = one(
    p.subagents,
    (s) => s.origin === "app_owned" && s.runId === run.id,
    "completion task missing/ambiguous",
  );
  guard(
    child.threadId === policy.coordinatorId &&
      child.parentNodeId === run.rootNodeId &&
      child.driver === "claudeAgent" &&
      child.providerInstanceId === "claudeAgent" &&
      child.model === policy.workerModel &&
      ["completed", "failed", "interrupted"].includes(child.status) &&
      scope.threadIds.has(child.childThreadId) &&
      call.output?.taskId === child.id &&
      call.output.childThreadId === child.childThreadId,
    "completion task binding",
  );
  const workerRun = scope.runs.get(call.output.childRunId);
  guard(
    workerRun?.threadId === child.childThreadId &&
      workerRun.providerInstanceId === "claudeAgent" &&
      workerRun.model === policy.workerModel,
    "completion worker run binding",
  );
  if (cohort.delivery === null) return;
  const delivery = cohort.delivery;
  guard(
    delivery && !Array.isArray(delivery) && cohort.disposition === "open",
    "completion delivery shape",
  );
  equal(
    Object.keys(delivery).sort(),
    ["generation", "messageId", "taskIds"],
    "completion delivery fields",
  );
  guard(
    Number.isSafeInteger(delivery.generation) &&
      delivery.generation === cohort.nextGeneration - 1 &&
      typeof delivery.messageId === "string" &&
      delivery.messageId.length > 0 &&
      delivery.messageId !== run.userMessageId,
    "completion delivery generation/message",
  );
  const acknowledged = ["acknowledged", "delivered"].includes(child.completionDelivery?.state);
  guard(
    isDeepStrictEqual(delivery.taskIds, [child.id]) ||
      (acknowledged && isDeepStrictEqual(delivery.taskIds, [])),
    "completion delivery tasks",
  );
}
function sourceDispatch(scope, p, run, operation, policy) {
  if (operation === "task_status") {
    completionLineage(scope, p, run, policy);
    return;
  }
  const tag = ["delegate_task", "orchestrator_capabilities"].includes(operation)
    ? "projects.coordinatorStart"
    : "projects.coordinatorSend";
  const dispatch = one(
    [...scope.dispatches.values()].map(JSON.parse),
    (d) =>
      d.tag === tag &&
      run.userMessageId === `coordinator-send:${scope.projectId}:${d.payload.commandId}`,
    "unreviewed source dispatch",
  );
  one(p.runs, (r) => r.userMessageId === run.userMessageId, "source dispatch has multiple runs");
  if (tag.endsWith("Send"))
    guard(
      policy.worker && dispatch.payload.sourceThreadId === policy.worker.id,
      "selected worker differs",
    );
  guard(!run.restartContinuationOfRunId && !run.manualCodexCreditIntent, "wake/retry/credit run");
  const identity = hash({
    id: run.id,
    threadId: run.threadId,
    userMessageId: run.userMessageId,
    ordinal: run.ordinal,
    providerInstanceId: run.providerInstanceId,
    modelSelection: run.modelSelection,
    providerThreadId: run.providerThreadId,
    rootNodeId: run.rootNodeId,
    activeAttemptId: run.activeAttemptId,
  });
  const previous = policy.sourceRuns.get(dispatch.payload.commandId),
    publication = policy.publications.get(run.id);
  guard(!previous || previous === identity, "source run identity changed");
  guard(
    !publication ||
      (publication.identity === identity && policy.observedAt - publication.at <= 2000),
    "source publication changed or timed out",
  );
  const attempts = p.attempts.filter((a) => a.runId === run.id || a.id === run.activeAttemptId);
  const sourceProviderIdentity = () => {
    const provider = one(
      p.providerThreads,
      (t) => t.id === run.providerThreadId,
      "initial source provider thread",
    );
    return hash({
      id: provider.id,
      appThreadId: provider.appThreadId,
      driver: provider.driver,
      providerInstanceId: provider.providerInstanceId,
      providerSessionId: provider.providerSessionId,
    });
  };
  if (publication?.sourceProvider)
    guard(
      publication.sourceProvider === sourceProviderIdentity(),
      "initial source provider changed",
    );
  if (attempts.length === 0 && tag === "projects.coordinatorStart") {
    // Defensive event6→7 observation; command events are written in batches, not inferred HTTP snapshots.
    modelOwner(p, "codex", policy.codexModel, policy);
    const provider = one(
      p.providerThreads,
      (t) => t.id === run.providerThreadId,
      "initial source provider thread",
    );
    guard(
      !previous &&
        !policy.calls.size &&
        !policy.approvals.size &&
        !policy.worker &&
        scope.dispatches.size === 1 &&
        p.runs.length === 1 &&
        run.ordinal === 1 &&
        run.status === "starting" &&
        run.threadId === policy.coordinatorId &&
        run.delegatedCompletion === undefined &&
        run.providerInstanceId === "codex" &&
        run.modelSelection?.instanceId === "codex" &&
        run.modelSelection?.model === policy.codexModel &&
        typeof run.activeAttemptId === "string" &&
        run.activeAttemptId.length > 0 &&
        typeof run.rootNodeId === "string" &&
        run.rootNodeId.length > 0 &&
        p.thread.activeProviderThreadId === null &&
        p.providerThreads.length === 1 &&
        provider.appThreadId === p.thread.id &&
        provider.driver === "codex" &&
        provider.providerInstanceId === "codex" &&
        provider.status === "not_loaded" &&
        provider.nativeThreadRef === null &&
        provider.lastRunOrdinal === 1 &&
        typeof provider.providerSessionId === "string" &&
        provider.providerSessionId.length > 0 &&
        !p.providerSessions.length &&
        !p.providerTurns.length &&
        !p.nodes.length &&
        !p.turnItems.length &&
        !p.runtimeRequests.length &&
        !p.messages?.length &&
        !p.subagents.length,
      "initial source publication binding",
    );
    if (!publication)
      policy.publications.set(run.id, {
        sourceRunId: run.id,
        identity,
        sourceProvider: sourceProviderIdentity(),
        at: policy.observedAt,
      });
    return;
  }
  if (attempts.length === 0 && tag === "projects.coordinatorSend") {
    // Actual event141 publishes this owned follow-up run before its initial attempt142.
    modelOwner(p, "codex", policy.codexModel, policy);
    const prior = one(p.runs, (r) => r.ordinal === run.ordinal - 1, "source prior run");
    const grant = policy.approvals.get("delegate_task");
    const provider = one(
      p.providerThreads,
      (t) => t.id === run.providerThreadId,
      "source provider thread",
    );
    const session = one(
      p.providerSessions,
      (s) => s.id === provider.providerSessionId,
      "source provider session",
    );
    guard(
      !previous &&
        run.status === "starting" &&
        run.threadId === policy.coordinatorId &&
        run.delegatedCompletion === undefined &&
        [2, 3].includes(run.ordinal) &&
        prior.status === "completed" &&
        run.providerThreadId === prior.providerThreadId &&
        run.providerInstanceId === "codex" &&
        run.modelSelection?.instanceId === "codex" &&
        run.modelSelection?.model === policy.codexModel &&
        typeof run.activeAttemptId === "string" &&
        run.activeAttemptId.length > 0 &&
        typeof run.rootNodeId === "string" &&
        run.rootNodeId.length > 0 &&
        grant?.submitted &&
        provider.id === grant.binding.providerThreadId &&
        provider.appThreadId === p.thread.id &&
        provider.driver === "codex" &&
        provider.providerInstanceId === "codex" &&
        p.thread.activeProviderThreadId === provider.id &&
        hash(session.id) === grant.binding.sessionSha256 &&
        session.driver === "codex" &&
        session.providerInstanceId === "codex" &&
        session.model === policy.codexModel,
      "source initial publication binding",
    );
    guard(
      !p.nodes.some((n) => n.runId === run.id || n.id === run.rootNodeId) &&
        !p.turnItems.some((i) => i.runId === run.id) &&
        !p.messages?.some((m) => m.runId === run.id) &&
        !p.providerTurns.some(
          (t) => t.runAttemptId === run.activeAttemptId || t.nodeId === run.rootNodeId,
        ) &&
        !p.runtimeRequests.some((q) => q.status === "pending"),
      "source attempt missing after work started",
    );
    if (!publication)
      policy.publications.set(run.id, { sourceRunId: run.id, identity, at: policy.observedAt });
    return;
  }
  guard(attempts.length === 1, "source attempt missing/ambiguous");
  const attempt = attempts[0];
  guard(
    attempt.runId === run.id &&
      attempt.id === run.activeAttemptId &&
      attempt.reason === "initial" &&
      attempt.attemptOrdinal === 1 &&
      attempt.rootNodeId === run.rootNodeId &&
      attempt.providerThreadId === run.providerThreadId &&
      attempt.providerInstanceId === "codex",
    "source initial attempt binding",
  );
  if (publication) policy.publications.delete(run.id);
  if (run.delegatedCompletion !== undefined) {
    // This field is a delivery cohort on the original run, not a wake's source-message identity.
    guard(
      previous && tag === "projects.coordinatorStart",
      "completion requires bound original run",
    );
    completionCohort(scope, p, run, policy);
  } else if (!previous) policy.sourceRuns.set(dispatch.payload.commandId, identity);
}
// The recorded mailbox writes run -> initial attempt -> root -> message before starting the turn.
// Only that exact starting prefix may wait; it cannot produce an approval or result receipt.
function deferStartingWakeMessage(p, parent, run, child, grant, policy) {
  const delivery = parent.delegatedCompletion.delivery;
  guard(
    delivery &&
      delivery.generation === 1 &&
      isDeepStrictEqual(delivery.taskIds, [child.id]) &&
      run.id !== parent.id &&
      run.status === "starting" &&
      run.userMessageId === delivery.messageId &&
      run.threadId === policy.coordinatorId &&
      run.ordinal === 2 &&
      parent.ordinal === 1 &&
      parent.status === "completed" &&
      run.providerInstanceId === "codex" &&
      run.modelSelection?.instanceId === "codex" &&
      run.modelSelection?.model === policy.codexModel &&
      run.providerThreadId === parent.providerThreadId &&
      !run.restartContinuationOfRunId &&
      !run.manualCodexCreditIntent &&
      run.delegatedCompletion === undefined &&
      typeof run.activeAttemptId === "string" &&
      typeof run.rootNodeId === "string",
    "completion message missing/ambiguous",
  );
  one(p.runs, (r) => r.userMessageId === delivery.messageId, "multiple completion wakes");
  const parentTurn = one(
    p.providerTurns,
    (t) => t.runAttemptId === parent.activeAttemptId,
    "completion parent turn",
  );
  guard(
    parentTurn.id === grant.binding.providerTurnId && parentTurn.status === "completed",
    "completion wake before parent turn settled",
  );
  const attempts = p.attempts.filter((a) => a.runId === run.id || a.id === run.activeAttemptId);
  guard(attempts.length <= 1, "completion wake attempt missing/ambiguous");
  if (attempts.length) {
    const a = attempts[0];
    guard(
      a.id === run.activeAttemptId &&
        a.runId === run.id &&
        a.attemptOrdinal === 1 &&
        a.reason === "initial" &&
        a.status === "pending" &&
        a.rootNodeId === run.rootNodeId &&
        a.providerInstanceId === "codex" &&
        a.providerThreadId === run.providerThreadId &&
        a.providerTurnId === null,
      "completion wake initial attempt",
    );
  }
  guard(
    !p.providerTurns.some(
      (t) => t.runAttemptId === run.activeAttemptId || t.nodeId === run.rootNodeId,
    ) &&
      !p.turnItems.some((i) => i.runId === run.id) &&
      !p.runtimeRequests.some((q) => q.status === "pending"),
    "completion missing message after work started",
  );
  const roots = p.nodes.filter((n) => n.id === run.rootNodeId || n.runId === run.id);
  guard(roots.length <= 1, "completion wake root ambiguity");
  if (roots.length) {
    const n = roots[0];
    guard(
      n.id === run.rootNodeId &&
        n.rootNodeId === run.rootNodeId &&
        n.runId === run.id &&
        n.threadId === policy.coordinatorId &&
        n.providerThreadId === run.providerThreadId &&
        n.providerTurnId === null &&
        n.kind === "root_turn" &&
        n.parentNodeId === null &&
        n.status === "pending",
      "completion wake root binding",
    );
  }
  const provider = one(
    p.providerThreads,
    (t) => t.id === run.providerThreadId,
    "completion wake provider thread",
  );
  const session = one(
    p.providerSessions,
    (s) => s.id === provider.providerSessionId,
    "completion wake session",
  );
  guard(
    provider.appThreadId === policy.coordinatorId &&
      provider.driver === "codex" &&
      provider.providerInstanceId === "codex" &&
      session.driver === "codex" &&
      session.providerInstanceId === "codex" &&
      session.model === policy.codexModel &&
      hash(session.id) === grant.binding.sessionSha256,
    "completion wake session binding",
  );
  const wake = {
    runId: run.id,
    ordinal: run.ordinal,
    userMessageId: run.userMessageId,
    attemptId: run.activeAttemptId,
    rootNodeId: run.rootNodeId,
    providerThreadId: provider.id,
    sessionSha256: hash(session.id),
  };
  const pending = policy.wakePublication;
  guard(
    !pending || (pending.identity === hash(wake) && policy.observedAt - pending.since <= 2000),
    "completion wake publication changed or timed out",
  );
  policy.wakePublication = pending ?? {
    runId: run.id,
    identity: hash(wake),
    since: policy.observedAt,
  };
}
// A cohort on the original run is distinct from a server-owned completion message's new run.
// Pin the source user run first; never establish that authority from wake metadata.
function completionLineage(scope, p, resultRun, policy) {
  const grant = policy.approvals.get("delegate_task");
  guard(grant?.submitted, "completion delegation not approved");
  const parent = one(p.runs, (r) => r.id === grant.binding.runId, "completion parent missing");
  sourceDispatch(scope, p, parent, "delegate_task", policy);
  const child = one(
    p.subagents,
    (s) => s.origin === "app_owned",
    "completion task missing/ambiguous",
  );
  const call = one(
    p.turnItems,
    (i) => i.id === grant.binding.callId && i.status === "completed",
    "completion delegation missing",
  );
  const workerRun = scope.runs.get(call.output?.childRunId);
  guard(
    child.status === "completed" && workerRun?.status === "completed",
    "completion result is not successful",
  );
  const cohort = parent.delegatedCompletion;
  guard(
    cohort?.nextGeneration === 2 && ["open", "stopped"].includes(cohort.disposition),
    "completion generation differs",
  );
  guard(!inflight(resultRun) || cohort.disposition === "open", "completion was stopped");
  const messages = (p.messages ?? []).filter((m) => m.delegatedCompletion !== undefined);
  if (messages.length === 0) {
    deferStartingWakeMessage(p, parent, resultRun, child, grant, policy);
    return;
  }
  const message = one(messages, () => true, "completion message missing/ambiguous");
  equal(
    message.delegatedCompletion,
    { parentRunId: parent.id, generation: 1, taskIds: [child.id] },
    "completion message lineage",
  );
  guard(
    message.threadId === policy.coordinatorId &&
      message.createdBy === "agent" &&
      message.creationSource === "server" &&
      message.role === "user" &&
      message.id !== parent.userMessageId &&
      !message.manualCodexCreditIntent &&
      !message.notification &&
      message.context === undefined &&
      message.scheduledTaskId === undefined &&
      message.senderThreadId === undefined &&
      message.text ===
        `Delegated task ${child.id} reached a terminal state. Use task_status with taskId ${child.id} to read the result.`,
    "completion message ownership",
  );
  equal(message.attachments, [], "completion message attachments");
  if (cohort.delivery !== null)
    guard(
      cohort.delivery.messageId === message.id && cohort.delivery.generation === 1,
      "completion delivery identity",
    );
  else
    guard(
      ["acknowledged", "delivered"].includes(child.completionDelivery?.state),
      "unobserved completion was not delivered",
    );
  const binding = {
    parentRunId: parent.id,
    messageId: message.id,
    generation: 1,
    taskId: child.id,
    workerThreadId: child.childThreadId,
    workerRunId: workerRun.id,
  };
  if (policy.completion) equal(binding, policy.completion, "completion lineage changed");
  else policy.completion = binding;
  if (resultRun.id === parent.id) {
    guard(
      message.runId === parent.id &&
        message.nodeId === parent.rootNodeId &&
        resultRun.userMessageId !== message.id,
      "active completion message run differs",
    );
    return binding;
  }
  guard(
    (!policy.worker &&
      ![...scope.dispatches.values()]
        .map(JSON.parse)
        .some((d) => d.tag === "projects.coordinatorSend")) ||
      policy.wake?.runId === resultRun.id,
    "completion wake arrived after follow-up",
  );
  one(p.runs, (r) => r.userMessageId === message.id, "multiple completion wakes");
  guard(
    resultRun.userMessageId === message.id &&
      message.runId === resultRun.id &&
      message.nodeId === resultRun.rootNodeId &&
      resultRun.threadId === policy.coordinatorId &&
      resultRun.ordinal === parent.ordinal + 1 &&
      parent.ordinal === 1 &&
      ["running", "waiting", "completed"].includes(parent.status) &&
      resultRun.providerInstanceId === "codex" &&
      resultRun.modelSelection?.instanceId === "codex" &&
      resultRun.modelSelection?.model === policy.codexModel &&
      resultRun.providerThreadId === parent.providerThreadId &&
      !resultRun.restartContinuationOfRunId &&
      !resultRun.manualCodexCreditIntent &&
      resultRun.delegatedCompletion === undefined,
    "completion wake run binding",
  );
  const parentTurn = one(
    p.providerTurns,
    (t) => t.runAttemptId === parent.activeAttemptId,
    "completion parent turn",
  );
  guard(
    parentTurn.id === grant.binding.providerTurnId && parentTurn.status === "completed",
    "completion wake before parent turn settled",
  );
  const attempt = one(
    p.attempts,
    (a) => a.runId === resultRun.id,
    "completion wake attempt missing/ambiguous",
  );
  guard(
    attempt.id === resultRun.activeAttemptId &&
      attempt.attemptOrdinal === 1 &&
      attempt.reason === "initial" &&
      attempt.rootNodeId === resultRun.rootNodeId &&
      attempt.providerInstanceId === "codex" &&
      attempt.providerThreadId === resultRun.providerThreadId,
    "completion wake initial attempt",
  );
  const turns = p.providerTurns.filter((t) => t.runAttemptId === attempt.id);
  guard(turns.length <= 1, "completion wake turn missing/ambiguous");
  if (turns.length) {
    guard(
      !policy.wakeTurnId || policy.wakeTurnId === turns[0].id,
      "completion wake turn identity changed",
    );
    policy.wakeTurnId = turns[0].id;
  }
  if (turns.length)
    guard(
      turns[0].nodeId === resultRun.rootNodeId &&
        turns[0].providerThreadId === resultRun.providerThreadId &&
        (attempt.providerTurnId === null || attempt.providerTurnId === turns[0].id),
      "completion wake provider turn",
    );
  const provider = one(
    p.providerThreads,
    (t) => t.id === resultRun.providerThreadId,
    "completion wake provider thread",
  );
  const session = one(
    p.providerSessions,
    (s) => s.id === provider.providerSessionId,
    "completion wake session",
  );
  guard(
    provider.appThreadId === policy.coordinatorId &&
      provider.driver === "codex" &&
      provider.providerInstanceId === "codex" &&
      session.id ===
        one(
          p.providerThreads,
          (t) => t.id === parent.providerThreadId,
          "completion parent provider",
        ).providerSessionId &&
      session.driver === "codex" &&
      session.providerInstanceId === "codex" &&
      session.model === policy.codexModel &&
      hash(session.id) === grant.binding.sessionSha256,
    "completion wake session binding",
  );
  const wake = {
    runId: resultRun.id,
    ordinal: resultRun.ordinal,
    userMessageId: resultRun.userMessageId,
    attemptId: attempt.id,
    rootNodeId: resultRun.rootNodeId,
    providerThreadId: provider.id,
    sessionSha256: hash(session.id),
  };
  if (policy.wake) equal(wake, policy.wake, "completion wake identity changed");
  else policy.wake = wake;
  const pending = policy.wakePublication;
  guard(
    !pending || (pending.identity === hash(wake) && policy.observedAt - pending.since <= 2000),
    "completion wake publication changed or timed out",
  );
  if (turns.length === 0) {
    guard(!policy.wakeTurnId, "completion published turn disappeared");
    guard(
      ["queued", "starting", "preparing", "running"].includes(resultRun.status) &&
        attempt.providerTurnId === null,
      "completion wake turn missing/ambiguous",
    );
    guard(
      !p.providerTurns.some((t) => t.nodeId === resultRun.rootNodeId),
      "completion wake foreign provider turn",
    );
    policy.wakePublication = pending ?? {
      runId: resultRun.id,
      identity: hash(wake),
      since: policy.observedAt,
    };
  } else policy.wakePublication = null;
  return binding;
}
export function completionReceipt(scope) {
  const policy = state(scope);
  return policy.completion
    ? {
        ...policy.completion,
        deliveryRunId: policy.wake?.runId ?? policy.approvals.get("delegate_task").binding.runId,
        wakeRunId: policy.wake?.runId ?? null,
      }
    : null;
}
export function approvalObservationReady(scope) {
  const p = state(scope);
  return !p.wakePublication && ![...p.publications.values()].some((v) => v.sourceRunId);
}
export function completionResultReceipt(scope, parent) {
  const policy = state(scope),
    binding = completionReceipt(scope);
  guard(approvalObservationReady(scope), "completion wake publication incomplete");
  guard(binding, "completion result lineage missing");
  const grant = policy.approvals.get("task_status");
  guard(
    grant?.submitted && grant.binding.runId === binding.deliveryRunId,
    "completion result read not approved",
  );
  const call = one(
    parent.turnItems,
    (i) =>
      i.id === grant.binding.callId &&
      i.toolName === "studio-code.task_status" &&
      i.status === "completed" &&
      i.runId === binding.deliveryRunId,
    "completion result read missing",
  );
  equal(call.input, { taskId: binding.taskId }, "completion result read input");
  const child = one(
    parent.subagents,
    (s) => s.id === binding.taskId,
    "completion acknowledged task missing",
  );
  guard(
    child.completionDelivery?.state === "acknowledged" &&
      child.completionDelivery.observedByRunId === binding.deliveryRunId,
    "completion result was not acknowledged",
  );
  const output = call.output;
  guard(
    output?.taskId === binding.taskId &&
      output.childThreadId === binding.workerThreadId &&
      output.childRunId === binding.workerRunId &&
      output.status === "completed" &&
      output.workState === "result_available" &&
      output.hasPendingChildRuns === false &&
      output.providerInstanceId === "claudeAgent" &&
      output.model === policy.workerModel &&
      output.waitTimedOut === false &&
      typeof output.summary === "string" &&
      output.summary.length > 0,
    "completion result output binding",
  );
  return { ...binding, resultReadCallId: call.id, resultReadRunId: call.runId };
}
function modelOwner(projection, instanceId, model, policy) {
  guard(
    projection.thread.projectId === policy.projectId &&
      projection.thread.providerInstanceId === instanceId &&
      projection.thread.modelSelection?.instanceId === instanceId &&
      projection.thread.modelSelection?.model === model &&
      projection.thread.runtimeMode === "approval-required",
    "project/provider/model/runtime differs",
  );
}
export function armSelectedWorker(scope, worker, parent) {
  const policy = state(scope);
  guard(
    !policy.worker &&
      parent.thread.id === policy.coordinatorId &&
      worker.thread.id !== policy.coordinatorId,
    "worker already armed or foreign parent",
  );
  modelOwner(worker, "claudeAgent", policy.workerModel, policy);
  modelOwner(parent, "codex", policy.codexModel, policy);
  guard(policy.calls.has("delegate_task"), "delegation not observed");
  const child = one(parent.subagents, (s) => s.origin === "app_owned", "worker membership");
  guard(
    child.childThreadId === worker.thread.id &&
      child.status === "completed" &&
      worker.runs.length === 1 &&
      worker.runs[0].status === "completed" &&
      scope.threadIds.has(worker.thread.id),
    "worker not settled/owned",
  );
  policy.worker = { id: worker.thread.id, initialRunId: worker.runs[0].id };
}
function followupRun(policy, snapshots, parent, coordinatorRunId) {
  guard(policy.worker, "worker not armed");
  const worker = snapshots.get(policy.worker.id);
  guard(worker, "worker projection missing");
  modelOwner(worker, "claudeAgent", policy.workerModel, policy);
  const sent = one(
    parent.turnItems,
    (i) =>
      i.type === "dynamic_tool" &&
      i.toolName === "studio-code.studio_thread_send" &&
      i.runId === coordinatorRunId &&
      i.status === "completed",
    "completed send result missing",
  );
  equal(
    sent.input,
    {
      threadId: policy.worker.id,
      message: WORKER_TASK,
      mode: "auto",
      clientRequestId: policy.followupId,
    },
    "send input differs",
  );
  const result = sent.output;
  guard(
    result &&
      !Array.isArray(result) &&
      result.threadId === policy.worker.id &&
      typeof result.runId === "string" &&
      typeof result.messageId === "string",
    "send result shape",
  );
  const run = one(
    worker.runs,
    (r) => r.id === result.runId && r.userMessageId === result.messageId,
    "send result run binding",
  );
  guard(
    worker.runs.length === 2 &&
      run.id !== policy.worker.initialRunId &&
      worker.runs.some((r) => r.id === policy.worker.initialRunId) &&
      run.providerInstanceId === "claudeAgent" &&
      run.modelSelection?.instanceId === "claudeAgent" &&
      run.modelSelection?.model === policy.workerModel,
    "follow-up worker run differs",
  );
  return run;
}
function expectedInput(operation, policy, snapshots, parent, run) {
  if (operation === "orchestrator_capabilities") return {};
  if (operation === "delegate_task") return delegateInput(policy.workerModel);
  if (operation === "task_status") return { taskId: policy.completion.taskId };
  guard(policy.worker, "worker not armed");
  if (operation === "studio_thread_send")
    return {
      threadId: policy.worker.id,
      message: WORKER_TASK,
      mode: "auto",
      clientRequestId: policy.followupId,
    };
  const workerRun = followupRun(policy, snapshots, parent, run.id);
  if (operation === "studio_thread_wait")
    return { threadId: policy.worker.id, runId: workerRun.id, timeoutMs: 120000 };
  guard(
    operation === "studio_thread_read" && workerRun.status === "completed",
    "read requires completed worker run",
  );
  const waited = one(
    parent.turnItems,
    (i) =>
      i.type === "dynamic_tool" &&
      i.toolName === "studio-code.studio_thread_wait" &&
      i.runId === run.id &&
      i.status === "completed",
    "completed wait missing",
  );
  equal(
    waited.input,
    { threadId: policy.worker.id, runId: workerRun.id, timeoutMs: 120000 },
    "wait input differs",
  );
  guard(
    waited.output?.threadId === policy.worker.id &&
      waited.output?.runId === workerRun.id &&
      waited.output?.timedOut === false,
    "wait result differs",
  );
  return { threadId: policy.worker.id, view: "messages" };
}
// ThreadWaitTool alone is Readonly=true in the frozen runtime and can finish without
// an elicitation. This binds its stored detail to the exact prior send; it grants nothing.
export function unpromptedWaitDetailBinding(scope, p, call) {
  const policy = state(scope),
    operation = "studio_thread_wait";
  guard(
    call.toolName === `studio-code.${operation}` &&
      call.status === "completed" &&
      p.thread.id === policy.coordinatorId &&
      !policy.approvals.has(operation),
    "unprompted wait scope",
  );
  modelOwner(p, "codex", policy.codexModel, policy);
  const run = one(p.runs, (r) => r.id === call.runId, "unprompted wait run");
  sourceDispatch(scope, p, run, operation, policy);
  guard(
    run.providerInstanceId === "codex" &&
      run.modelSelection?.instanceId === "codex" &&
      run.modelSelection?.model === policy.codexModel,
    "unprompted wait model",
  );
  const sentGrant = policy.approvals.get("studio_thread_send");
  guard(
    sentGrant?.submitted &&
      sentGrant.binding.runId === run.id &&
      sentGrant.binding.providerThreadId === call.providerThreadId &&
      sentGrant.binding.providerTurnId === call.providerTurnId,
    "unprompted wait send authorization",
  );
  const sent = one(
    p.turnItems,
    (i) =>
      i.id === sentGrant.binding.callId &&
      i.toolName === "studio-code.studio_thread_send" &&
      i.status === "completed" &&
      i.runId === run.id,
    "unprompted wait completed send",
  );
  equal(
    sent.input,
    {
      threadId: policy.worker.id,
      message: WORKER_TASK,
      mode: "auto",
      clientRequestId: policy.followupId,
    },
    "send input differs",
  );
  guard(
    sent.output?.threadId === policy.worker.id && typeof sent.output.runId === "string",
    "unprompted wait send result",
  );
  equal(
    call.input,
    { threadId: policy.worker.id, runId: sent.output.runId, timeoutMs: 120000 },
    "unprompted wait input",
  );
  const worker = scope.runs.get(sent.output.runId);
  guard(
    worker?.threadId === policy.worker.id &&
      worker.id !== policy.worker.initialRunId &&
      worker.providerInstanceId === "claudeAgent" &&
      worker.model === policy.workerModel,
    "unprompted wait worker binding",
  );
  one(p.turnItems, (i) => i.toolName === call.toolName, "unprompted wait duplicate call");
  guard(
    !p.turnItems.some(
      (i) =>
        i.type === "approval_request" &&
        i.runId === run.id &&
        i.prompt === `Allow the studio-code MCP server to run tool "${operation}"?`,
    ),
    "unprompted wait has approval request",
  );
  const node = one(p.nodes, (n) => n.id === call.nodeId, "unprompted wait node");
  guard(
    node.threadId === p.thread.id &&
      node.runId === run.id &&
      node.rootNodeId === run.rootNodeId &&
      node.kind === "tool_call" &&
      node.status === "completed" &&
      node.providerThreadId === call.providerThreadId &&
      node.providerTurnId === call.providerTurnId,
    "unprompted wait node binding",
  );
  return {
    ...sentGrant.binding,
    operation,
    callId: call.id,
    inputSha256: hash(call.input),
    authorization: "exact-prior-send-and-readonly-wait",
  };
}
function activeBinding(p, runId, turnId, sessionId, policy) {
  modelOwner(p, "codex", policy.codexModel, policy);
  const run = one(p.runs, (r) => r.id === runId, "approval run missing");
  guard(
    inflight(run) &&
      run.threadId === policy.coordinatorId &&
      run.providerInstanceId === "codex" &&
      run.modelSelection?.instanceId === "codex" &&
      run.modelSelection?.model === policy.codexModel,
    "run provider/model/status",
  );
  const attempt = one(p.attempts, (a) => a.id === run.activeAttemptId, "active attempt missing");
  guard(
    attempt.runId === run.id &&
      attempt.reason === "initial" &&
      attempt.attemptOrdinal === 1 &&
      attempt.status === "running" &&
      attempt.providerInstanceId === "codex" &&
      attempt.rootNodeId === run.rootNodeId &&
      attempt.providerThreadId === run.providerThreadId &&
      (attempt.providerTurnId === null || attempt.providerTurnId === turnId),
    "attempt binding",
  );
  const turn = one(
    p.providerTurns,
    (t) => t.runAttemptId === attempt.id && t.status === "running",
    "provider turn missing/ambiguous",
  );
  guard(
    turn.id === turnId &&
      turn.nodeId === run.rootNodeId &&
      turn.providerThreadId === run.providerThreadId,
    "provider turn binding",
  );
  const provider = one(
    p.providerThreads,
    (t) => t.id === run.providerThreadId,
    "provider thread missing",
  );
  guard(
    provider.appThreadId === p.thread.id &&
      provider.driver === "codex" &&
      provider.providerInstanceId === "codex" &&
      (sessionId === undefined || provider.providerSessionId === sessionId) &&
      p.thread.activeProviderThreadId === provider.id &&
      provider.status === "active",
    "provider session binding",
  );
  const session = one(
    p.providerSessions,
    (s) => s.id === provider.providerSessionId,
    "live session missing",
  );
  guard(
    session.driver === "codex" &&
      session.providerInstanceId === "codex" &&
      session.model === policy.codexModel &&
      ["ready", "running", "waiting"].includes(session.status),
    "live session provider/model/status",
  );
  // Thread projections strip redundant threadId from turn items. Nodes retain it.
  const sameOwner = (item) =>
    (item.threadId === undefined || item.threadId === p.thread.id) &&
    item.runId === run.id &&
    item.providerThreadId === provider.id &&
    item.providerTurnId === turn.id;
  return { run, attempt, turn, provider, session, sameOwner };
}
// Provider events arrive separately. Missing links may be observed for <=2s; no grant exists while incomplete.
function publication(policy, node, missing, now) {
  const key = node.id;
  const identity = hash({
    id: node.id,
    threadId: node.threadId,
    runId: node.runId,
    rootNodeId: node.rootNodeId,
    providerThreadId: node.providerThreadId,
    providerTurnId: node.providerTurnId,
    kind: node.kind,
    runtimeRequestId: node.runtimeRequestId,
    nativeItemRef: node.nativeItemRef,
  });
  const old = policy.publications.get(key);
  guard(!old || old.identity === identity, "incomplete publication changed linkage");
  guard(!old || now - old.at < 2000, "incomplete publication deadline");
  if (missing && !old) policy.publications.set(key, { identity, at: now });
  if (!missing) policy.publications.delete(key);
  return missing;
}
function eligibleIncompleteNode(scope, p, node, policy) {
  guard(
    p.thread.id === policy.coordinatorId && node.threadId === p.thread.id && inflight(node),
    "incomplete node ownership/status",
  );
  const { run, sameOwner } = activeBinding(p, node.runId, node.providerTurnId, undefined, policy);
  guard(
    sameOwner(node) &&
      node.rootNodeId === run.rootNodeId &&
      node.nativeItemRef?.driver === "codex" &&
      node.nativeItemRef?.strength === "strong" &&
      typeof node.nativeItemRef?.nativeId === "string",
    "incomplete node binding",
  );
  const dispatch = [...scope.dispatches.values()]
    .map(JSON.parse)
    .find(
      (d) => run.userMessageId === `coordinator-send:${scope.projectId}:${d.payload.commandId}`,
    );
  sourceDispatch(
    scope,
    p,
    run,
    dispatch?.tag === "projects.coordinatorStart"
      ? "delegate_task"
      : dispatch?.tag === "projects.coordinatorSend"
        ? "studio_thread_send"
        : "task_status",
    policy,
  );
}
// Called only after every projection has passed the global run/turn/thread budget.
export function inspectApprovals(scope, snapshots, now = performance.now()) {
  const policy = state(scope),
    pending = [];
  let incomplete = false;
  policy.candidate = null;
  policy.observedAt = now;
  if (policy.wakePublication)
    guard(
      [...snapshots.values()]
        .flatMap((p) => p.runs)
        .some((r) => r.id === policy.wakePublication.runId),
      "completion wake publication disappeared",
    );
  guard(
    scope.runs.size <= scope.maxRuns &&
      scope.providerTurns.size <= scope.maxRuns &&
      scope.attempts.size <= scope.maxRuns &&
      scope.threadIds.size <= 2,
    "run/turn/thread budget",
  );
  for (const [key, entry] of policy.publications)
    guard(
      [...snapshots.values()]
        .flatMap((p) => (entry.sourceRunId ? p.runs : (p.nodes ?? [])))
        .filter((n) => n.id === key).length === 1,
      "incomplete publication disappeared",
    );
  for (const projection of snapshots.values()) {
    guard(projection.thread.projectId === policy.projectId, "foreign projection");
    const parent = projection.thread.id === policy.coordinatorId;
    if (parent)
      for (const run of projection.runs) {
        const dispatch = [...scope.dispatches.values()]
          .map(JSON.parse)
          .find(
            (d) =>
              run.userMessageId === `coordinator-send:${scope.projectId}:${d.payload.commandId}`,
          );
        sourceDispatch(
          scope,
          projection,
          run,
          dispatch?.tag === "projects.coordinatorStart"
            ? "delegate_task"
            : dispatch?.tag === "projects.coordinatorSend"
              ? "studio_thread_send"
              : "task_status",
          policy,
        );
      }
    for (const request of projection.runtimeRequests) {
      if (request.status !== "pending") policy.resolved.add(request.id);
      else {
        guard(!policy.resolved.has(request.id), "resolved request replay");
        pending.push({ projection, request });
      }
    }
    for (const item of projection.turnItems ?? []) {
      if (item.type !== "dynamic_tool") continue;
      guard(parent, "worker tool call");
      const operation = item.toolName?.replace(/^studio-code\./, "");
      guard(
        item.toolName === `studio-code.${operation}` &&
          [...APPROVAL_PLAN.operations, "orchestrator_capabilities"].includes(operation),
        "unreviewed tool call",
      );
      const run = one(projection.runs, (r) => r.id === item.runId, "tool run missing");
      sourceDispatch(scope, projection, run, operation, policy);
      equal(
        item.input,
        expectedInput(operation, policy, snapshots, projection, run),
        "tool input differs",
      );
      const fingerprint = hash({
        operation,
        id: item.id,
        nodeId: item.nodeId,
        runId: item.runId,
        providerTurnId: item.providerTurnId,
        providerThreadId: item.providerThreadId,
        input: item.input,
      });
      const previous = policy.calls.get(operation);
      guard(!previous || previous === fingerprint, "extra or changed tool call");
      const previousOwner = policy.callOwners.get(item.id);
      guard(
        !previousOwner || previousOwner === operation,
        "tool identity reused across operations",
      );
      policy.calls.set(operation, fingerprint);
      policy.callOwners.set(item.id, operation);
    }
    // Dynamic tool items are authoritative for the approved Studio tools; shell/file/native tools cannot hide under another type.
    for (const node of projection.nodes ?? []) {
      if (["tool_call", "hook"].includes(node.kind)) {
        guard(parent && node.kind === "tool_call", "unreviewed execution node");
        const item = projection.turnItems.find((i) => i.nodeId === node.id);
        if (item) guard(item.type === "dynamic_tool", "unreviewed execution node");
        else eligibleIncompleteNode(scope, projection, node, policy);
        incomplete = publication(policy, node, !item, now) || incomplete;
      } else if (node.kind === "approval_request" && node.status === "waiting") {
        const q = projection.runtimeRequests.find((r) => r.id === node.runtimeRequestId);
        const item = projection.turnItems.find(
          (i) => i.nodeId === node.id && i.type === "approval_request",
        );
        if (!q || !item) {
          eligibleIncompleteNode(scope, projection, node, policy);
          incomplete = publication(policy, node, true, now) || incomplete;
        } else publication(policy, node, false, now);
      }
    }
  }
  guard(pending.length <= 1, "multiple pending requests");
  if (pending.length === 0) return null;
  const { projection: p, request: q } = pending[0];
  guard(p.thread.id === policy.coordinatorId, "foreign approval owner");
  modelOwner(p, "codex", policy.codexModel, policy);
  guard(
    q.kind === "mcp-elicitation" &&
      q.status === "pending" &&
      q.resolvedAt === null &&
      q.decision === undefined,
    "request kind/status",
  );
  equal(
    q.nativeRequestRef,
    { driver: "codex", nativeId: "mcp-elicitation:studio-code", strength: "strong" },
    "native request source",
  );
  guard(q.responseCapability?.type === "live", "request is not live");
  const approvalItems = p.turnItems.filter(
    (i) => i.type === "approval_request" && i.requestId === q.id,
  );
  guard(approvalItems.length <= 1, "approval item missing/ambiguous");
  if (approvalItems.length === 0) {
    const node = one(p.nodes, (n) => n.id === q.nodeId, "approval node missing");
    eligibleIncompleteNode(scope, p, node, policy);
    guard(
      node.kind === "approval_request" &&
        node.runtimeRequestId === q.id &&
        node.providerTurnId === q.providerTurnId,
      "incomplete approval request linkage",
    );
    activeBinding(p, node.runId, q.providerTurnId, q.responseCapability.providerSessionId, policy);
    publication(policy, node, true, now);
    return null;
  }
  const approval = approvalItems[0];
  guard(
    approval.status === "waiting" &&
      approval.nodeId === q.nodeId &&
      approval.providerTurnId === q.providerTurnId &&
      approval.appName === "studio-code" &&
      approval.requestKind === "mcp-elicitation",
    "approval item binding",
  );
  equal(approval.options, APPROVAL_OPTIONS, "approval choices differ");
  const { run, attempt, turn, provider, session, sameOwner } = activeBinding(
    p,
    approval.runId,
    q.providerTurnId,
    q.responseCapability.providerSessionId,
    policy,
  );
  guard(sameOwner(approval), "approval ownership");
  const call = one(
    p.turnItems,
    (i) => i.type === "dynamic_tool" && inflight(i) && sameOwner(i),
    "in-flight call missing/ambiguous",
  );
  const operation = call.toolName.replace(/^studio-code\./, "");
  guard(
    APPROVAL_PLAN.operations.includes(operation) &&
      approval.prompt === `Allow the studio-code MCP server to run tool "${operation}"?` &&
      approval.ordinal > call.ordinal,
    "approval tool/prompt/order",
  );
  sourceDispatch(scope, p, run, operation, policy);
  equal(
    call.input,
    expectedInput(operation, policy, snapshots, p, run),
    "approved tool input differs",
  );
  for (const [item, kind] of [
    [call, "tool_call"],
    [approval, "approval_request"],
  ]) {
    const node = one(p.nodes, (n) => n.id === item.nodeId, "execution node missing");
    guard(
      node.threadId === p.thread.id &&
        sameOwner(node) &&
        node.rootNodeId === run.rootNodeId &&
        node.kind === kind &&
        inflight(node) &&
        (kind !== "approval_request" || node.runtimeRequestId === q.id),
      "execution node binding",
    );
  }
  const binding = {
    operation,
    projectId: policy.projectId,
    threadId: p.thread.id,
    runId: run.id,
    attemptId: attempt.id,
    providerTurnId: turn.id,
    providerThreadId: provider.id,
    sessionSha256: hash(session.id),
    requestId: q.id,
    callId: call.id,
    inputSha256: hash(call.input),
  };
  if (incomplete || !approvalObservationReady(scope)) return null;
  for (const [usedOperation, entry] of policy.approvals)
    guard(
      usedOperation === operation || entry.binding.requestId !== binding.requestId,
      "request identity reused across operations",
    );
  const previous = policy.approvals.get(operation);
  if (previous) {
    equal(previous.binding, binding, "operation approval replay");
    return null;
  }
  policy.candidate = structuredClone(binding);
  return binding;
}
export function reserveApproval(scope, binding) {
  const policy = state(scope);
  equal(binding, policy.candidate, "unobserved approval binding");
  guard(binding, "approval binding missing");
  guard(
    APPROVAL_PLAN.operations.includes(binding.operation) &&
      !policy.approvals.has(binding.operation) &&
      policy.approvals.size < APPROVAL_PLAN.maxResponses,
    "approval budget/replay",
  );
  const command = {
    type: "runtime-request.respond",
    commandId: randomUUID(),
    threadId: binding.threadId,
    requestId: binding.requestId,
    decision: "accept",
  };
  const entry = {
    binding: structuredClone(binding),
    command: structuredClone(command),
    submitted: false,
  };
  policy.approvals.set(binding.operation, entry);
  policy.reserved.set(command.commandId, entry);
  policy.candidate = null;
  return command;
}
// Consume BEFORE ticket exchange: a lost/failed transport is not an authorization to try again.
export function consumeApprovalCommand(scope, command) {
  const entry = state(scope).reserved.get(command.commandId);
  guard(entry && !entry.submitted, "unreserved or repeated response");
  equal(command, entry.command, "response differs from single-use grant");
  entry.submitted = true;
}
export function approvalReceipt(scope) {
  return [...state(scope).approvals.values()].map(({ binding, submitted }) => ({
    ...binding,
    decision: "accept",
    submitted,
  }));
}
