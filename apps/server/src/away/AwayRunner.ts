/**
 * Away mode's runner (1267 T-05, AC-04, AC-06, AC-07, AC-08). Leaving takes
 * the plan (`AwayPlanner`) and works through it in three stages, saving the
 * session after every item so a restart resumes where it stopped:
 *
 * 1. Coordinators: each project's coordinator by planned handover
 *    (CoordinatorPlannedHandover). Its own routines ride along with their
 *    run state; this copy's rest from then on.
 * 2. Routines: a webhook routine pauses here (its URL is this machine's). Any
 *    other routine that does not follow a coordinator moves by transfer
 *    (ScheduledTaskTransfer): off here before it is on there.
 * 3. Threads: every running or queued thread, handoff mode on or off, through
 *    the normal move with reason `away`, queued messages included. One that
 *    cannot move stays here, handoff-ready, with the reason; nothing is ever
 *    stopped with a user Stop. Then routines bound to a moved thread follow it.
 *
 * Every stage is idempotent: a moved thread answers "already continued", a
 * resumed handover finishes the one it started, and an item already settled
 * is skipped.
 *
 * Bring back reverses a session: the target hands the threads it continued
 * back, routines return with their state (paused ones turn on again),
 * coordinators come back by planned handover, and the target is re-armed as
 * this machine's standby. It never revokes a grant.
 *
 * On the target, `onIntentDue` (a lid close, AC-09) continues the threads the
 * sleeping machine replicated here, after AwayIntents took its coordinators.
 */
