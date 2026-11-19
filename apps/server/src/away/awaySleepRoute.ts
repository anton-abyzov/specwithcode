/**
 * This machine going to sleep, and waking (1267 T-06; 1390 AC-36).
 *
 * Sleep starts nothing. `POST /api/away/v1/sleep` is a notice: it answers
 * `skipped`, sends the Away target nothing and records nothing, whatever
 * `sleepTrigger` an earlier release saved. Work leaves only when someone
 * hands it off.
 *
 * `POST /api/away/v1/wake`: the Mac woke or was unlocked. What is left here is
 * the drain of a lid close an earlier release already sent. From that notice
 * on, the coordinators its intent names are held (`AwayWakeHold`): they start
 * no turn until the target answers. Waking cancels the intent; when the target
 * already acted, this machine asks it which projects it took over, gives way
 * for those and releases the rest. Without an answer the hold stays and the
 * check repeats; it never resumes at the old epoch while an intent may have
 * fired. When work moved, the session waits for Bring back: the answer tells
 * the main process to show the wake card, or that bringing back started on
 * its own (on power, when set).
 *
 * Both routes accept only this machine's own desktop bearer, like
 * `COORDINATOR_SUSPEND_PATH`.
 */
import {
  AWAY_FORCE_LOCAL_AFTER_MS,
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_STATUS_PATH,
  AWAY_PLAN_MAX_ITEMS,
  AWAY_SLEEP_PATH,
  AWAY_WAKE_PATH,
  type AwayConfig,
  AwayIntentStatusAnswer,
  AwaySleepRequest,
  type AwaySleepSession,
  type AwaySleepAnswer,
  type AwayWakeAnswer,
  AwayWakeRequest,
  type EnvironmentId,
  type ProjectId,
  awayConfigOf,
  CommandId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { parseJson } from "../json.ts";
import { CoordinatorLease } from "../project/CoordinatorLease.ts";
import { maySuspend } from "../project/CoordinatorSuspendRoute.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import { AwaySleepBridge } from "./awaySleepBridge.ts";
import { AwayRunner } from "./AwayRunner.ts";
import { type AwayPeerPost, makeAwayPeerPost } from "./awayPeerCall.ts";
import { makeLiveSleepSession, type SleepSessionPort } from "./awaySleepSession.ts";
import {
  type AwayWakeHoldStore,
  makeFileWakeHoldStore,
  memoryWakeHoldStore,
  releaseProjects,
  releaseThreads,
} from "./AwayWakeHold.ts";

/** The Mac may sleep within seconds; a slower target is not waited for. */
export const AWAY_SLEEP_SEND_TIMEOUT_MS = 4_000;
const MINUTE_MS = 60_000;
/** How often an unresolved wake check is tried again. */
export const AWAY_WAKE_RETRY_MS = 30_000;
/**
 * Without a wake notice (the app restarted), the check runs on its own this
 * long after the grace ran out: the target has acted or cancelled by then.
 */
const UNNOTICED_WAKE_MARGIN_MS = 2 * MINUTE_MS;
const decodeStatusAnswer = Schema.decodeUnknownOption(AwayIntentStatusAnswer);
/** How long confirming a continuation waits for the heartbeat that records it. */
const CONFIRM_HEARTBEAT_MS = 8_000;

// --- the service -----------------------------------------------------------------

export interface AwaySleepStore {
  readonly read: Effect.Effect<AwaySleepSession | null>;
  readonly write: (next: AwaySleepSession | null) => Effect.Effect<void>;
}

export const memorySleepStore = (
  initial: AwaySleepSession | null = null,
): AwaySleepStore & { readonly current: () => AwaySleepSession | null } => {
  let held = initial;
  return {
    read: Effect.sync(() => held),
    write: (next) => Effect.sync(() => void (held = next)),
    current: () => held,
  };
};

export interface AwaySleepDeps {
  readonly self: EnvironmentId;
  readonly store: AwaySleepStore;
  readonly config: Effect.Effect<AwayConfig>;
  readonly post: AwayPeerPost;
  /**
   * The Away session an earlier lid close recorded (`awaySleepSession`):
   * items, routines paused here, and what the wake found. Absent in tests of
   * the wake check alone.
   */
  readonly away?: SleepSessionPort | undefined;
  /** The coordinators held from the sleep notice until the target answers; memory by default. */
  readonly hold?: AwayWakeHoldStore | undefined;
  /**
   * The target took `projectId` over: verify, stop this copy's coordinator and
   * its workers, and give way (`CoordinatorLease.acceptAwayTakeover`). True
   * once this copy no longer coordinates. Absent: the hold stays.
   */
  readonly giveWay?:
    | ((input: {
        readonly projectId: ProjectId;
        /** The recorded away target; the takeover must come from its listed copy. */
        readonly targetEnvironmentId: EnvironmentId;
        readonly status: AwayIntentStatusAnswer["projects"][number];
        readonly receivedAt: string;
        readonly sentAtMs: number;
        readonly answeredAtMs: number;
      }) => Effect.Effect<boolean>)
    | undefined;
  /** Interrupts a held project's coordinator turn, which may have resumed with the machine. */
  readonly stopCoordinator?:
    | ((projectId: ProjectId, reason: string) => Effect.Effect<void>)
    | undefined;
  /**
   * Heartbeats the target and answers which of `threadIds` handoff mode now
   * records as continued there (so fenced here). Absent: the target's word is enough.
   */
  readonly confirmContinued?:
    | ((threadIds: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>>)
    | undefined;
  /** Starts the queues of held threads the target did not continue. */
  readonly resumeQueues?: ((threadIds: ReadonlyArray<string>) => Effect.Effect<void>) | undefined;
}

/** What Run here anyway did: the projects and threads it released, or why it did nothing. */
export type ForceLocalResult =
  | {
      readonly ok: true;
      readonly projectIds: ReadonlyArray<string>;
      readonly threadIds: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: string };

/** What one wake check found. */
export type WakeCheck =
  /** The intent was cancelled, or the target took nothing over: nothing moved. */
  | "nothing-moved"
  /** The target acted: this machine gave way where it took over. */
  | "moved"
  /** No sure answer yet: the hold stays and the check repeats. */
  | "unresolved";

export interface AwaySleepDecision {
  /** Always `skipped`: a sleep hands nothing off. */
  readonly answer: AwaySleepAnswer;
  /** Nothing is sent. Kept so a caller that ran it after answering still can. */
  readonly send: Effect.Effect<void>;
}

export interface AwaySleepShape {
  readonly sleep: (request: AwaySleepRequest) => Effect.Effect<AwaySleepDecision>;
  readonly wake: (request: AwayWakeRequest) => Effect.Effect<AwayWakeAnswer>;
  /** The lid-close session, for the wake card and the Away summary. */
  readonly session: Effect.Effect<AwaySleepSession | null>;
  /** Bring back finished, or the user dismissed the card. */
  readonly clear: Effect.Effect<void>;
  /**
   * Registers what "Bring back automatically on power" runs (the Away runner's
   * bring back). Without one, waking on power prompts instead.
   */
  readonly onAutoBringBack: (handler: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * Repeats an unresolved wake check (`AWAY_WAKE_RETRY_MS`): after a wake
   * whose check got no answer, or long after the grace with no wake notice.
   */
  readonly retry: Effect.Effect<WakeCheck | null>;
  /**
   * On server start, once the process is up: a lid close the restart cut off
   * is settled (send-failed: nothing moved) or checked like a wake. Never
   * auto brings back; the card asks.
   */
  readonly boot: Effect.Effect<AwayWakeAnswer>;
  /**
   * Run here anyway (owner only): after the target stayed silent for
   * `AWAY_FORCE_LOCAL_AFTER_MS`, lifts the hold for every project and thread
   * whose status is still unknown and records it. The check keeps asking.
   */
  readonly forceLocal: Effect.Effect<ForceLocalResult>;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const cancelledCount = (json: unknown): number =>
  typeof json === "object" &&
  json !== null &&
  "cancelled" in json &&
  typeof (json as { cancelled: unknown }).cancelled === "number"
    ? (json as { cancelled: number }).cancelled
    : 0;

export const makeAwaySleep = (deps: AwaySleepDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    let autoBringBack: Effect.Effect<void> | null = null;
    const hold = deps.hold ?? memoryWakeHoldStore();
    const release = (projectIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* hold.write(releaseProjects(yield* hold.read, projectIds));
      });
    const releaseAll = hold.write(null);
    const stopHeld = (reason: string) =>
      Effect.gen(function* () {
        if (deps.stopCoordinator === undefined) return;
        const held = yield* hold.read;
        for (const project of held?.projects ?? [])
          yield* deps.stopCoordinator(project.projectId as ProjectId, reason);
      });

    /** Lifts the hold for threads the target did not continue, and starts their queues. */
    const releaseThreadsHere = (threadIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (threadIds.length === 0) return;
        yield* hold.write(releaseThreads(yield* hold.read, threadIds));
        if (deps.resumeQueues !== undefined) yield* deps.resumeQueues(threadIds);
      });
    const releaseEverything = Effect.gen(function* () {
      const threads = (yield* hold.read)?.threads ?? [];
      yield* releaseAll;
      if (threads.length > 0 && deps.resumeQueues !== undefined) yield* deps.resumeQueues(threads);
    });

    /**
     * Cancels the intent, then asks the target what it took over. Gives way
     * for each project taken over and releases each project the target did
     * not take and will not (its latest intent is cancelled, done, or gone).
     * Held worker threads are released once the target says it did not
     * continue them (and will not), or once handoff mode records the
     * continuation here, which fences them and keeps their queues. Anything
     * else keeps the hold. `answered` says whether the target answered.
     */
    const check = (session: AwaySleepSession) =>
      Effect.gen(function* () {
        const target = session.targetEnvironmentId;
        const cancel = yield* deps
          .post(
            target,
            AWAY_INTENT_CANCEL_PATH,
            { sourceEnvironmentId: deps.self },
            AWAY_SLEEP_SEND_TIMEOUT_MS,
          )
          .pipe(Effect.result);
        if (cancel._tag === "Success" && cancelledCount(cancel.success.json) > 0) {
          yield* releaseEverything;
          return { outcome: "nothing-moved", answered: true } as const;
        }
        const held = yield* hold.read;
        const heldIds = (held?.projects ?? []).map((project) => project.projectId as ProjectId);
        const heldThreads = held?.threads ?? [];
        // A project Run here anyway released is still asked about: if the target took it, give way.
        const askIds = [
          ...new Set<ProjectId>([...heldIds, ...(session.forcedProjectIds ?? [])]),
        ].slice(0, AWAY_PLAN_MAX_ITEMS);
        const sentAtMs = yield* Clock.currentTimeMillis;
        const asked = yield* deps
          .post(
            target,
            AWAY_INTENT_STATUS_PATH,
            {
              sourceEnvironmentId: deps.self,
              projectIds: askIds,
              ...(heldThreads.length === 0
                ? {}
                : { threadIds: heldThreads.slice(0, AWAY_PLAN_MAX_ITEMS) }),
            },
            AWAY_SLEEP_SEND_TIMEOUT_MS,
          )
          .pipe(Effect.result);
        const answeredAtMs = yield* Clock.currentTimeMillis;
        const status = asked._tag === "Success" ? decodeStatusAnswer(asked.success.json) : null;
        if (status === null || Option.isNone(status)) {
          yield* stopHeld(
            "This machine is checking whether another machine took over its coordinator.",
          );
          return { outcome: "unresolved", answered: false } as const;
        }
        const answer = status.value;
        // A waiting intent may still fire; an acting one is taking projects over now.
        const settled = answer.intentState !== "waiting" && answer.intentState !== "acting";
        let moved = answer.intentState === "done";
        const heldSet = new Set<string>(heldIds);
        const released: string[] = [];
        for (const projectId of askIds) {
          const project = answer.projects.find((entry) => entry.projectId === projectId);
          if (project?.takenOver === true) {
            moved = true;
            const gave =
              deps.giveWay === undefined
                ? false
                : yield* deps.giveWay({
                    projectId,
                    targetEnvironmentId: target,
                    status: project,
                    receivedAt: answer.receivedAt,
                    sentAtMs,
                    answeredAtMs,
                  });
            if (gave && heldSet.has(projectId)) released.push(projectId);
            continue;
          }
          if (settled && project !== undefined && heldSet.has(projectId)) released.push(projectId);
        }
        yield* release(released);
        // Worker threads: not continued (and never will be) runs here; continued is fenced first.
        const notContinued: string[] = [];
        const continuedThere: string[] = [];
        for (const threadId of heldThreads) {
          const entry = answer.threads?.find((thread) => thread.threadId === threadId);
          if (entry?.continuedThreadId != null) continuedThere.push(threadId);
          else if (
            answer.threads === undefined ||
            answer.intentState === "cancelled" ||
            answer.intentState === null ||
            (entry !== undefined && answer.threadsSettled === true)
          )
            notContinued.push(threadId);
        }
        if (continuedThere.length > 0) moved = true;
        const fenced =
          continuedThere.length === 0
            ? new Set<string>()
            : deps.confirmContinued === undefined
              ? new Set(continuedThere)
              : yield* deps.confirmContinued(continuedThere);
        yield* hold.write(
          releaseThreads(
            yield* hold.read,
            continuedThere.filter((threadId) => fenced.has(threadId)),
          ),
        );
        yield* releaseThreadsHere(notContinued);
        if ((yield* hold.read) !== null) {
          yield* stopHeld(
            "This machine is checking whether another machine took over its coordinator.",
          );
          return { outcome: "unresolved", answered: true } as const;
        }
        if (!settled) return { outcome: "unresolved", answered: true } as const;
        return { outcome: moved ? "moved" : "nothing-moved", answered: true } as const;
      });

    /** Where a check leaves the session; returns the wake answer. */
    const afterCheck = (
      session: AwaySleepSession,
      found: { readonly outcome: WakeCheck; readonly answered: boolean },
      request: AwayWakeRequest | null,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const outcome = found.outcome;
        if (outcome === "unresolved") {
          const wokeAt =
            session.wokeAt === undefined && request !== null ? isoAt(now) : session.wokeAt;
          const { unreachableSince: _since, ...rest } = session;
          const next: AwaySleepSession = {
            ...rest,
            ...(wokeAt === undefined ? {} : { wokeAt }),
            // Run here anyway is offered once the target stayed silent this long after a wake.
            ...(found.answered || wokeAt === undefined
              ? {}
              : { unreachableSince: session.unreachableSince ?? isoAt(now) }),
          };
          if (next.wokeAt !== session.wokeAt || next.unreachableSince !== session.unreachableSince)
            yield* deps.store.write(next);
          return { outcome: "none" } satisfies AwayWakeAnswer;
        }
        if (outcome === "nothing-moved") {
          // One write closes the session and drops its sleep record; a failed one is checked again.
          if (deps.away !== undefined) yield* deps.away.nothingMoved;
          else yield* deps.store.write(null);
          return { outcome: "none" } satisfies AwayWakeAnswer;
        }
        const { unreachableSince: _since, ...answered } = session;
        const prompted: AwaySleepSession = {
          ...answered,
          state: "wake-prompt",
          wokeAt: session.wokeAt ?? isoAt(now),
        };
        // The items, the stage and the wake prompt in one write, before the answer: auto
        // bring back and the card read the filled session. Not saved: the check runs again.
        if (deps.away !== undefined) {
          if (!(yield* deps.away.moved(prompted)))
            return { outcome: "none" } satisfies AwayWakeAnswer;
        } else yield* deps.store.write(prompted);
        // A repeated check found the move after the wake; the card reads the session.
        if (request === null) return { outcome: "none" } satisfies AwayWakeAnswer;
        const config = yield* deps.config;
        if (config.bringBack === "manual") return { outcome: "none" } satisfies AwayWakeAnswer;
        if (config.bringBack === "auto-on-power" && !request.onBattery && autoBringBack !== null) {
          yield* Effect.forkDetach(
            autoBringBack.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Away: automatic bring back failed", { cause }),
              ),
            ),
          );
          return { outcome: "auto" } satisfies AwayWakeAnswer;
        }
        return { outcome: "prompt" } satisfies AwayWakeAnswer;
      });

    // Sleep starts nothing (1390 AC-36): no intent, no session, no hold, whatever the
    // saved trigger says. A lid close an earlier release sent is settled by the wake check.
    const sleep = (_request: AwaySleepRequest) =>
      Effect.succeed({
        answer: { outcome: "skipped" },
        send: Effect.void,
      } satisfies AwaySleepDecision);

    const wake = (request: AwayWakeRequest) =>
      lock.withPermit(
        Effect.gen(function* () {
          const session = yield* deps.store.read;
          if (session === null) return { outcome: "none" } satisfies AwayWakeAnswer;
          if (session.state === "send-failed") {
            // One write: routines on again, the session closed and its sleep record dropped.
            if (deps.away !== undefined) yield* deps.away.nothingMoved;
            else yield* deps.store.write(null);
            yield* releaseEverything;
            return { outcome: "none" } satisfies AwayWakeAnswer;
          }
          // Already prompted on an earlier wake or unlock; the card reads the session.
          if (session.state === "wake-prompt") return { outcome: "none" } satisfies AwayWakeAnswer;
          // pending-intent or send-uncertain: the target may hold the intent, or have acted.
          return yield* afterCheck(session, yield* check(session), request);
        }),
      );

    // The boot is a wake: a lid close the restart cut off is checked at once, never auto brought back.
    const boot = wake({ onBattery: true }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away: the check on start failed", { cause }).pipe(
          Effect.as({ outcome: "none" } satisfies AwayWakeAnswer),
        ),
      ),
    );

    const retry: AwaySleepShape["retry"] = lock.withPermit(
      Effect.gen(function* () {
        const session = yield* deps.store.read;
        if (session === null) return null;
        if (session.state === "send-failed" || session.state === "wake-prompt") return null;
        const now = yield* Clock.currentTimeMillis;
        // Before a wake notice the machine may be about to sleep: cancelling then would leave nothing covered.
        if (
          session.wokeAt === undefined &&
          now < Date.parse(session.dueAt) + UNNOTICED_WAKE_MARGIN_MS
        )
          return null;
        const found = yield* check(session);
        yield* afterCheck(session, found, null);
        return found.outcome;
      }),
    );

    const forceLocal: AwaySleepShape["forceLocal"] = lock.withPermit(
      Effect.gen(function* () {
        const session = yield* deps.store.read;
        const now = yield* Clock.currentTimeMillis;
        const since =
          session?.unreachableSince === undefined ? NaN : Date.parse(session.unreachableSince);
        if (session === null || !Number.isFinite(since) || now - since < AWAY_FORCE_LOCAL_AFTER_MS)
          return {
            ok: false,
            message:
              "Run here anyway is offered once the other machine has not answered for 10 minutes after a wake.",
          } satisfies ForceLocalResult;
        const held = yield* hold.read;
        const projectIds = (held?.projects ?? []).map((project) => project.projectId);
        const threadIds = held?.threads ?? [];
        yield* releaseEverything;
        yield* deps.store.write({
          ...session,
          forcedLocalAt: isoAt(now),
          forcedProjectIds: [
            ...new Set([...(session.forcedProjectIds ?? []), ...projectIds]),
          ] as Array<ProjectId>,
        });
        return { ok: true, projectIds, threadIds } satisfies ForceLocalResult;
      }),
    );

    return {
      sleep,
      wake,
      session: deps.store.read,
      clear: lock.withPermit(deps.store.write(null)),
      onAutoBringBack: (handler) => Effect.sync(() => void (autoBringBack = handler)),
      retry,
      boot,
      forceLocal,
    } satisfies AwaySleepShape;
  });

