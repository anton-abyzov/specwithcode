/**
 * 1465: the chaos rig's invariant checker. A pure function over what the rig
 * collected: each thread's projection (`orchestration.getThreadProjection`),
 * the chaos agents' own turn logs, and the messages the rig dispatched. It does
 * no I/O, so check.test.mjs feeds it fixtures, and the rig cannot edit it at run
 * time.
 *
 * Rules (each violation names its rule, thread and run):
 * - `runs-once`: every accepted message completes at most once in its
 *   continuation chain, and a chain that never completes ends visibly (an
 *   error item, a cancel or an interrupt), never silently; messages run in
 *   dispatch order; the agents answered as many turns per thread as the server
 *   completed. A message the person's next message overtook after a visible
 *   limit stop is a note, not a violation: its text stays in the conversation.
 * - `result-delivered`: every app-owned worker that ended was delivered to its
 *   launcher, its result holds the worker agent's answer, and the launcher's
 *   agent was told the task ended.
 * - `no-return-before-reset`: after a run on a source stops on a usage limit, no
 *   later automatic fallback of that thread goes back to the source before the
 *   stop's reset, or `holdMs` when it names none; and one stop starts at most
 *   one fallback. A person's own message runs on the thread's current model and
 *   is no switch.
 */

/** 1460's hold for a limit stop that names no reset. */
export const DEFAULT_HOLD_MS = 60 * 60 * 1000;
/** The prefix of the server's automatic fallback continuation (providerOpenFailure.ts). */
export const LIMIT_FALLBACK_PREFIX = "limit-fallback:";
const ACTIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const ENDED_CHILD = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

const sourceOf = (run) =>
  `${run.providerInstanceId ?? run.modelSelection?.instanceId}\u0000${run.modelSelection?.model ?? ""}`;
const label = (key) => key.replace("\u0000", "/");
const ms = (iso) => (iso ? Date.parse(iso) : Number.NaN);

/** The usage-limit failure of a run, from its error turn items; null when it did not stop on one. */
export function limitFailureOf(view, run) {
  if (run.status !== "failed") return null;
  for (const item of view.turnItems ?? [])
    if (item.runId === run.id && item.type === "error" && item.failure?.class === "usage_limit")
      return item.failure;
  return null;
}

/**
 * The run's chain head: the accepted message it serves. A fallback
 * continuation's message id names the run it continues.
 */
function chains(view) {
  const runs = [...view.runs].sort((x, y) => x.ordinal - y.ordinal);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const headOf = new Map();
  const result = [];
  for (const run of runs) {
    const message = run.userMessageId ?? "";
    let head = null;
    if (message.startsWith(LIMIT_FALLBACK_PREFIX)) {
      const continued = [...byId.keys()].find((id) => message.endsWith(`:${id}`));
      head = continued ? headOf.get(continued) : null;
    }
    if (head) {
      head.runs.push(run);
      headOf.set(run.id, head);
    } else {
      const chain = { messageId: message, runs: [run] };
      result.push(chain);
      headOf.set(run.id, chain);
    }
  }
  return result;
}

/** Whether the timeline shows why a run ended without an answer. */
function endedVisibly(view, run) {
  if (["cancelled", "interrupted"].includes(run.status)) return true;
  return (view.turnItems ?? []).some((item) => item.runId === run.id && item.type === "error");
}

function checkRunsOnce(view, collected, violations, notes) {
  const threadId = view.thread.id;
  const list = chains(view);
  const busy = view.runs.some((run) => ACTIVE.has(run.status));
  const seen = new Map();
  list.forEach((chain, index) => {
    seen.set(chain.messageId, (seen.get(chain.messageId) ?? 0) + 1);
    const completed = chain.runs.filter((run) => run.status === "completed").length;
    const last = chain.runs.at(-1);
    if (completed > 1)
      violations.push({
        rule: "runs-once",
        threadId,
        runId: last.id,
        detail: `message ${chain.messageId} completed ${completed} times`,
      });
    if (completed > 0 || ACTIVE.has(last.status)) return;
    if (!endedVisibly(view, last))
      violations.push({
        rule: "runs-once",
        threadId,
        runId: last.id,
        detail: `message ${chain.messageId} ended ${last.status} with no completed run and nothing in the timeline says why`,
      });
    else if (index < list.length - 1 && limitFailureOf(view, last))
      notes.push({
        rule: "runs-once",
        threadId,
        runId: last.id,
        detail: `message ${chain.messageId} stopped on a limit and the next message overtook it`,
      });
  });
  for (const [messageId, count] of seen)
    if (count > 1)
      violations.push({
        rule: "runs-once",
        threadId,
        runId: null,
        detail: `message ${messageId} started ${count} chains`,
      });
  // The rig's own sends must run in the order it sent them.
  const order = collected.dispatched
    .filter((entry) => entry.threadId === threadId)
    .map((entry) => entry.messageId);
  const ran = list.map((chain) => chain.messageId).filter((id) => order.includes(id));
  const expected = order.filter((id) => ran.includes(id));
  if (ran.join("|") !== expected.join("|"))
    violations.push({
      rule: "runs-once",
      threadId,
      runId: null,
      detail: `messages ran as ${ran.join(", ")} but were sent as ${expected.join(", ")}`,
    });
  // Witness: the agents' answered turns for this thread equal the completed runs.
  const sessions = sessionsOf(view);
  const answered = collected.turns.filter(
    (turn) => sessions.has(turn.sessionId) && turn.outcome === "answered",
  ).length;
  const completedRuns = view.runs.filter((run) => run.status === "completed").length;
  if (!busy && answered !== completedRuns)
    violations.push({
      rule: "runs-once",
      threadId,
      runId: null,
      detail: `agents answered ${answered} turns but the server completed ${completedRuns} runs`,
    });
}

