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
 *   stop's reset, or `holdMs` when it names none (holds span threads, and a
 *   run that completes on the source ends them); and one stop starts at most
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
/** The server's automatic limit fallback: `limit-fallback:<thread>:[hop-N:]<run>`. */
const isAutomatic = (run) => (run.userMessageId ?? "").startsWith(LIMIT_FALLBACK_PREFIX);

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
  // Every message the rig sent ran (or still waits), in the order it was sent.
  const order = collected.dispatched
    .filter((entry) => entry.threadId === threadId)
    .map((entry) => entry.messageId);
  const heads = new Map(list.map((chain) => [chain.messageId, chain]));
  if (!busy)
    for (const messageId of order)
      if (!heads.has(messageId))
        violations.push({
          rule: "runs-once",
          threadId,
          runId: null,
          detail: `message ${messageId} was accepted but never ran`,
        });
  const ran = list.map((chain) => chain.messageId).filter((id) => order.includes(id));
  const expected = order.filter((id) => heads.has(id));
  if (ran.join("|") !== expected.join("|"))
    violations.push({
      rule: "runs-once",
      threadId,
      runId: null,
      detail: `messages ran as ${ran.join(", ")} but were sent as ${expected.join(", ")}`,
    });
  // Ordinals follow dispatch; the provider work must start in that order too.
  for (let index = 1; index < expected.length; index++) {
    const before = ms(heads.get(expected[index - 1]).runs[0].startedAt);
    const after = ms(heads.get(expected[index]).runs[0].startedAt);
    if (Number.isFinite(before) && Number.isFinite(after) && after < before)
      violations.push({
        rule: "runs-once",
        threadId,
        runId: heads.get(expected[index]).runs[0].id,
        detail: `message ${expected[index]} started before ${expected[index - 1]}, which was sent first`,
      });
  }
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
    // A disposed delivery is fine once the run that launched the worker stopped.
    const launcher = view.runs.find((run) => run.id === child.runId);
    if (state === "disposed" && launcher && ACTIVE.has(launcher.status))
      violations.push({
        rule: "result-delivered",
        threadId,
        runId: null,
        detail: `worker ${worker}'s delivery was disposed while the run that launched it still runs`,
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
  // Every launch the rig asked for made a worker, and no launch call failed.
  const wanted = collected.expectations?.workers?.[threadId];
  const busy = view.runs.some((run) => ACTIVE.has(run.status));
  const launched = (view.subagents ?? []).filter(
    (child) => child.origin === "app_owned" && /^CHAOS-RESULT /m.test(child.prompt ?? ""),
  ).length;
  if (wanted !== undefined && !busy)
    for (const child of view.subagents ?? [])
      if (
        child.origin === "app_owned" &&
        /^CHAOS-RESULT /m.test(child.prompt ?? "") &&
        !ENDED_CHILD.has(child.status)
      )
        violations.push({
          rule: "result-delivered",
          threadId,
          runId: null,
          detail: `worker ${child.childThreadId ?? child.id} is still ${child.status} while its launcher is idle`,
        });
  if (wanted !== undefined && !busy && launched !== wanted)
    violations.push({
      rule: "result-delivered",
      threadId,
      runId: null,
      detail: `the rig asked for ${wanted} workers and ${launched} were launched`,
    });
  for (const turn of collected.turns)
    if (sessions.has(turn.sessionId))
      for (const call of turn.calls ?? [])
        if (call.status !== 200 || call.error)
          violations.push({
            rule: "result-delivered",
            threadId,
            runId: null,
            detail: `the launcher's ${call.name ?? "MCP"} call failed (status ${call.status}${call.error ? `, ${call.error}` : ""})`,
          });
}

/**
 * Holds are per source (instance and model) across every thread, as 1460 holds
 * them machine-wide; a run that completes on the source is evidence of room and
 * ends its holds. Per thread, each limit stop may start one automatic fallback.
 */
function checkNoReturn(collected, holdMs, violations) {
  // One timeline over every thread: a start is checked against the holds in
  // force at that moment, a hold begins when its stop completes, and a run
  // ends the source's holds only if it started after the stop and completed.
  const events = [];
  for (const view of collected.threads)
    for (const run of view.runs) {
      events.push({ at: ms(run.requestedAt), order: 1, kind: "start", view, run });
      const end = ms(run.completedAt);
      if (!Number.isFinite(end)) continue;
      if (limitFailureOf(view, run)) events.push({ at: end, order: 0, kind: "stop", view, run });
      else if (run.status === "completed")
        events.push({ at: end, order: 0, kind: "room", view, run });
    }
  events.sort((x, y) => x.at - y.at || x.order - y.order || x.run.ordinal - y.run.ordinal);
  const holds = new Map();
  for (const { at, kind, view, run } of events) {
    const source = sourceOf(run);
    if (kind === "stop") {
      const reset = ms(limitFailureOf(view, run).resetAt);
      holds.set(source, [
        ...(holds.get(source) ?? []),
        {
          threadId: view.thread.id,
          ordinal: run.ordinal,
          stoppedAt: at,
          until: Number.isFinite(reset) ? reset : at + holdMs,
        },
      ]);
    } else if (kind === "room") {
      const started = ms(run.startedAt ?? run.requestedAt);
      holds.set(
        source,
        (holds.get(source) ?? []).filter((hold) => !(started > hold.stoppedAt)),
      );
    } else if (isAutomatic(run)) {
      const held = (holds.get(source) ?? []).find((hold) => at < hold.until);
      if (held)
        violations.push({
          rule: "no-return-before-reset",
          threadId: view.thread.id,
          runId: run.id,
          detail: `fallback run ${run.ordinal} went back to ${label(source)} ${Math.round((at - held.stoppedAt) / 1000)} s after run ${held.ordinal}${held.threadId === view.thread.id ? "" : ` of thread ${held.threadId}`} stopped there on a limit`,
        });
    }
  }
  for (const view of collected.threads) {
    const threadId = view.thread.id;
    let stop = null;
    const ids = new Map();
    for (const run of [...view.runs].sort((x, y) => x.ordinal - y.ordinal)) {
      if (isAutomatic(run)) {
        ids.set(run.userMessageId, (ids.get(run.userMessageId) ?? 0) + 1);
        if (stop === null || stop.used >= 1)
          violations.push({
            rule: "no-return-before-reset",
            threadId,
            runId: run.id,
            detail:
              stop === null
                ? `fallback run ${run.ordinal} started with no limit stop before it`
                : `limit stop of run ${stop.ordinal} started more than one fallback (run ${run.ordinal})`,
          });
        if (stop !== null) stop.used += 1;
      }
      if (limitFailureOf(view, run)) stop = { ordinal: run.ordinal, used: 0 };
      else if (run.status === "completed") stop = null;
    }
    for (const [messageId, count] of ids)
      if (count > 1)
        violations.push({
          rule: "no-return-before-reset",
          threadId,
          runId: null,
          detail: `fallback ${messageId} started ${count} runs`,
        });
  }
}

/** Checks one collection; returns the violations and a short summary. */
export function check(collected, { holdMs = DEFAULT_HOLD_MS } = {}) {
  const violations = [];
  const notes = [];
  for (const view of collected.threads) {
    checkRunsOnce(view, collected, violations, notes);
    checkResultDelivered(view, collected, violations);
  }
  checkNoReturn(collected, holdMs, violations);
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
