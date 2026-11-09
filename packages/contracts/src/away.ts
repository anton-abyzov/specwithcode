/**
 * Away mode: leave this machine and hand its threads, routines and
 * coordinators to an always-on machine. The preflight (`away.preflight`)
 * lists what would move, what stays and why, and every missing grant or
 * link, without changing anything. "Request access" sends every missing
 * item to the target as one pending request its owner approves there.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ProjectId } from "./baseSchemas.ts";
import { LogicalProjectMember, ProjectCoordinatorBinding } from "./logicalProject.ts";

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** The most rows a plan lists per kind; more are summarized, never sent. */
export const AWAY_PLAN_MAX_ITEMS = 300;
/** The most missing items one access request carries. */
export const AWAY_ACCESS_MAX_MISSING = 100;

/**
 * What the target still needs before work can move there:
 * - `work-grant`: the target does not let this machine run work there, or its
 *   grant leaves the project out.
 * - `routines`: the grant does not let this machine's coordinator manage routines.
 * - `project-link`: the project has no linked copy on the target.
 * - `provider`: a sign-in or model a thread needs is missing there.
 * - `secret-file`: a file such as `.env.local` is missing there.
 * - `standby`: the target cannot take over the project's coordinator.
 */
export const AwayMissingGrantKind = Schema.Literals([
  "work-grant",
  "routines",
  "project-link",
  "provider",
  "secret-file",
  "standby",
]);
export type AwayMissingGrantKind = typeof AwayMissingGrantKind.Type;

export const AwayMissingGrant = Schema.Struct({
  kind: AwayMissingGrantKind,
  /** The machine that has to change something: the target, or this machine for its own steps. */
  machineEnvironmentId: EnvironmentId,
  machineLabel: bounded(120),
  /** This machine's copy of the project, when the item is about one project. */
  projectId: Schema.optionalKey(ProjectId),
  projectTitle: Schema.optionalKey(bounded(500)),
  /** What is missing, in the user's words: "Ministorm: no .env.local". */
  detail: bounded(500),
  /** The one step that fixes it: "Turn on Routines for M4 in Settings > Machines on Ministorm". */
  fix: bounded(500),
});
export type AwayMissingGrant = typeof AwayMissingGrant.Type;

export const AwayPlanItemKind = Schema.Literals(["thread", "routine", "coordinator"]);
export type AwayPlanItemKind = typeof AwayPlanItemKind.Type;

/**
 * - `move`: goes to the target.
 * - `handoff-ready`: a check failed; it stays here, marked ready to continue elsewhere.
 * - `stay`: never leaves this machine (a worktree set, the personal assistant).
 * - `pause`: paused here while away and listed (a webhook routine).
 */
export const AwayPlanAction = Schema.Literals(["move", "handoff-ready", "stay", "pause"]);
export type AwayPlanAction = typeof AwayPlanAction.Type;

export const AwayPlanItem = Schema.Struct({
  kind: AwayPlanItemKind,
  /** A thread id, a routine id, or the project id for a coordinator. */
  id: bounded(512),
  title: bounded(500),
  projectId: Schema.optionalKey(ProjectId),
  action: AwayPlanAction,
  reason: bounded(500),
});
export type AwayPlanItem = typeof AwayPlanItem.Type;

export const AwayPlan = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  targetLabel: bounded(120),
  items: Schema.Array(AwayPlanItem),
  missingGrants: Schema.Array(AwayMissingGrant),
  /** Nothing missing: everything that can move, moves. */
  ready: Schema.Boolean,
  checkedAt: IsoDateTime,
});
export type AwayPlan = typeof AwayPlan.Type;

/** `live`: only projects with running or queued work or enabled routines (D-03). */
export const AwayCoordinatorScope = Schema.Literals(["live", "all"]);
export type AwayCoordinatorScope = typeof AwayCoordinatorScope.Type;