import {
  AwayError,
  type AwayHandoverInput,
  type AwayHandoverResult,
  type AwayItemBack,
  type AwayItemResult,
  type AwayPlan,
  type AwayPreflightInput,
  AwaySession,
  type AwaySettings,
  type AwaySettingsPatch,
  type AwaySnapshot,
  type AwayStartInput,
  AWAY_RETURN_PATH,
  awayConfigOf,
  type CoordinatorRoutineCopy,
  DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES,
  type EnvironmentId,
  type HandoffMachineThreadResult,
  type ProjectId,
  type ScheduledTask,
  ScheduledTaskUpsertInput,
  ThreadId,
  COORDINATOR_STANDBY_AFTER_MINUTES,
  type CoordinatorStandbyAfterMinutes,
  type HandoffConfigPatch,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { HandoffMode } from "../handoff/HandoffMode.ts";
import { CoordinatorPlannedHandover } from "../project/CoordinatorPlannedHandover.ts";
import { ProjectLink } from "../project/ProjectLink.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { routineCopyOf } from "../scheduledTasks/ScheduledTaskCopies.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import {
  awayPausedNote,
  isTransferredRoutine,
  ScheduledTaskTransfer,
  type TransferBackOutcome,
  type TransferOutcome,
} from "../scheduledTasks/ScheduledTaskTransfer.ts";
import { AwayIntents } from "./AwayIntents.ts";
import { AwayPeerError, type AwayPeerPost, makeAwayPeerPost } from "./awayPeerCall.ts";
import { AwayPlanner } from "./AwayPlanner.ts";
import { fillSleepThreads } from "./awaySleepSession.ts";
import {
  AWAY_RETURN_PROTOCOL_VERSION,
  AwayReturnResponse,
  type AwayReturnRequest,
} from "./awayReturnRoute.ts";

// --- the session in the handoff document --------------------------------------------

const decodeSession = Schema.decodeUnknownOption(AwaySession);
const encodeSession = Schema.encodeSync(AwaySession);

/** The saved session, or null when there is none or another version wrote it. */
export const awaySessionOf = (raw: unknown): AwaySession | null =>
  raw == null ? null : Option.getOrNull(decodeSession(raw));

const clip = (text: string, max = 500) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The session's first items, from the plan: what can never move is settled at once. */
export function sessionFromPlan(input: {
  readonly sessionId: string;
  readonly plan: AwayPlan;
  readonly trigger: AwaySession["trigger"];
  readonly coordinatorScope: AwaySession["coordinatorScope"];
  readonly startedAt: string;
}): AwaySession {
  const items = input.plan.items.map((item): AwayItemResult => {
    const base = {
      kind: item.kind,
      id: item.id,
      title: item.title,
      ...(item.projectId === undefined ? {} : { projectId: item.projectId }),
    };
    switch (item.action) {
      case "stay":
        return { ...base, outcome: "stayed", detail: item.reason };
      // A thread a check refused stays, ready; a routine or coordinator is still tried.
      case "handoff-ready":
        return item.kind === "thread"
          ? { ...base, outcome: "handoff-ready", detail: item.reason }
          : { ...base, outcome: "pending", detail: item.reason };
      case "move":
      case "pause":
        return { ...base, outcome: "pending", detail: item.reason };
    }
  });
  return {
    sessionId: input.sessionId,
    targetEnvironmentId: input.plan.targetEnvironmentId,
    targetLabel: input.plan.targetLabel,
    trigger: input.trigger,
    coordinatorScope: input.coordinatorScope,
    startedAt: input.startedAt,
    finishedAt: null,
    stage: "coordinators",
    items,
    bringBackStartedAt: null,
    broughtBackAt: null,
  };
}

/** Not brought back yet: never tried, or the last try failed (Bring back tries again). */
const awaitsReturn = (item: AwayItemResult) =>
  item.back === undefined || item.back.outcome === "failed";

/** Whether a session still has work on the target that Bring back must undo. */
export function hasWorkAway(session: AwaySession): boolean {
  return session.items.some(
    (item) =>
      awaitsReturn(item) &&
      (item.outcome === "moved" ||
        item.outcome === "paused" ||
        (item.outcome === "failed" && item.via === "transfer" && item.wasEnabled === true)),
  );
}

const standbyMinutes = (value: number | undefined): CoordinatorStandbyAfterMinutes =>
  (COORDINATOR_STANDBY_AFTER_MINUTES as ReadonlyArray<number>).includes(value ?? -1)
    ? (value as CoordinatorStandbyAfterMinutes)
    : (DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES as CoordinatorStandbyAfterMinutes);

// --- the core, over small ports so the order is tested without a server ------------------

export interface AwayThreadReturn {
  readonly threadId: string;
  readonly outcome: "moved" | "stayed" | "skipped";
  readonly detail: string | null;
  readonly continuedThreadId: string | null;
}

export interface AwayRunnerDeps {
  readonly selfEnvironmentId: EnvironmentId;
  readonly loadSession: Effect.Effect<AwaySession | null>;
  readonly saveSession: (session: AwaySession) => Effect.Effect<void>;
  readonly plan: (input: AwayPreflightInput) => Effect.Effect<AwayPlan, AwayError>;
  readonly now: Effect.Effect<string>;
  readonly newId: Effect.Effect<string>;
  /** Runs leaving or Bring back after the call answered. Tests run it in place. */
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  // coordinators
  readonly handOver: (input: AwayHandoverInput) => Effect.Effect<AwayHandoverResult>;
  /** The standby delay this copy had armed, read before it leaves. */
  readonly standbyMinutesOf: (projectId: ProjectId) => Effect.Effect<number | undefined>;
  /** Re-arms `target` as this copy's standby; null when done, else why not. */
  readonly rearm: (
    projectId: ProjectId,
    target: EnvironmentId,
    afterMinutes: CoordinatorStandbyAfterMinutes,
  ) => Effect.Effect<string | null>;
  // routines
  readonly routines: Effect.Effect<ReadonlyArray<ScheduledTask>>;
  readonly routineCopy: (task: ScheduledTask) => CoordinatorRoutineCopy | null;
  readonly transferOut: (input: {
    readonly task: ScheduledTask;
    readonly target: EnvironmentId;
    readonly targetLabel: string;
    readonly copy: CoordinatorRoutineCopy;
    readonly boundThreadId: string | null;
  }) => Effect.Effect<TransferOutcome>;
  readonly transferBack: (input: {
    readonly task: Pick<ScheduledTask, "id" | "projectId">;
    readonly target: EnvironmentId;
    readonly targetLabel: string;
    readonly wasEnabled: boolean;
  }) => Effect.Effect<TransferBackOutcome>;
  /** Turns a routine off here with a note (true) or back on and clears it (false). */
  readonly pauseHere: (taskId: string, note: string | null) => Effect.Effect<boolean>;
  /** Points a routine here at another thread (a worker that came back under a new id). */
  readonly rebind: (taskId: string, threadId: string) => Effect.Effect<void>;
  // threads
  readonly moveThreads: (
    target: EnvironmentId,
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<HandoffMachineThreadResult>, AwayError>;
  /**
   * Source thread id to the thread that continues it on `target`, from the
   * handoff record (a lid close: the heartbeat records what the target continued).
   */
  readonly continuedOn?: (target: EnvironmentId) => Effect.Effect<ReadonlyMap<string, string>>;
  /** Asks the target to hand back threads and coordinators it holds for this machine. */
  readonly askReturn: (
    target: EnvironmentId,
    request: AwayReturnRequest,
  ) => Effect.Effect<AwayReturnResponse, AwayPeerError>;
}

const THREAD_BATCH = 100;
const RETURN_BATCH = 5;

export const makeAwayRunner = (deps: AwayRunnerDeps) => {
  let running = false;

  /** Applies `change` to the saved session's item and saves it. */
  const settle = (
    session: { current: AwaySession },
    match: (item: AwayItemResult) => boolean,
    change: (item: AwayItemResult) => AwayItemResult,
  ) =>
    Effect.gen(function* () {
      const items = session.current.items.map((item) => (match(item) ? change(item) : item));
      session.current = { ...session.current, items };
      yield* deps.saveSession(session.current);
    });
  const stage = (session: { current: AwaySession }, next: AwaySession["stage"]) =>
    Effect.gen(function* () {
      session.current = { ...session.current, stage: next };
      yield* deps.saveSession(session.current);
    });
  const isItem = (kind: AwayItemResult["kind"], id: string) => (item: AwayItemResult) =>
    item.kind === kind && item.id === id;

  // --- leaving ---------------------------------------------------------------------------

  const coordinatorsStage = (session: { current: AwaySession }) =>
    Effect.gen(function* () {
      const target = session.current.targetEnvironmentId;
      for (const item of session.current.items) {
        if (item.kind !== "coordinator" || item.outcome !== "pending") continue;
        const projectId = (item.projectId ?? item.id) as ProjectId;
        const minutes = yield* deps.standbyMinutesOf(projectId);
        const handed = yield* deps.handOver({
          projectId,
          targetEnvironmentId: target,
          reason: "away",
        });
        yield* settle(session, isItem("coordinator", item.id), (current) => ({
          ...current,
          outcome:
            handed.outcome === "handed-over"
              ? "moved"
              : handed.outcome === "skipped"
                ? "stayed"
                : "failed",
          detail: clip(handed.detail),
          ...(handed.epoch === undefined ? {} : { targetId: String(handed.epoch) }),
          ...(minutes === undefined ? {} : { standbyAfterMinutes: minutes }),
        }));
      }
      yield* stage(session, "routines");
    });

  /** Whether the item's routine follows a coordinator that moved, stayed, or is elsewhere. */
  const coordinatorOutcome = (session: AwaySession, projectId: string | undefined) =>
    session.items.find((item) => item.kind === "coordinator" && item.id === projectId)?.outcome;

  const transferRoutine = (
    session: { current: AwaySession },
    task: ScheduledTask,
    boundThreadId: string | null,
  ) =>
    Effect.gen(function* () {
      const copy = deps.routineCopy(task);
      if (copy === null) {
        yield* settle(session, isItem("routine", task.id), (item) => ({
          ...item,
          outcome: "stayed",
          detail: "This routine cannot be sent.",
        }));
        return;
      }
      const moved = yield* deps.transferOut({
        task,
        target: session.current.targetEnvironmentId,
        targetLabel: session.current.targetLabel,
        copy,
        boundThreadId,
      });
      yield* settle(session, isItem("routine", task.id), (item) => ({
        ...item,
        via: "transfer",
        wasEnabled: true,
        ...(moved.kind === "moved"
          ? {
              outcome: "moved",
              detail: clip(moved.detail),
              ...(moved.targetProjectId === null ? {} : { targetId: task.id }),
            }
          : // Off here without an answer from the target: Bring back turns it on again.
            { outcome: "failed", detail: clip(moved.detail), wasEnabled: moved.offHere }),
      }));
    });

  const routinesStage = (session: { current: AwaySession }) =>
    Effect.gen(function* () {
      const tasks = new Map((yield* deps.routines).map((task) => [task.id as string, task]));
      for (const item of session.current.items) {
        if (item.kind !== "routine" || item.outcome !== "pending") continue;
        const task = tasks.get(item.id);
        if (task === undefined) {
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            outcome: "stayed",
            detail: "This routine is gone.",
          }));
          continue;
        }
        if (task.schedule.type === "webhook") {
          const paused = yield* deps.pauseHere(
            task.id,
            awayPausedNote(session.current.targetLabel),
          );
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            via: "paused",
            wasEnabled: task.enabled,
            outcome: paused ? "paused" : "failed",
            detail: paused
              ? "Its URL belongs to this machine, so it is paused here until you are back."
              : "Could not pause it here.",
          }));
          continue;
        }
        if (!isTransferredRoutine(task)) {
          // It follows its project's coordinator, which decided where it runs.
          const coordinator = coordinatorOutcome(session.current, task.projectId);
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            ...(coordinator === "moved"
              ? {
                  outcome: "moved",
                  via: "coordinator",
                  detail: `Moved with its project's coordinator to ${session.current.targetLabel}, with its run state.`,
                }
              : coordinator === undefined
                ? { outcome: "stayed", detail: "It runs where its project's coordinator runs." }
                : {
                    outcome: "stayed",
                    detail: "Its project's coordinator stayed here, so it stays too.",
                  }),
          }));
          continue;
        }
        // A routine bound to a worker waits for that worker's move (after threads).
        if (task.threadId !== null) continue;
        yield* transferRoutine(session, task, null);
      }
      yield* stage(session, "threads");
    });

  const threadsStage = (session: { current: AwaySession }) =>
    Effect.gen(function* () {
      const target = session.current.targetEnvironmentId;
      const pending = session.current.items
        .filter((item) => item.kind === "thread" && item.outcome === "pending")
        .map((item) => ThreadId.make(item.id));
      for (let start = 0; start < pending.length; start += THREAD_BATCH) {
        const batch = pending.slice(start, start + THREAD_BATCH);
        const moved = yield* deps.moveThreads(target, batch).pipe(Effect.result);
        if (moved._tag === "Failure") {
          const ids = new Set<string>(batch);
          yield* settle(
            session,
            (item) => item.kind === "thread" && ids.has(item.id),
            (item) => ({ ...item, outcome: "handoff-ready", detail: clip(moved.failure.message) }),
          );
          continue;
        }
        for (const result of moved.success) {
          yield* settle(session, isItem("thread", result.threadId), (item) =>
            result.outcome === "moved"
              ? {
                  ...item,
                  outcome: "moved",
                  detail: clip(result.detail ?? `Continues on ${session.current.targetLabel}.`),
                  ...(result.continuedThreadId === null
                    ? {}
                    : { targetId: result.continuedThreadId }),
                }
              : {
                  ...item,
                  // Never stopped: it stays here, ready to continue on another machine.
                  outcome: result.outcome === "skipped" ? "stayed" : "handoff-ready",
                  detail: clip(result.detail ?? "It did not move."),
                },
          );
        }
      }
      // Routines bound to a worker follow it, or stay with it.
      const tasks = new Map((yield* deps.routines).map((task) => [task.id as string, task]));
      for (const item of session.current.items) {
        if (item.kind !== "routine" || item.outcome !== "pending") continue;
        const task = tasks.get(item.id);
        const thread =
          task?.threadId == null
            ? undefined
            : session.current.items.find(
                (entry) => entry.kind === "thread" && entry.id === task.threadId,
              );
        if (task === undefined || thread?.outcome !== "moved" || thread.targetId === undefined) {
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            outcome: "stayed",
            detail:
              task === undefined
                ? "This routine is gone."
                : "Its thread stays on this machine, so it stays too.",
          }));
          continue;
        }
        yield* transferRoutine(session, task, thread.targetId);
      }
      session.current = { ...session.current, stage: "done", finishedAt: yield* deps.now };
      yield* deps.saveSession(session.current);
    });

  const runLeaving = (start: AwaySession) =>
    Effect.gen(function* () {
      const session = { current: start };
      if (session.current.stage === "coordinators") yield* coordinatorsStage(session);
      if (session.current.stage === "routines") yield* routinesStage(session);
      if (session.current.stage === "threads") yield* threadsStage(session);
      return session.current;
    });

  /** The forked stages; they hold the claim until they end. */
  const guarded = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(Effect.ensuring(Effect.sync(() => void (running = false))));

  const busy = new AwayError({
    code: "failed",
    message: "Away is already moving work. Wait for it to finish.",
  });

  /** The session the run in progress saved, marked; a call made while one runs answers this. */
  const alreadyRunning = Effect.gen(function* () {
    const latest = yield* deps.loadSession;
    if (latest === null) return yield* busy;
    return { ...latest, alreadyRunning: true } satisfies AwaySession;
  });

  /**
   * Runs `body` holding the claim, taken before anything waits, so a second
   * start or Bring back never slips in. `body` returns whether it forked the
   * stages, which then release the claim when they end.
   */
  const claimed = <E>(
    body: Effect.Effect<{ readonly session: AwaySession; readonly forked: boolean }, E>,
  ): Effect.Effect<AwaySession, E | AwayError> =>
    Effect.suspend((): Effect.Effect<AwaySession, E | AwayError> => {
      if (running) return alreadyRunning;
      running = true;
      let forked = false;
      return body.pipe(
        Effect.map((result) => {
          forked = result.forked;
          return result.session;
        }),
        Effect.ensuring(Effect.sync(() => void (forked || (running = false)))),
      );
    });

  /**
   * Starts leaving, or resumes the unfinished session for the same target.
   * Answers once the session is saved; the stages run after.
   */
  const start = (input: AwayStartInput) =>
    claimed(
      Effect.gen(function* () {
        const latest = yield* deps.loadSession;
        if (latest !== null && latest.stage === "pending-intent")
          return yield* new AwayError({
            code: "failed",
            message: `This machine left for ${latest.targetLabel} when it went to sleep. Wait a moment while it checks what moved, then try again.`,
          });
        if (latest !== null && latest.finishedAt === null) {
          if (latest.targetEnvironmentId !== input.targetEnvironmentId)
            return yield* new AwayError({
              code: "failed",
              message: `Leaving for ${latest.targetLabel} did not finish. Leave for ${latest.targetLabel} again to finish it.`,
            });
          yield* deps.fork(guarded(runLeaving(latest).pipe(Effect.asVoid)));
          return { session: latest, forked: true };
        }
        if (latest !== null && latest.broughtBackAt === null && hasWorkAway(latest))
          return yield* new AwayError({
            code: "failed",
            message: `Work is still on ${latest.targetLabel}. Bring it back before you leave again.`,
          });
        const plan = yield* deps.plan({
          targetEnvironmentId: input.targetEnvironmentId,
          ...(input.coordinatorScope === undefined
            ? {}
            : { coordinatorScope: input.coordinatorScope }),
        });
        const session = sessionFromPlan({
          sessionId: yield* deps.newId,
          plan,
          trigger: input.trigger ?? "manual",
          coordinatorScope: input.coordinatorScope ?? "live",
          startedAt: yield* deps.now,
        });
        yield* deps.saveSession(session);
        yield* deps.fork(guarded(runLeaving(session).pipe(Effect.asVoid)));
        return { session, forked: true };
      }),
    );

  // --- Bring back -------------------------------------------------------------------------

  const back = (outcome: AwayItemBack["outcome"], detail: string, at: string, localId?: string) =>
    ({
      outcome,
      detail: clip(detail),
      at,
      ...(localId === undefined ? {} : { localId }),
    }) satisfies AwayItemBack;

  const runBringBack = (start: AwaySession) =>
    Effect.gen(function* () {
      const session = { current: start };
      const target = session.current.targetEnvironmentId;
      const label = session.current.targetLabel;
      // A lid close: threads the wake could not place yet read the handoff record now.
      if (session.current.trigger === "sleep" && deps.continuedOn !== undefined) {
        const filled = fillSleepThreads(session.current, yield* deps.continuedOn(target), true);
        if (filled !== session.current) {
          session.current = filled;
          yield* deps.saveSession(filled);
        }
      }
      const open = (kind: AwayItemResult["kind"]) =>
        session.current.items.filter((item) => item.kind === kind && awaitsReturn(item));

      // 1. Threads the target continued come back through its own move.
      const threads = open("thread").filter(
        (item) => item.outcome === "moved" && item.targetId !== undefined,
      );
      for (let start = 0; start < threads.length; start += RETURN_BATCH) {
        const batch = threads.slice(start, start + RETURN_BATCH);
        const asked = yield* deps
          .askReturn(target, {
            protocolVersion: AWAY_RETURN_PROTOCOL_VERSION,
            threadIds: batch.map((item) => ThreadId.make(item.targetId!)),
          })
          .pipe(Effect.result);
        const at = yield* deps.now;
        for (const item of batch) {
          const answer =
            asked._tag === "Success"
              ? asked.success.results.find((result) => result.threadId === item.targetId)
              : undefined;
          yield* settle(session, isItem("thread", item.id), (current) => ({
            ...current,
            back:
              asked._tag === "Failure"
                ? back("failed", `${asked.failure.message} It keeps running on ${label}.`, at)
                : answer?.outcome === "moved"
                  ? back(
                      "returned",
                      answer.detail ?? "Continues here.",
                      at,
                      answer.continuedThreadId ?? undefined,
                    )
                  : back(
                      "stayed",
                      `${answer?.detail ?? "It did not come back."} It keeps running on ${label}.`,
                      at,
                    ),
          }));
        }
      }

      // 2. Routines: moved ones come back with their state, paused ones turn on again.
      const tasks = new Map((yield* deps.routines).map((task) => [task.id as string, task]));
      for (const item of open("routine")) {
        const at = yield* deps.now;
        if (item.via === "paused") {
          const resumed = item.wasEnabled === false ? true : yield* deps.pauseHere(item.id, null);
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            back: resumed
              ? back("returned", "Runs here again.", at)
              : back("failed", "Could not turn it back on here.", at),
          }));
          continue;
        }
        if (item.via === "transfer" && (item.outcome === "moved" || item.wasEnabled === true)) {
          const task = tasks.get(item.id);
          const returned = yield* deps.transferBack({
            task: {
              id: item.id as ScheduledTask["id"],
              projectId: (task?.projectId ?? item.projectId) as ProjectId,
            },
            target,
            targetLabel: label,
            wasEnabled: item.wasEnabled !== false,
          });
          // A worker routine follows its thread's new id here.
          const thread =
            task?.threadId == null
              ? undefined
              : session.current.items.find(
                  (entry) => entry.kind === "thread" && entry.id === task.threadId,
                );
          if (returned.kind === "returned" && thread?.back?.localId !== undefined)
            yield* deps.rebind(item.id, thread.back.localId);
          yield* settle(session, isItem("routine", item.id), (current) => ({
            ...current,
            back: back(returned.kind === "returned" ? "returned" : "failed", returned.detail, at),
          }));
        }
      }

      // 3. Coordinators come back by planned handover from the target; its routines ride along.
      const coordinators = open("coordinator").filter((item) => item.outcome === "moved");
      if (coordinators.length > 0) {
        const asked = yield* deps
          .askReturn(target, {
            protocolVersion: AWAY_RETURN_PROTOCOL_VERSION,
            threadIds: [],
            projectIds: coordinators.map((item) => (item.projectId ?? item.id) as ProjectId),
          })
          .pipe(Effect.result);
        for (const item of coordinators) {
          const at = yield* deps.now;
          const projectId = (item.projectId ?? item.id) as ProjectId;
          const answer =
            asked._tag === "Success"
              ? (asked.success.coordinators ?? []).find((result) => result.projectId === projectId)
              : undefined;
          let result: AwayItemBack;
          // A lid close with no word of a takeover: the target never coordinated it, so it is here.
          if (
            answer?.outcome === "skipped" &&
            session.current.trigger === "sleep" &&
            item.targetId === undefined
          ) {
            result = back(
              "returned",
              `${label} was not coordinating it, so it coordinates here.`,
              at,
            );
          } else if (answer?.outcome === "handed-over") {
            const rearmed = yield* deps.rearm(
              projectId,
              target,
              standbyMinutes(item.standbyAfterMinutes),
            );
            result = back(
              "returned",
              rearmed === null
                ? `Coordinates here again. ${label} is its standby again.`
                : `Coordinates here again. ${label} is not its standby yet: ${rearmed}`,
              at,
            );
          } else {
            result = back(
              "failed",
              asked._tag === "Failure"
                ? `${asked.failure.message} It stays on ${label}.`
                : `${answer?.detail ?? "It did not come back."} It stays on ${label}.`,
              at,
            );
          }
          yield* settle(session, isItem("coordinator", item.id), (current) => ({
            ...current,
            back: result,
          }));
        }
      }

      // Routines that went with a coordinator are back once it is.
      for (const item of open("routine")) {
        if (item.via !== "coordinator") continue;
        const coordinator = session.current.items.find(
          (entry) => entry.kind === "coordinator" && entry.id === item.projectId,
        );
        const at = yield* deps.now;
        yield* settle(session, isItem("routine", item.id), (current) => ({
          ...current,
          back:
            coordinator?.back?.outcome === "returned"
              ? back("returned", "Came back with its project's coordinator.", at)
              : back("failed", `Runs on ${label} until its project's coordinator comes back.`, at),
        }));
      }

      session.current = {
        ...session.current,
        broughtBackAt: hasWorkAway(session.current) ? null : yield* deps.now,
      };
      yield* deps.saveSession(session.current);
      return session.current;
    });

  /** Starts Bring back for the latest session; answers once it is saved. */
  const bringBack = (input: { readonly sessionId?: string | undefined }) =>
    claimed(
      Effect.gen(function* () {
        const latest = yield* deps.loadSession;
        if (
          latest === null ||
          (input.sessionId !== undefined && latest.sessionId !== input.sessionId)
        )
          return yield* new AwayError({ code: "not_found", message: "Nothing left this machine." });
        if (latest.broughtBackAt !== null) return { session: latest, forked: false };
        if (latest.stage === "pending-intent")
          return yield* new AwayError({
            code: "failed",
            message: `This machine is still checking what ${latest.targetLabel} took over while it slept. Try again in a moment.`,
          });
        const started: AwaySession = {
          ...latest,
          bringBackStartedAt: latest.bringBackStartedAt ?? (yield* deps.now),
        };
        yield* deps.saveSession(started);
        // An unfinished leave is finished first, so nothing is left half moved.
        yield* deps.fork(
          guarded(
            (started.finishedAt === null ? runLeaving(started) : Effect.succeed(started)).pipe(
              Effect.flatMap(runBringBack),
              Effect.asVoid,
            ),
          ),
        );
        return { session: started, forked: true };
      }),
    );

  /**
   * On server start: an unfinished leave, or a Bring back that did not
   * finish, carries on in the background. Every stage is idempotent, so a
   * second resume only answers "already continued". A lid close waiting for
   * its wake is left alone.
   */
  const resume = Effect.gen(function* () {
    const latest = yield* deps.loadSession;
    if (latest === null || latest.stage === "pending-intent") return false;
    if (latest.finishedAt === null)
      return yield* start({
        targetEnvironmentId: latest.targetEnvironmentId,
        coordinatorScope: latest.coordinatorScope,
        trigger: latest.trigger,
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (latest.bringBackStartedAt !== null && latest.broughtBackAt === null)
      return yield* bringBack({ sessionId: latest.sessionId }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    return false;
  });

  return {
    start,
    bringBack,
    resume,
    isRunning: Effect.sync(() => running),
    /** For tests: the stages without the fork. */
    runLeaving,
    runBringBack,
  } as const;
};

// --- the service ----------------------------------------------------------------------------

export class AwayRunner extends Context.Service<
  AwayRunner,
  {
    readonly start: (input: AwayStartInput) => Effect.Effect<AwaySession, AwayError>;
    readonly bringBack: (input: {
      readonly sessionId?: string | undefined;
    }) => Effect.Effect<AwaySession, AwayError>;
    readonly snapshot: Effect.Effect<AwaySnapshot, AwayError>;
    readonly updateConfig: (patch: AwaySettingsPatch) => Effect.Effect<AwaySnapshot, AwayError>;
  }
>()("specweave-studio/away/AwayRunner") {}

const decodeReturn = Schema.decodeUnknownOption(AwayReturnResponse);
const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const RETURN_TIMEOUT_MS = 10 * 60_000;

/** Away's settings as clients see them, from the handoff config. */
export function awaySettingsOf(config: Parameters<typeof awayConfigOf>[0]): AwaySettings {
  const away = awayConfigOf(config);
  return {
    target: away.target,
    sleepTrigger: away.sleepTrigger,
    graceMinutes: away.graceMinutes,
    bringBack: away.bringBack,
    coordinatorScope: away.coordinatorScope,
  };
}

/** The handoff config patch for an Away settings patch. */
export function handoffPatchOf(patch: AwaySettingsPatch): HandoffConfigPatch {
  return {
    ...(patch.target === undefined ? {} : { sleepTarget: patch.target }),
    ...(patch.sleepTrigger === undefined ? {} : { sleepTrigger: patch.sleepTrigger }),
    ...(patch.graceMinutes === undefined ? {} : { graceMinutes: patch.graceMinutes }),
    ...(patch.bringBack === undefined ? {} : { bringBack: patch.bringBack }),
    ...(patch.coordinatorScope === undefined ? {} : { coordinatorScope: patch.coordinatorScope }),
  };
}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const planner = yield* AwayPlanner;
  const handover = yield* CoordinatorPlannedHandover;
  const transfer = yield* ScheduledTaskTransfer;
  const scheduled = yield* ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const link = yield* ProjectLink;
  const intents = yield* AwayIntents;
  const crypto = yield* Crypto.Crypto;
  const post: AwayPeerPost = yield* makeAwayPeerPost;
  const runScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const away = (message: string) => new AwayError({ code: "failed", message: clip(message, 1000) });

  const loadSession = handoff.document.pipe(
    Effect.map((document) => awaySessionOf(document.awaySession)),
    Effect.orElseSucceed(() => null),
  );
  const saveSession = (session: AwaySession) =>
    handoff
      .updateDocument(
        (document) => [undefined, { ...document, awaySession: encodeSession(session) }] as const,
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Away could not save its session", { cause }),
        ),
      );
  const projectOf = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  const routines = scheduled.list().pipe(
    Effect.map((result) => result.tasks),
    Effect.orElseSucceed((): ReadonlyArray<ScheduledTask> => []),
  );

  const core = makeAwayRunner({
    selfEnvironmentId: handoff.environmentId,
    loadSession,
    saveSession,
    plan: planner.preflight,
    now: nowIso,
    newId: crypto.randomUUIDv4.pipe(Effect.orDie),
    fork: (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Away stopped before it finished", { cause }),
        ),
        Effect.forkIn(runScope),
        Effect.asVoid,
      ),
    handOver: handover.handOver,
    standbyMinutesOf: (projectId) =>
      projectOf(projectId).pipe(
        Effect.map(
          (project) => project?.workspaceSettings?.coordinatorBinding?.standby?.afterMinutes,
        ),
      ),
    rearm: (projectId, target, afterMinutes) =>
      Effect.gen(function* () {
        const project = yield* projectOf(projectId);
        const member = project?.workspaceSettings?.logicalProject?.members.find(
          (entry) => entry.environmentId === target,
        );
        if (member === undefined) return "it is no longer linked there.";
        const operationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const armed = yield* link
          .setStandby({ operationId, projectId, standby: { member, afterMinutes } })
          .pipe(Effect.result);
        return armed._tag === "Success" ? null : (armed.failure.detail ?? armed.failure.code);
      }),
    routines,
    routineCopy: (task) => routineCopyOf({ ...task, ownThread: true }),
    transferOut: transfer.moveOut,
    transferBack: transfer.bringBack,
    pauseHere: transfer.pauseHere,
    rebind: (taskId, threadId) =>
      Effect.gen(function* () {
        const task = (yield* routines).find((entry) => entry.id === taskId);
        if (task === undefined || task.threadId === null) return;
        const input = yield* decodeUpsert({
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          enabled: task.enabled,
          schedule: task.schedule,
          projectId: task.projectId,
          threadId,
          workspaceStrategy: task.workspaceStrategy,
          modelSelection: task.modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: task.interactionMode,
          createdBy: task.createdBy,
          creationSource: task.creationSource,
          modelPinned: task.modelPinned ?? false,
          check: task.check ?? null,
          brief: task.brief ?? null,
          ...(task.ownThread === undefined ? {} : { ownThread: task.ownThread }),
        });
        yield* scheduled.upsert(input);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Away could not point a routine at its returned thread", { cause }),
        ),
      ),
    continuedOn: (target) =>
      handoff.document.pipe(
        Effect.map(
          (document) =>
            new Map(
              Object.entries(document.threads).flatMap(([id, record]) =>
                record.continuedOn?.environmentId === target
                  ? [[id, record.continuedOn.threadId as string] as const]
                  : [],
              ),
            ),
        ),
        Effect.orElseSucceed(() => new Map<string, string>()),
      ),
    moveThreads: (target, threadIds) =>
      handoff.handOffMachine({ destinationEnvironmentId: target, reason: "away", threadIds }).pipe(
        Effect.map((run) => run.results),
        Effect.mapError((error) => away(error.message)),
      ),
    askReturn: (target, request) =>
      post(target, AWAY_RETURN_PATH, request, RETURN_TIMEOUT_MS).pipe(
        Effect.flatMap((answer) => {
          const decoded = decodeReturn(answer.json);
          return Option.isSome(decoded)
            ? Effect.succeed(decoded.value)
            : Effect.fail(
                new AwayPeerError({
                  message: "The other machine sent an answer this version cannot read.",
                  refused: false,
                  uncertain: true,
                }),
              );
        }),
      ),
  });

  const snapshot = Effect.gen(function* () {
    const document = yield* handoff.document.pipe(Effect.mapError((error) => away(error.message)));
    return {
      environmentId: handoff.environmentId,
      machineLabel: handoff.machineLabel.slice(0, 120),
      settings: awaySettingsOf(document.config),
      session: awaySessionOf(document.awaySession),
      running: yield* core.isRunning,
    } satisfies AwaySnapshot;
  });

  // On the target: once a sleeping machine's grace ran out and its coordinators
  // were taken, continue the threads it replicated here.
  yield* intents.onIntentDue((intent) =>
    Effect.forEach(
      intent.threadIds,
      (sourceThreadId) =>
        handoff
          .continueHere({
            sourceEnvironmentId: intent.sourceEnvironmentId,
            sourceThreadId: ThreadId.make(sourceThreadId),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Away could not continue a thread a sleeping machine left here", {
                sourceEnvironmentId: intent.sourceEnvironmentId,
                sourceThreadId,
                cause,
              }),
            ),
          ),
      { concurrency: 1, discard: true },
    ),
  );

  // An Away a restart cut off carries on by itself.
  yield* core.resume.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Away could not resume on start", { cause })),
    Effect.forkIn(runScope),
  );

  return AwayRunner.of({
    start: core.start,
    bringBack: core.bringBack,
    snapshot,
    updateConfig: (patch) =>
      handoff.updateConfig(handoffPatchOf(patch)).pipe(
        Effect.mapError((error) => away(error.message)),
        Effect.andThen(snapshot),
      ),
  });
});

/** Needs handoff mode, the planner, the planned handover, routine transfer and AwayIntents. */
export const layer = Layer.effect(AwayRunner, make);
