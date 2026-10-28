import type {
  ServerPrepareServiceUpdateResult,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";

import {
  hasPendingRequest,
  isPendingRequestLive,
  isWaitingPhase,
  newerRequestPending,
  refusedAfterWithdrawal,
  writtenAt,
} from "./serviceUpdateAgent";
import {
  callPrepare,
  pendingWithdrawal,
  QUICK_CALL_MS,
  readAgentState,
  STOP_WORK_TIMEOUT_MS,
} from "./serviceUpdateCalls";
import {
  advanceServiceUpdateProgress,
  isRestartRefusalWithRelease,
  markServiceRestarted,
  type ServiceUpdateProgress,
} from "./sidebar/SidebarRestartToUpdate.logic";

/**
 * How "Update now" holds the service's work for its request, and holds it
 * again: once the agent has the release the press's hold was refused for,
 * and after update.py restarted the service under the request (the new
 * process holds nothing). Each time the same request is written again under
 * the new hold, since the agent's helpers act on a forced request only from
 * inside the hold it was written in. Also lets go of a hold a stop took after
 * its attempt ended.
 */

/** What the toast says when this window's hold ran out before the install began. */
export const SERVICE_HOLD_ENDED = "Work did not finish in time. Choose Update now to try again.";
// A hold lost this close to its end is not taken again: it ran out (the
// service's own hold can end a little before the request's), or too little
// of it is left for the install.
const HOLD_AGAIN_MARGIN_MS = 60_000;
// A service that keeps restarting has its work held again this many times
// for one request; after that the window only follows the request.
const MAX_RESTART_HOLDS = 3;

/** What the re-hold needs of the window's update flow, which binds it once. */
export interface ReholdFlow {
  /** The attempt under way; each attempt (and each cancel) bumps it. */
  readonly attempt: () => number;
  readonly progress: () => ServiceUpdateProgress | null;
  /** This window asks for its own request, rather than only following one. */
  readonly asks: () => boolean;
  readonly cancelling: () => boolean;
  /** The agent's state this window last read or was published. */
  readonly lastAgent: () => StudioServiceUpdateState | null;
  readonly sawAgent: (agent: StudioServiceUpdateState) => void;
  readonly updateProgress: (
    change: (progress: ServiceUpdateProgress) => ServiceUpdateProgress | null,
  ) => void;
  readonly endAttempt: () => void;
  /** Saves this window's request, as now asked for, so a reload can take it up again. */
  readonly rememberOwnRequest: () => void;
  readonly sendInstallRequest: () => Promise<StudioServiceUpdateState | null>;
}

let flow!: ReholdFlow;

export function bindReholdFlow(bound: ReholdFlow): void {
  flow = bound;
}

/** What this window knows of the service's hold for its request. */
export const hold = {
  /**
   * The service reported held for this window's own request; once it no
   * longer is, the update was cancelled elsewhere (or the hold ran out).
   */
  seen: false,
  /**
   * The service refused to hold this request's work (its agent had not found
   * the release yet); it is asked again, once, when the agent has it.
   */
  refused: false,
  askedAgain: false,
  /** That second stop was refused too. */
  refusedAgain: false,
  /** When the request was first written again under a hold taken after the refusal. */
  askedUnderHoldAt: null as number | null,
  /**
   * The service restarted under this window's request: the attempt whose work
   * is being held again (looks wait for that stop), and how often that was done.
   */
  reholding: null as number | null,
  restarts: 0,
  /** The install request being written again; a check asks once more only after it. */
  requestInFlight: null as Promise<void> | null,
  /**
   * The press's stop got no answer, and no look has found the work held
   * since: nothing says the service ever held it, or restarted.
   */
  pressUnanswered: false,
};

/** A new attempt: nothing is known yet of the hold its stop takes. */
export function resetHold(): void {
  hold.seen = false;
  hold.refused = false;
  hold.askedAgain = false;
  hold.refusedAgain = false;
  hold.askedUnderHoldAt = null;
  hold.restarts = 0;
  hold.pressUnanswered = false;
}

/** Forgets everything, for tests. */
export function resetHoldForTests(): void {
  resetHold();
  hold.reholding = null;
  hold.requestInFlight = null;
}

/**
 * A stop and hold answered after its attempt ended (cancelled, failed or
 * withdrawn elsewhere): the hold it took serves no request, and the service
 * would refuse new work until it lapses. It is let go unless an update this
 * window shows still needs it, the desktop reports a request pending (one a
 * window still asks for holds the work for it), the agent cannot be read, or
 * it installs.
 */
export async function releaseStrayHold(prepared: ServerPrepareServiceUpdateResult | null) {
  if (prepared?.held !== true) return;
  const agent = await readAgentState();
  const progress = flow.progress();
  if (progress !== null && progress.phase !== "failed") return;
  if (!holdServesNothing(agent)) return;
  await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
}

/** The agent was read, installs nothing, and the desktop reports no request pending. */
function holdServesNothing(agent: StudioServiceUpdateState | null): boolean {
  return agent !== null && agent.status !== "installing" && !hasPendingRequest(agent);
}

/**
 * The hold a stop took for an attempt that ended since, as when a read of the
 * agent saw another window's Cancel first. A look may already show that hold
 * as an update to follow, so only a press made again in this window keeps it,
 * besides what keeps any stray hold.
 */
async function releaseEndedHold(): Promise<void> {
  const agent = await readAgentState();
  if (!holdServesNothing(agent)) return;
  if (flow.asks() || flow.progress()?.phase === "stopping") return;
  await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
}

/**
 * The agent refused this window's request for a fault only a held request
 * gets past (update.py restarts the service for one) before the window held
 * the work for it: the service refused the press's hold while its agent lacked
 * the release. That answers the unheld request: the window holds the work and
 * asks again (see holdOnceAgentHasRelease), and the refusal stands only once
 * that hold is refused too, or when the agent wrote it after the request was
 * asked again under the hold (not in the very millisecond it was asked: the
 * agent had not read it then).
 */
export function refusedBeforeHeld(agent: StudioServiceUpdateState | null): boolean {
  if (!hold.refused || hold.refusedAgain || !flow.asks() || flow.cancelling()) return false;
  if (agent === null || !hasPendingRequest(agent) || !isRestartRefusalWithRelease(agent)) {
    return false;
  }
  const written = writtenAt(agent) ?? Number.POSITIVE_INFINITY;
  return written <= (hold.askedUnderHoldAt ?? Number.POSITIVE_INFINITY);
}

/**
 * The service holds work only for a release its agent has found, so a press
 * made before the agent fetched it stopped the work without holding it. Once
 * the agent has it for this request (or refused the unheld request for want
 * of the hold), stop and hold again, once.
 */
export function holdOnceAgentHasRelease(agent: StudioServiceUpdateState, current: number) {
  const progress = flow.progress();
  if (!hold.refused || hold.seen || hold.askedAgain || !flow.asks() || flow.cancelling()) {
    return;
  }
  if (!isWaitingPhase(progress) || progress?.requestedAt === undefined) return;
  const hasRelease = agent.status === "downloaded" || agent.status === "waiting-for-quiet";
  if (!hasRelease && !isRestartRefusalWithRelease(agent)) return;
  // Only the agent's answer to this request: an older state says nothing new.
  const written = typeof agent.updatedAt === "string" ? Date.parse(agent.updatedAt) : Number.NaN;
  if (!Number.isFinite(written) || written < progress.requestedAt) return;
  // The desktop reports no request any more (it lapsed): nothing to hold the work for.
  if (!hasPendingRequest(agent)) return;
  hold.askedAgain = true;
  void callPrepare({ stopWork: true, hold: true, reason: "install" }, STOP_WORK_TIMEOUT_MS).then(
    (prepared) => {
      // The attempt ended (or failed) while the work stopped.
      if (current !== flow.attempt() || flow.progress()?.phase === "failed") {
        void releaseStrayHold(prepared);
        return;
      }
      // No answer: the stop may have held the work before update.py restarted
      // the service under it. A look that finds nothing held holds it again.
      if (prepared === null) {
        hold.seen = true;
        return;
      }
      hold.seen = prepared.held === true;
      hold.refusedAgain = prepared.held === false;
      // Saved only once the stop answered, with its answer: a reload that cut
      // the stop off (the service then lets its hold go) asks for the hold again.
      flow.rememberOwnRequest();
      flow.updateProgress((latest) => ({ ...latest, blockers: prepared.blockers }));
      // The hold began after the request was written, and the agent's helpers
      // act on a forced request only from inside the hold it was written in:
      // write the same request again, now under the hold.
      if (hold.seen) askAgain(current, prepared);
    },
  );
}

/** This window's hold ran out before the install began: say so, keeping the app's install. */
export function holdEnded() {
  hold.seen = false;
  flow.updateProgress((progress) => ({
    ...progress,
    phase: "failed",
    message: SERVICE_HOLD_ENDED,
  }));
}

/**
 * The service no longer holds the request this window waits on. When the
 * desktop still reports it pending, the service restarted (update.py restarts
 * one that lost its database, for a held request) and the new process holds
 * nothing, so the agent's helpers would not act on the request: the window
 * that wrote it stops and holds the work again, then writes the same request
 * again under the new hold, as holdOnceAgentHasRelease does, and the app's
 * install still follows. A window that only follows it keeps following, as
 * the writer does once it held the work again this often. A request withdrawn
 * or overtaken (in another window) ends the attempt, as a lost hold always
 * did. The agent is read afresh first, so a Cancel made meanwhile is never
 * undone.
 */
export async function holdRestartedService(current: number): Promise<void> {
  hold.reholding = current;
  try {
    const agent = await readAgentState();
    // No answer: the next look tries again.
    if (current !== flow.attempt() || agent === null) return;
    flow.sawAgent(agent);
    // Cancelled in another window before the agent's pass refused it: quietly.
    if (refusedAfterWithdrawal(agent, flow.progress(), Date.now())) {
      flow.endAttempt();
      return;
    }
    flow.updateProgress((progress) => advanceServiceUpdateProgress(progress, agent, Date.now()));
    const progress = flow.progress();
    // It installs, failed, or lapsed and was renewed meanwhile.
    if (current !== flow.attempt() || progress === null || !isWaitingPhase(progress)) return;
    if (!isPendingRequestLive(agent) || newerRequestPending(agent, progress)) {
      flow.endAttempt();
      return;
    }
    if (!flow.asks()) return;
    // Held again this often: the window only follows the request now, and no
    // longer says it holds the work again.
    if (hold.restarts >= MAX_RESTART_HOLDS) {
      flow.updateProgress((latest) => markServiceRestarted(latest, false));
      return;
    }
    if (Date.now() >= (progress.holdUntil ?? Number.POSITIVE_INFINITY) - HOLD_AGAIN_MARGIN_MS) {
      holdEnded();
      return;
    }
    hold.restarts += 1;
    // After a press whose stop got no answer, nothing says the service held
    // the work, or restarted: the toast does not say it did.
    const unanswered = hold.pressUnanswered;
    hold.pressUnanswered = false;
    if (!unanswered) flow.updateProgress((latest) => markServiceRestarted(latest, true));
    const prepared = await callPrepare(
      { stopWork: true, hold: true, reason: "install" },
      STOP_WORK_TIMEOUT_MS,
    );
    if (current !== flow.attempt() || !isWaitingPhase(flow.progress())) {
      void releaseStrayHold(prepared);
      return;
    }
    // Refused, nothing holds the work for the request, and the agent waits
    // for a quiet moment on its own. Without an answer the stop may have held
    // it, and a later look that finds nothing held holds it again.
    hold.seen = prepared?.held !== false;
    // Refused now, the press's stop was most likely refused too (its agent
    // lacked the release): the work is held once the agent has it.
    if (unanswered && prepared?.held === false) hold.refused = true;
    if (prepared !== null) {
      flow.updateProgress((latest) => ({
        ...markServiceRestarted(latest, false),
        blockers: prepared.blockers,
      }));
    }
    // The same request, written again under the new hold.
    if (hold.seen) askAgain(current, prepared);
  } finally {
    if (hold.reholding === current) hold.reholding = null;
  }
}

/**
 * Asks the agent again. It does not wait for a request still being written:
 * the desktop stamps each request as it takes it, so the newest one is the
 * one the agent acts on. `prepared` is the hold just taken for it, if any.
 */
export function askAgain(
  current: number,
  prepared: ServerPrepareServiceUpdateResult | null = null,
): void {
  const sent = requestAgain(current, prepared);
  hold.requestInFlight = sent;
  void sent.finally(() => {
    if (hold.requestInFlight === sent) hold.requestInFlight = null;
  });
}

/** This window may still ask the agent again for its own request of attempt `current`. */
function mayAskAgain(current: number): boolean {
  const lastAgent = flow.lastAgent();
  return (
    current === flow.attempt() &&
    !flow.cancelling() &&
    flow.asks() &&
    isWaitingPhase(flow.progress()) &&
    // A request the desktop no longer reports was withdrawn: asking again would undo that.
    (lastAgent === null || hasPendingRequest(lastAgent))
  );
}

/**
 * Asks the agent again, after any withdrawal being written, as `run` does.
 * Another window may have withdrawn the request since this window last read
 * the agent, so the agent is read afresh first: a request withdrawn meanwhile
 * ends the attempt and lets go of the hold taken for it, instead of being
 * written again over that Cancel.
 */
async function requestAgain(
  current: number,
  prepared: ServerPrepareServiceUpdateResult | null,
): Promise<void> {
  await pendingWithdrawal();
  if (!mayAskAgain(current)) {
    endWithdrawnUnderHold(current, prepared);
    return;
  }
  const agent = await readAgentState();
  const progress = flow.progress();
  if (!mayAskAgain(current) || progress === null) {
    endWithdrawnUnderHold(current, prepared);
    return;
  }
  if (agent !== null && !hasPendingRequest(agent)) {
    // The agent's own answer (it let the request lapse, or failed) is left to
    // the next read; so is a hold that ran out. A refusal its pass wrote
    // before another window's Cancel is no such answer (see
    // refusedAfterWithdrawal): the attempt ends then too.
    const now = Date.now();
    const answered = advanceServiceUpdateProgress(progress, agent, now);
    const withdrawn =
      (isWaitingPhase(answered) && now < (progress.holdUntil ?? Number.POSITIVE_INFINITY)) ||
      refusedAfterWithdrawal(agent, progress, now);
    if (withdrawn) {
      flow.endAttempt();
      void releaseStrayHold(prepared);
    }
    return;
  }
  // The agent already installs for it, as no read had shown yet: written
  // again, the request is one the install never took up, left for the
  // agent's next pass to answer. The next read shows the install.
  if (advanceServiceUpdateProgress(progress, agent, Date.now()).phase === "installing") return;
  // What the agent writes from now on answers the request asked under the hold;
  // a reload from now on knows it was asked.
  if (hold.seen && hold.askedUnderHoldAt === null) {
    hold.askedUnderHoldAt = Date.now();
    flow.rememberOwnRequest();
  }
  await flow.sendInstallRequest().catch(() => null);
}

/**
 * The desktop stopped reporting this window's request (another window's
 * Cancel) while the stop that took `prepared`'s hold for it drained: asking
 * again would undo that Cancel, so the attempt ends and lets the hold go.
 */
function endWithdrawnUnderHold(
  current: number,
  prepared: ServerPrepareServiceUpdateResult | null,
): void {
  const progress = flow.progress();
  const lastAgent = flow.lastAgent();
  if (prepared?.held !== true) return;
  // Ended meanwhile, as when a read saw the Cancel first.
  if (current !== flow.attempt()) {
    void releaseEndedHold();
    return;
  }
  if (!flow.asks() || !isWaitingPhase(progress)) return;
  if (lastAgent === null || hasPendingRequest(lastAgent)) return;
  flow.endAttempt();
  void releaseStrayHold(prepared);
}