export const AwayPreflightInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  coordinatorScope: Schema.optionalKey(AwayCoordinatorScope),
});
export type AwayPreflightInput = typeof AwayPreflightInput.Type;

export const AwayAccessRequestInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  missing: Schema.Array(AwayMissingGrant).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AWAY_ACCESS_MAX_MISSING),
  ),
});
export type AwayAccessRequestInput = typeof AwayAccessRequestInput.Type;

export const AwayAccessRequestStatus = Schema.Literals([
  "sent",
  "already-pending",
  "approved",
  "declined",
]);
export type AwayAccessRequestStatus = typeof AwayAccessRequestStatus.Type;

export const AwayAccessRequestResult = Schema.Struct({
  requestId: bounded(128),
  status: AwayAccessRequestStatus,
  detail: bounded(1000),
});
export type AwayAccessRequestResult = typeof AwayAccessRequestResult.Type;

/** Asks the target how a request this machine sent stands. */
export const AwayAccessStatusInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  requestId: bounded(128),
});
export type AwayAccessStatusInput = typeof AwayAccessStatusInput.Type;

/**
 * A request another machine sent here, as this machine's owner sees it.
 * `changes` is what approving applies to that machine's work grant here;
 * the other items are steps the owner takes by hand.
 */
export const AwayAccessGrantChanges = Schema.Struct({
  routines: Schema.optionalKey(Schema.Boolean),
  /** This machine's projects added to that machine's listed grant projects. */
  addProjectIds: Schema.optionalKey(Schema.Array(ProjectId).check(Schema.isMaxLength(256))),
});
export type AwayAccessGrantChanges = typeof AwayAccessGrantChanges.Type;

export const AwayAccessRequestRecord = Schema.Struct({
  requestId: bounded(128),
  fromEnvironmentId: EnvironmentId,
  fromLabel: bounded(120),
  missing: Schema.Array(AwayMissingGrant).check(Schema.isMaxLength(AWAY_ACCESS_MAX_MISSING)),
  changes: AwayAccessGrantChanges,
  status: Schema.Literals(["pending", "approved", "declined"]),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  /** Why approving could not apply every change, when it could not. */
  detail: Schema.NullOr(bounded(1000)),
});
export type AwayAccessRequestRecord = typeof AwayAccessRequestRecord.Type;

export const AwayAccessRequestList = Schema.Struct({
  requests: Schema.Array(AwayAccessRequestRecord),
});
export type AwayAccessRequestList = typeof AwayAccessRequestList.Type;

export const AwayAccessDecisionInput = Schema.Struct({
  requestId: bounded(128),
  decision: Schema.Literals(["approve", "decline"]),
});
export type AwayAccessDecisionInput = typeof AwayAccessDecisionInput.Type;

export const AwayEmptyInput = Schema.Struct({});

export const AwayErrorCode = Schema.Literals([
  "invalid",
  "unknown_machine",
  "unreachable",
  "not_allowed",
  "not_found",
  "failed",
]);
export type AwayErrorCode = typeof AwayErrorCode.Type;

export class AwayError extends Schema.TaggedError<AwayError>()("AwayError", {
  code: AwayErrorCode,
  message: Schema.String,
}) {}

// --- Planned coordinator handover and the away intent (1267 T-04, AC-05, AC-09) ---

/** Where the target takes over a coordinator this machine hands it while awake. */
export const AWAY_HANDOVER_PATH = "/api/away/v1/handover";
/** Where the source records, before it sleeps, that the target should take over after a grace. */
export const AWAY_INTENT_PATH = "/api/away/v1/intent";
/** Where the source, back before the grace ran out, cancels its away intent. */
export const AWAY_INTENT_CANCEL_PATH = "/api/away/v1/intent/cancel";
/** Where the source, back, asks whether the target took over its projects (POST). */
export const AWAY_INTENT_STATUS_PATH = "/api/away/v1/intent/status";