/** The native sessions the thread's agents ran in, to read their turn logs. */
const sessionsOf = (view) =>
  new Set(
    (view.providerThreads ?? []).map((thread) => thread.nativeThreadRef?.nativeId).filter(Boolean),
  );

function checkResultDelivered(view, collected, violations) {
  const threadId = view.thread.id;
  const sessions = sessionsOf(view);
  const shown = collected.turns
    .filter((turn) => sessions.has(turn.sessionId))
    .map((turn) => turn.text);
  for (const child of view.subagents ?? []) {
    if (child.origin !== "app_owned" || !ENDED_CHILD.has(child.status)) continue;
    const worker = child.childThreadId ?? child.id;
    const state = child.completionDelivery?.state ?? "missing";
    if (!["delivered", "acknowledged", "disposed"].includes(state)) {
      violations.push({
        rule: "result-delivered",
        threadId,
        runId: null,
        detail: `worker ${worker} ended ${child.status} but its delivery is ${state}`,
      });
      continue;
    }
    // A disposed delivery is fine only when the launcher itself is gone or stopped.
    if (state === "disposed" && view.runs.some((run) => ACTIVE.has(run.status)))
      violations.push({
        rule: "result-delivered",
        threadId,
        runId: null,
        detail: `worker ${worker}'s delivery was disposed while its launcher still runs`,
      });
    // The worker's own agent answered, and that answer is the stored result.
    const token = /^CHAOS-RESULT ([\w-]+)$/m.exec(child.prompt ?? "")?.[1];
    if (
      child.status === "completed" &&
      token &&
      !(child.result ?? "").includes(`Result ${token} from`)
    )
      violations.push({
        rule: "result-delivered",
        threadId,
        runId: null,
        detail: `worker ${worker} completed but its result does not hold its agent's answer for ${token}`,
      });
    // Witness: the launcher's agent was told this task ended (the wake names its task id).
    if (
      state !== "disposed" &&
      !shown.some((text) => text.includes(child.id) && /reached (?:a )?terminal states?/.test(text))
    )
      violations.push({
        rule: "result-delivered",
        threadId,
        runId: null,
        detail: `worker ${worker} is ${state} but no prompt to the launcher's agent named task ${child.id} as ended`,
      });
  }
}

function checkNoReturn(view, holdMs, violations) {
  const threadId = view.thread.id;
  const runs = [...view.runs].sort((x, y) => x.ordinal - y.ordinal);
  const holds = [];
  for (const run of runs) {
    const source = sourceOf(run);
    const startedAt = ms(run.requestedAt);
    const automatic = (run.userMessageId ?? "").startsWith(LIMIT_FALLBACK_PREFIX);
    const held =
      automatic && holds.find((hold) => hold.source === source && startedAt < hold.until);
    if (held)
      violations.push({
        rule: "no-return-before-reset",
        threadId,
        runId: run.id,
        detail: `fallback run ${run.ordinal} went back to ${label(source)} ${Math.round((startedAt - held.stoppedAt) / 1000)} s after run ${held.ordinal} stopped there on a limit`,
      });
    const failure = limitFailureOf(view, run);
    if (failure) {
      const stoppedAt = ms(run.completedAt ?? run.requestedAt);
      const reset = ms(failure.resetAt);
      holds.push({
        source,
        ordinal: run.ordinal,
        stoppedAt,
        until: Number.isFinite(reset) ? reset : stoppedAt + holdMs,
      });
      const fallbacks = runs.filter(
        (other) => other.userMessageId === `${LIMIT_FALLBACK_PREFIX}${threadId}:${run.id}`,
      );
      if (fallbacks.length > 1)
        violations.push({
          rule: "no-return-before-reset",
          threadId,
          runId: run.id,
          detail: `limit stop of run ${run.ordinal} started ${fallbacks.length} fallbacks`,
        });
    }
  }
}

/** Checks one collection; returns the violations and a short summary. */
export function check(collected, { holdMs = DEFAULT_HOLD_MS } = {}) {
  const violations = [];
  const notes = [];
  for (const view of collected.threads) {
    checkRunsOnce(view, collected, violations, notes);
    checkResultDelivered(view, collected, violations);
    checkNoReturn(view, holdMs, violations);
  }
  const runs = collected.threads.flatMap((view) => view.runs);
  return {
    violations,
    notes,
    summary: {
      threads: collected.threads.length,
      runs: runs.length,
      completedRuns: runs.filter((run) => run.status === "completed").length,
      limitStops: collected.threads.reduce(
        (sum, view) => sum + view.runs.filter((run) => limitFailureOf(view, run)).length,
        0,
      ),
      switches: collected.threads.reduce((sum, view) => {
        const ordered = [...view.runs].sort((x, y) => x.ordinal - y.ordinal);
        return (
          sum +
          ordered.filter(
            (run, index) => index > 0 && sourceOf(run) !== sourceOf(ordered[index - 1]),
          ).length
        );
      }, 0),
    },
  };
}