export class AwaySleep extends Context.Service<AwaySleep, AwaySleepShape>()(
  "specweave-studio/away/awaySleepRoute/AwaySleep",
) {}

function parseOrNull(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

export const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const post = yield* makeAwayPeerPost;
  const hold = yield* makeFileWakeHoldStore;
  const lease = Option.getOrUndefined(yield* Effect.serviceOption(CoordinatorLease));
  const threadsService = yield* Effect.serviceOption(ThreadManagementService);

  // The lid close lives in the Away session in handoff-mode.json; this is a pointer into it.
  const live = yield* makeLiveSleepSession;
  const store: AwaySleepStore = live.store;

  const core = yield* makeAwaySleep({
    self: handoff.environmentId,
    store,
    config: handoff.snapshot.pipe(
      Effect.map((snapshot) => awayConfigOf(snapshot.config)),
      // Without a readable config a wake asks before it brings anything back.
      Effect.orElseSucceed(() => ({
        target: null,
        sleepTrigger: "off" as const,
        graceMinutes: 2,
        bringBack: "prompt" as const,
        coordinatorScope: "live" as const,
      })),
    ),
    post,
    away: live.port,
    hold,
    ...(lease === undefined
      ? {}
      : {
          giveWay: (input) =>
            input.status.coordinatorBinding === undefined || input.status.successor === undefined
              ? Effect.succeed(false)
              : lease.acceptAwayTakeover({
                  projectId: input.projectId,
                  targetEnvironmentId: input.targetEnvironmentId,
                  takenOver: {
                    coordinatorBinding: input.status.coordinatorBinding,
                    successor: input.status.successor,
                  },
                  receivedAt: input.receivedAt,
                  sentAtMs: input.sentAtMs,
                  answeredAtMs: input.answeredAtMs,
                }),
          stopCoordinator: lease.stopCoordinatorOf,
        }),
    confirmContinued: (threadIds) =>
      Effect.gen(function* () {
        yield* handoff.heartbeat.pipe(Effect.timeout(CONFIRM_HEARTBEAT_MS), Effect.ignore);
        const document = yield* handoff.document.pipe(Effect.option);
        if (Option.isNone(document)) return new Set<string>();
        return new Set(
          threadIds.filter((threadId) => document.value.threads[threadId]?.continuedOn != null),
        );
      }),
    ...(Option.isNone(threadsService)
      ? {}
      : {
          resumeQueues: (threadIds: ReadonlyArray<string>) =>
            Effect.forEach(
              threadIds,
              (threadId) =>
                Effect.gen(function* () {
                  const commandId = CommandId.make(
                    `command:away-hold-released:${threadId}:${yield* Clock.currentTimeMillis}`,
                  );
                  yield* threadsService.value.dispatch({
                    type: "queue.resume",
                    commandId,
                    threadId: ThreadId.make(threadId),
                  });
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logInfo("Away: a released thread's queue did not start", {
                      threadId,
                      cause,
                    }),
                  ),
                ),
              { discard: true },
            ),
        }),
  });
  // Bring back and Run here anyway reach the wake check through the bridge (AwayRunner).
  const bridge = yield* Effect.serviceOption(AwaySleepBridge);
  if (Option.isSome(bridge))
    yield* bridge.value.register({
      wakeCheck: core.wake({ onBattery: true }).pipe(Effect.asVoid),
      forceLocal: core.forceLocal,
    });
  // The boot is a wake: once the process is up, a lid close a restart cut off is checked.
  yield* forkParked(core.boot);
  // Repeats a wake check that got no answer, until the target answers.
  yield* forkParked(
    core.retry.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Away: the wake check failed", { cause })),
      Effect.repeat(Schedule.spaced(Duration.millis(AWAY_WAKE_RETRY_MS))),
      Effect.asVoid,
    ),
  );
  return AwaySleep.of(core);
});