/** The longest grace an away intent may ask for. */
export const AWAY_INTENT_MAX_GRACE_MINUTES = 240;

/** `away` hands a coordinator to the target; `back` hands it home again. */
export const AwayHandoverReason = Schema.Literals(["away", "back"]);
export type AwayHandoverReason = typeof AwayHandoverReason.Type;

export const AwayHandoverInput = Schema.Struct({
  /** This machine's copy of the project. */
  projectId: ProjectId,
  targetEnvironmentId: EnvironmentId,
  reason: AwayHandoverReason,
  /** Names the handover so a retry replays it; derived from the epoch when absent. */
  operationId: Schema.optionalKey(bounded(128)),
  /**
   * Only finish a handover this copy already gave way for (an in-doubt one);
   * never start a new one. Away's retry of an in-doubt handover sets it.
   */
  resumeOnly: Schema.optionalKey(Schema.Boolean),
});
export type AwayHandoverInput = typeof AwayHandoverInput.Type;

/**
 * - `handed-over`: the target coordinates now and this copy gave way.
 * - `skipped`: nothing to hand over (this copy does not coordinate the project).
 * - `failed`: the coordinator did not move; `detail` says why.
 * - `in-doubt`: this copy gave way and the target may have taken over; no copy
 *   coordinates until the same handover is tried again (`detail` says how).
 */
export const AwayHandoverOutcome = Schema.Literals([
  "handed-over",
  "skipped",
  "failed",
  "in-doubt",
]);
export type AwayHandoverOutcome = typeof AwayHandoverOutcome.Type;

export const AwayHandoverResult = Schema.Struct({
  projectId: ProjectId,
  outcome: AwayHandoverOutcome,
  detail: bounded(500),
  /** The coordinator epoch the target took over at. */
  epoch: Schema.optionalKey(Schema.Int),
  /** The handover's operation, so an in-doubt one is finished under the same id. */
  operationId: Schema.optionalKey(bounded(128)),
  /** This copy coordinates again: the target confirmed it never took the handover. */
  reverted: Schema.optionalKey(Schema.Boolean),
});
export type AwayHandoverResult = typeof AwayHandoverResult.Type;

export const AwayIntentRequest = Schema.Struct({
  /** The machine going away; must be the machine whose key made the request. */
  sourceEnvironmentId: EnvironmentId,
  graceMinutes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(AWAY_INTENT_MAX_GRACE_MINUTES),
  ),
  /** The source's copies whose coordinator the target takes over. */
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(AWAY_PLAN_MAX_ITEMS)),
  /** Source threads already replicated here, for the target to continue. */
  threadIds: Schema.Array(bounded(512)).check(Schema.isMaxLength(AWAY_PLAN_MAX_ITEMS)),
});
export type AwayIntentRequest = typeof AwayIntentRequest.Type;

export const AwayIntentCancelRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
});
export type AwayIntentCancelRequest = typeof AwayIntentCancelRequest.Type;

/**
 * - `waiting`: the grace runs.
 * - `cancelled`: the source came back first; nothing was done.
 * - `acting`: the grace ran out and the target is taking over; it can no longer be cancelled.
 * - `done`: the grace ran out and the target acted (see `results`).
 */
export const AwayIntentState = Schema.Literals(["waiting", "cancelled", "acting", "done"]);
export type AwayIntentState = typeof AwayIntentState.Type;

export const AwayIntentRecord = Schema.Struct({
  intentId: bounded(128),
  sourceEnvironmentId: EnvironmentId,
  graceMinutes: Schema.Int,
  projectIds: Schema.Array(ProjectId),
  threadIds: Schema.Array(bounded(512)),
  /** On the target's clock. */
  receivedAt: IsoDateTime,
  dueAt: IsoDateTime,
  state: AwayIntentState,
  cancelledAt: Schema.optionalKey(IsoDateTime),
  /** Why it was cancelled: the source asked, or it was heard awake. */
  cancelReason: Schema.optionalKey(bounded(200)),
  actedAt: Schema.optionalKey(IsoDateTime),
  /** One per source project, with the target's outcome. */
  results: Schema.optionalKey(Schema.Array(AwayHandoverResult)),
});
export type AwayIntentRecord = typeof AwayIntentRecord.Type;

/**
 * The target's answer to a cancel. `cancelled` counts the waiting intents it
 * cancelled; when the latest intent is already `acting` or `done` nothing is
 * cancelled and the source must ask `AWAY_INTENT_STATUS_PATH` and give way.
 */
export const AwayIntentCancelAnswer = Schema.Struct({
  cancelled: Schema.Int,
  state: Schema.optionalKey(Schema.NullOr(AwayIntentState)),
  takenOver: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type AwayIntentCancelAnswer = typeof AwayIntentCancelAnswer.Type;

export const AwayIntentStatusRequest = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  /** The source's copies to report on. */
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(AWAY_PLAN_MAX_ITEMS)),
  /** The source's threads to report on: whether the target continued each. */
  threadIds: Schema.optionalKey(
    Schema.Array(bounded(512)).check(Schema.isMaxLength(AWAY_PLAN_MAX_ITEMS)),
  ),
});
export type AwayIntentStatusRequest = typeof AwayIntentStatusRequest.Type;

/**
 * One source project: whether the target's copy took over from the source.
 * When it did, the binding and the target's member let the source give way.
 */
export const AwayIntentProjectStatus = Schema.Struct({
  projectId: ProjectId,
  takenOver: Schema.Boolean,
  epoch: Schema.optionalKey(Schema.Int),
  coordinatorBinding: Schema.optionalKey(ProjectCoordinatorBinding),
  successor: Schema.optionalKey(LogicalProjectMember),
});
export type AwayIntentProjectStatus = typeof AwayIntentProjectStatus.Type;

/** One source thread: the thread that continues it on the target, or null. */
export const AwayIntentThreadStatus = Schema.Struct({
  threadId: bounded(512),
  continuedThreadId: Schema.NullOr(bounded(512)),
});
export type AwayIntentThreadStatus = typeof AwayIntentThreadStatus.Type;

export const AwayIntentStatusAnswer = Schema.Struct({
  /** The state of the source's latest intent here, or null without one. */
  intentState: Schema.NullOr(AwayIntentState),
  projects: Schema.Array(AwayIntentProjectStatus),
  /** The asked threads; absent from targets that predate it. */
  threads: Schema.optionalKey(Schema.Array(AwayIntentThreadStatus)),
  /**
   * Nothing more will continue: the latest intent is settled and its
   * follow-up finished, so a thread not continued now never will be.
   */
  threadsSettled: Schema.optionalKey(Schema.Boolean),
  /** The target's own receive time. */
  receivedAt: IsoDateTime,
});
export type AwayIntentStatusAnswer = typeof AwayIntentStatusAnswer.Type;

// --- The sleep trigger and the wake prompt (1267 T-06, AC-09, D-01, D-02) ---

/** The desktop main process tells its own server the Mac is about to sleep. */
export const AWAY_SLEEP_PATH = "/api/away/v1/sleep";
/** The desktop main process tells its own server the Mac woke or was unlocked. */
export const AWAY_WAKE_PATH = "/api/away/v1/wake";

/** When a lid close leaves for the Away target: never, only on battery, or always (D-01). */
export const AwaySleepTrigger = Schema.Literals(["off", "on-battery", "always"]);
export type AwaySleepTrigger = typeof AwaySleepTrigger.Type;

/** What waking does after work left: ask, bring it back on power, or nothing (D-02). */
export const AwayBringBack = Schema.Literals(["prompt", "auto-on-power", "manual"]);
export type AwayBringBack = typeof AwayBringBack.Type;