/** Needs HandoffMode, ProjectService, the projection store, routines and the fleet. */
export const layer = Layer.effect(AwaySleep, make);

// --- routes ----------------------------------------------------------------------

const decodeSleep = Schema.decodeUnknownOption(AwaySleepRequest);
const decodeWake = Schema.decodeUnknownOption(AwayWakeRequest);

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** The caller is this machine's desktop main process; then the decoded body. */
const localCall = <A>(decode: (raw: unknown) => Option.Option<A>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return { refused: json(401, { error: "unauthorized" }) } as const;
    if (!maySuspend(session.value)) return { refused: json(403, { error: "forbidden" }) } as const;
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const body = decode(text.length > 4096 ? null : parseOrNull(text));
    if (Option.isNone(body))
      return { refused: json(400, { error: "The request does not match this version." }) } as const;
    return { body: body.value } as const;
  });

const sleepRoute = HttpRouter.add(
  "POST",
  AWAY_SLEEP_PATH,
  Effect.gen(function* () {
    const call = yield* localCall(decodeSleep);
    if ("refused" in call) return call.refused;
    // A main process still on an earlier build asks here; the answer is always "skipped".
    return json(200, (yield* (yield* AwaySleep).sleep(call.body)).answer);
  }),
);

const wakeRoute = HttpRouter.add(
  "POST",
  AWAY_WAKE_PATH,
  Effect.gen(function* () {
    const call = yield* localCall(decodeWake);
    if ("refused" in call) return call.refused;
    const sleep = yield* AwaySleep;
    // "Bring back automatically on power" (D-02) runs the runner's Bring back.
    const runner = yield* Effect.serviceOption(AwayRunner);
    if (Option.isSome(runner))
      yield* sleep.onAutoBringBack(runner.value.bringBack({}).pipe(Effect.asVoid, Effect.ignore));
    return json(200, yield* sleep.wake(call.body));
  }),
);

export const routesLayer = Layer.mergeAll(sleepRoute, wakeRoute);