export const AWAY_GRACE_MIN_MINUTES = 1;
export const AWAY_GRACE_MAX_MINUTES = 15;
export const AwayGraceMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(AWAY_GRACE_MIN_MINUTES),
  Schema.isLessThanOrEqualTo(AWAY_GRACE_MAX_MINUTES),
);

/**
 * Away mode's settings. The target is `HandoffConfig.sleepTarget` (D-04); the
 * other keys are stored next to it in `handoff-mode.json`.
 */
export interface AwayConfig {
  readonly target: EnvironmentId | null;
  readonly sleepTrigger: AwaySleepTrigger;
  readonly graceMinutes: number;
  readonly bringBack: AwayBringBack;
  readonly coordinatorScope: AwayCoordinatorScope;
}

export const DEFAULT_AWAY_SLEEP_TRIGGER: AwaySleepTrigger = "on-battery";
export const DEFAULT_AWAY_GRACE_MINUTES = 2;
export const DEFAULT_AWAY_BRING_BACK: AwayBringBack = "prompt";

export const AwaySleepRequest = Schema.Struct({
  onBattery: Schema.Boolean,
});
export type AwaySleepRequest = typeof AwaySleepRequest.Type;

/**
 * - `left`: Away handles this sleep; the old "move running threads" path must not run too.
 * - `skipped`: no target, the trigger is off, or on power with "On battery".
 */
export const AwaySleepAnswer = Schema.Struct({
  outcome: Schema.Literals(["left", "skipped"]),
});
export type AwaySleepAnswer = typeof AwaySleepAnswer.Type;

export const AwayWakeRequest = Schema.Struct({
  onBattery: Schema.Boolean,
});
export type AwayWakeRequest = typeof AwayWakeRequest.Type;

/**
 * - `none`: nothing had left, or it came back before the grace ran out.
 * - `prompt`: work moved while asleep; show the wake card.
 * - `auto`: work moved and bringing it back started on its own.
 */
export const AwayWakeAnswer = Schema.Struct({
  outcome: Schema.Literals(["none", "prompt", "auto"]),
});
export type AwayWakeAnswer = typeof AwayWakeAnswer.Type;

/**
 * This machine's own record of a lid-close Away:
 * - `pending-intent`: the intent was sent; the target acts after `dueAt`.
 * - `send-uncertain`: the send got no answer; the target may hold the intent.
 * - `send-failed`: the target refused it; nothing moves.
 * - `wake-prompt`: back after the grace; work moved and waits for Bring back.
 */
export const AwaySleepSessionState = Schema.Literals([
  "pending-intent",
  "send-uncertain",
  "send-failed",
  "wake-prompt",
]);
export type AwaySleepSessionState = typeof AwaySleepSessionState.Type;

export const AwaySleepSession = Schema.Struct({
  state: AwaySleepSessionState,
  targetEnvironmentId: EnvironmentId,
  graceMinutes: Schema.Int,
  projectIds: Schema.Array(ProjectId),
  threadIds: Schema.Array(bounded(512)),
  /** On this machine's clock. */
  sentAt: IsoDateTime,
  dueAt: IsoDateTime,
  wokeAt: Schema.optionalKey(IsoDateTime),
  detail: Schema.optionalKey(bounded(500)),
  /** Since when the wake check gets no answer from the target; cleared by one. */
  unreachableSince: Schema.optionalKey(IsoDateTime),
  /** The owner chose Run here anyway: the hold was lifted for these projects. */
  forcedLocalAt: Schema.optionalKey(IsoDateTime),
  forcedProjectIds: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type AwaySleepSession = typeof AwaySleepSession.Type;

// --- The Away session: leaving and Bring back (1267 T-05, AC-04, AC-06, AC-07, AC-08) ---

/** Where this machine stages, enables and takes back a routine on the target (ScheduledTaskTransfer). */
export const AWAY_ROUTINES_PATH = "/api/away/v1/routines";
/** Where the source asks the target to hand the threads it continued back (Bring back). */
export const AWAY_RETURN_PATH = "/api/away/v1/return";

/** The most items one session records. */
export const AWAY_SESSION_MAX_ITEMS = 3 * AWAY_PLAN_MAX_ITEMS;

/** What started the session: the Leave button or a lid close (AC-09). */
export const AwayTrigger = Schema.Literals(["manual", "sleep"]);
export type AwayTrigger = typeof AwayTrigger.Type;

/**
 * - `pending`: not reached yet; a resumed session picks it up.
 * - `moved`: on the target now.
 * - `handoff-ready`: a check failed; it stays here, ready to continue elsewhere.
 * - `stayed`: never leaves (a worktree set, the personal assistant, no link).
 * - `paused`: paused here while away (a webhook routine).
 * - `failed`: the move did not finish; `detail` says what is left.
 * - `in-doubt`: a coordinator this copy gave way for and the target did not
 *   confirm; no copy coordinates until the same handover is finished (Leave
 *   again, or the retry every minute) or the target confirms it never got it.
 */
export const AwayItemOutcome = Schema.Literals([
  "pending",
  "moved",
  "handoff-ready",
  "stayed",
  "paused",
  "failed",
  "in-doubt",
]);
export type AwayItemOutcome = typeof AwayItemOutcome.Type;

/** What Bring back did with one item. */
export const AwayBackOutcome = Schema.Literals(["returned", "stayed", "failed"]);
export type AwayBackOutcome = typeof AwayBackOutcome.Type;

export const AwayItemBack = Schema.Struct({
  outcome: AwayBackOutcome,
  detail: bounded(500),
  at: IsoDateTime,
  /** The thread here that continues it, when a thread came back. */
  localId: Schema.optionalKey(bounded(512)),
});
export type AwayItemBack = typeof AwayItemBack.Type;

export const AwayItemResult = Schema.Struct({
  kind: AwayPlanItemKind,
  /** This machine's thread, routine or project id. */
  id: bounded(512),
  title: bounded(500),
  projectId: Schema.optionalKey(ProjectId),
  outcome: AwayItemOutcome,
  detail: bounded(500),
  /** On the target: the continuing thread, the routine's copy, or the project's copy. */
  targetId: Schema.optionalKey(bounded(512)),
  /** Routines: how it moved (`coordinator` rides the handover; `transfer`; `paused` here). */
  via: Schema.optionalKey(Schema.Literals(["coordinator", "transfer", "paused"])),
  /** Routines: whether it was on before Away turned it off here. */
  wasEnabled: Schema.optionalKey(Schema.Boolean),
  /** Coordinators: the standby this copy had before it left, re-armed on Bring back. */
  standbyAfterMinutes: Schema.optionalKey(Schema.Int),
  /** Coordinators: the planned handover's operation, finished under the same id. */
  operationId: Schema.optionalKey(bounded(128)),
  back: Schema.optionalKey(AwayItemBack),
});
export type AwayItemResult = typeof AwayItemResult.Type;

/** The stage a session reached; each stage resumes from the items it saved. */
export const AwayStage = Schema.Literals([
  "coordinators",
  "routines",
  "threads",
  "done",
  // A lid close: the intent is with the target and nothing ran here yet (`sleep` says more).
  "pending-intent",
]);
export type AwayStage = typeof AwayStage.Type;

/**
 * One Away, kept in `handoff-mode.json` on the machine that left. It survives
 * a restart: an unfinished one resumes at its stage. Bring back records each
 * item's `back` and then `broughtBackAt`.
 */
export const AwaySession = Schema.Struct({
  sessionId: bounded(128),
  targetEnvironmentId: EnvironmentId,
  targetLabel: bounded(120),
  trigger: AwayTrigger,
  coordinatorScope: AwayCoordinatorScope,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  stage: AwayStage,
  items: Schema.Array(AwayItemResult).check(Schema.isMaxLength(AWAY_SESSION_MAX_ITEMS)),
  bringBackStartedAt: Schema.NullOr(IsoDateTime),
  broughtBackAt: Schema.NullOr(IsoDateTime),
  /** A lid close (`trigger: "sleep"`): the intent sent, its grace and what the wake found. */
  sleep: Schema.optionalKey(AwaySleepSession),
  /** Only on an answer: another start or Bring back was already running; this is its session. */
  alreadyRunning: Schema.optionalKey(Schema.Boolean),
});
export type AwaySession = typeof AwaySession.Type;

export const AwayStartInput = Schema.Struct({
  targetEnvironmentId: EnvironmentId,
  coordinatorScope: Schema.optionalKey(AwayCoordinatorScope),
  trigger: Schema.optionalKey(AwayTrigger),
});
export type AwayStartInput = typeof AwayStartInput.Type;

export const AwayBringBackInput = Schema.Struct({
  /** The session to bring back; the latest when absent. */
  sessionId: Schema.optionalKey(bounded(128)),
});

/** Run here anyway: lifts the wake hold for projects whose status is unknown. */
export const AwayForceLocalInput = Schema.Struct({
  sessionId: Schema.optionalKey(bounded(128)),
});
export type AwayForceLocalInput = typeof AwayForceLocalInput.Type;

/** How long the target must stay silent after a wake before Run here anyway is offered. */
export const AWAY_FORCE_LOCAL_AFTER_MS = 10 * 60_000;

/**
 * Whether the wake card and the Away dialog offer Run here anyway: a lid
 * close still waits for its target's answer, and the target has not answered
 * for `AWAY_FORCE_LOCAL_AFTER_MS`.
 */
export function canRunHereAnyway(session: AwaySession | null, nowMs: number): boolean {
  const since = session?.sleep?.unreachableSince;
  if (session === null || session.stage !== "pending-intent" || since === undefined) return false;
  // Already chosen for this session: nothing is held any more.
  if (session.sleep?.forcedLocalAt !== undefined) return false;
  const at = Date.parse(since);
  return Number.isFinite(at) && nowMs - at >= AWAY_FORCE_LOCAL_AFTER_MS;
}
export type AwayBringBackInput = typeof AwayBringBackInput.Type;

/** Away's settings as clients read and change them (D-01 to D-04). */
export const AwaySettings = Schema.Struct({
  target: Schema.NullOr(EnvironmentId),
  sleepTrigger: AwaySleepTrigger,
  graceMinutes: AwayGraceMinutes,
  bringBack: AwayBringBack,
  coordinatorScope: AwayCoordinatorScope,
});
export type AwaySettings = typeof AwaySettings.Type;

export const AwaySettingsPatch = Schema.Struct({
  target: Schema.optionalKey(Schema.NullOr(EnvironmentId)),
  sleepTrigger: Schema.optionalKey(AwaySleepTrigger),
  graceMinutes: Schema.optionalKey(AwayGraceMinutes),
  bringBack: Schema.optionalKey(AwayBringBack),
  coordinatorScope: Schema.optionalKey(AwayCoordinatorScope),
});
export type AwaySettingsPatch = typeof AwaySettingsPatch.Type;

export const AwaySnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: bounded(120),
  settings: AwaySettings,
  /** The latest session this machine left with, or null. */
  session: Schema.NullOr(AwaySession),
  /** A start or Bring back runs now. */
  running: Schema.Boolean,
});
export type AwaySnapshot = typeof AwaySnapshot.Type;

/** The wake card shows for a session that left from this machine and is not back. */
export function awaitsBringBack(session: AwaySession | null): boolean {
  return (
    session !== null &&
    session.broughtBackAt === null &&
    session.items.some(
      (item) =>
        item.outcome === "moved" || item.outcome === "paused" || item.outcome === "in-doubt",
    )
  );
}
