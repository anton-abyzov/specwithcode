/**
 * The away intents of the previous release, v1.0.378, copied verbatim with
 * `git show v1.0.378:<path>`: a machine that has not updated yet still
 * records a sleeping machine's intent, waits out its grace and then takes its
 * projects over and continues its threads. Tests use it as that machine.
 * Only the imports were cut down to what these lines use. Never edit a body
 * here: replace it from the tag of the release a later test pins.
 *
 * Sources at v1.0.378:
 * - apps/server/src/away/AwayIntents.ts:64-65,68-73,77-354,391-399
 * - apps/server/src/away/awayIntentRoute.ts:43,48-51,70-113
 */
import {
  type AwayError,
  type AwayHandoverResult,
  type AwayIntentCancelAnswer,
  AwayIntentRecord,
  AwayIntentRequest,
  type AwayIntentState,
  type EnvironmentId,
  type Project,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { linkedCopyOf } from "./AwayIntents.ts";

export const PREVIOUS_RELEASE = "v1.0.378";

/** Settled intents kept for the summary; older ones are dropped. */
const KEEP_SETTLED = 50;
const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  intents: Schema.Array(AwayIntentRecord),
});
type StoreFile = typeof StoreFile.Type;
const EMPTY: StoreFile = { version: 1, intents: [] };

/** Where intents are kept; the live one is a file, tests use memory. */
export interface AwayIntentStore {
  readonly read: Effect.Effect<StoreFile, AwayError>;
  readonly write: (next: StoreFile) => Effect.Effect<void, AwayError>;
}

export const memoryIntentStore = (
  initial: StoreFile = EMPTY,
): AwayIntentStore & {
  readonly current: () => StoreFile;
} => {
  let held = initial;
  return {
    read: Effect.sync(() => held),
    write: (next) => Effect.sync(() => void (held = next)),
    current: () => held,
  };
};

export interface AwayIntentsDeps {
  readonly store: AwayIntentStore;
  readonly newId: Effect.Effect<string>;
  /** Whether the source was heard awake since the intent arrived, or answers now. */
  readonly heardAwake: (intent: AwayIntentRecord) => Effect.Effect<boolean>;
  /** Takes over each of the source's projects; one result per project, never fails. */
  readonly act: (intent: AwayIntentRecord) => Effect.Effect<ReadonlyArray<AwayHandoverResult>>;
}

export interface AwayIntentsShape {
  /** Records the source's intent; it replaces one still waiting from the same source. */
  readonly record: (
    sourceEnvironmentId: EnvironmentId,
    request: Omit<AwayIntentRequest, "sourceEnvironmentId">,
  ) => Effect.Effect<AwayIntentRecord, AwayError>;
  /**
   * The source is back: its waiting intents are cancelled. When its latest
   * intent is already acting or done nothing is cancelled, and the answer
   * names the state and the projects taken over, so the source gives way.
   */
  readonly cancel: (
    sourceEnvironmentId: EnvironmentId,
    reason: string,
  ) => Effect.Effect<AwayIntentCancelAnswer, AwayError>;
  /** The state of the source's latest intent here, or null without one. */
  readonly latestState: (
    sourceEnvironmentId: EnvironmentId,
  ) => Effect.Effect<AwayIntentState | null, AwayError>;
  readonly list: Effect.Effect<ReadonlyArray<AwayIntentRecord>, AwayError>;
  /** Acts on every intent whose grace ran out; returns the ones it settled. */
  readonly tick: Effect.Effect<ReadonlyArray<AwayIntentRecord>>;
  /**
   * Runs `handler` with each intent this machine acted on, after its
   * takeovers. The Away runner continues the replicated threads here.
   */
  readonly onIntentDue: (
    handler: (intent: AwayIntentRecord) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  /** Every intent this machine acted on, as it acts. */
  readonly due: Stream.Stream<AwayIntentRecord>;
  /**
   * Whether the follow-up of the source's acted intent (continuing its
   * threads) still runs here, so a thread not continued yet may still be.
   */
  readonly followUpRunning: (sourceEnvironmentId: EnvironmentId) => Effect.Effect<boolean>;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const makeAwayIntents = (deps: AwayIntentsDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const published = yield* PubSub.unbounded<AwayIntentRecord>();
    const handlers: Array<(intent: AwayIntentRecord) => Effect.Effect<void>> = [];
    /** Sources whose acted intent's follow-up (the hooks) runs now. */
    const following = new Map<string, number>();

    const modify = <A>(change: (current: StoreFile) => readonly [A, StoreFile | undefined]) =>
      lock.withPermit(
        Effect.gen(function* () {
          const [result, next] = change(yield* deps.store.read);
          if (next !== undefined) yield* deps.store.write(trim(next));
          return result;
        }),
      );

    const record: AwayIntentsShape["record"] = (sourceEnvironmentId, request) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const intentId = yield* deps.newId;
        const intent: AwayIntentRecord = {
          intentId,
          sourceEnvironmentId,
          graceMinutes: request.graceMinutes,
          projectIds: [...request.projectIds],
          threadIds: [...request.threadIds],
          receivedAt: isoAt(nowMs),
          dueAt: isoAt(nowMs + request.graceMinutes * 60_000),
          state: "waiting",
        };
        return yield* modify((current) => [
          intent,
          {
            ...current,
            intents: [
              ...current.intents.map((held) =>
                held.state === "waiting" && held.sourceEnvironmentId === sourceEnvironmentId
                  ? {
                      ...held,
                      state: "cancelled" as const,
                      cancelledAt: intent.receivedAt,
                      cancelReason: "replaced",
                    }
                  : held,
              ),
              intent,
            ],
          },
        ]);
      });

    const cancel: AwayIntentsShape["cancel"] = (sourceEnvironmentId, reason) =>
      Effect.gen(function* () {
        const at = isoAt(yield* Clock.currentTimeMillis);
        return yield* modify(
          (current): readonly [AwayIntentCancelAnswer, StoreFile | undefined] => {
            const latest = latestOf(current, sourceEnvironmentId);
            // Too late: the target is taking over or took over. The source must give way.
            if (latest?.state === "acting" || latest?.state === "done")
              return [
                {
                  cancelled: 0,
                  state: latest.state,
                  takenOver: takenOverBy(latest),
                },
                undefined,
              ];
            let cancelled = 0;
            const intents = current.intents.map((held) => {
              if (held.state !== "waiting" || held.sourceEnvironmentId !== sourceEnvironmentId)
                return held;
              cancelled += 1;
              return {
                ...held,
                state: "cancelled" as const,
                cancelledAt: at,
                cancelReason: reason.slice(0, 200),
              };
            });
            return [
              {
                cancelled,
                state: cancelled > 0 ? "cancelled" : (latest?.state ?? null),
                takenOver: [],
              },
              cancelled === 0 ? undefined : { ...current, intents },
            ];
          },
        );
      });

    const settle = (
      intentId: string,
      from: AwayIntentState,
      change: (held: AwayIntentRecord) => AwayIntentRecord,
    ) =>
      modify((current) => {
        let settled: AwayIntentRecord | undefined;
        const intents = current.intents.map((held) => {
          if (held.intentId !== intentId || held.state !== from) return held;
          settled = change(held);
          return settled;
        });
        return [settled, settled === undefined ? undefined : { ...current, intents }];
      });

    const tick: AwayIntentsShape["tick"] = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      // An intent left acting by a restart is finished first; it can no longer be cancelled.
      const due = (yield* deps.store.read).intents.filter(
        (intent) =>
          intent.state === "acting" ||
          (intent.state === "waiting" && Date.parse(intent.dueAt) <= nowMs),
      );
      const settled: AwayIntentRecord[] = [];
      for (const intent of due) {
        let acting: AwayIntentRecord | undefined = intent.state === "acting" ? intent : undefined;
        if (acting === undefined) {
          if (yield* deps.heardAwake(intent)) {
            const cancelled = yield* settle(intent.intentId, "waiting", (held) => ({
              ...held,
              state: "cancelled",
              cancelledAt: isoAt(nowMs),
              cancelReason: "heard-awake",
            }));
            if (cancelled !== undefined) settled.push(cancelled);
            continue;
          }
          // Under the lock, so a cancel either came first (nothing happens) or is refused.
          acting = yield* settle(intent.intentId, "waiting", (held) => ({
            ...held,
            state: "acting",
            actedAt: isoAt(nowMs),
          }));
          if (acting === undefined) continue;
        }
        // Takeovers replay by their operation ids, so a restart before the
        // intent is marked done only repeats them.
        const results = yield* deps.act(acting);
        // Counted before the done write, so a status read in between never sees
        // a done intent with no follow-up running and calls its threads settled.
        following.set(
          acting.sourceEnvironmentId,
          (following.get(acting.sourceEnvironmentId) ?? 0) + 1,
        );
        const done =
          (yield* settle(intent.intentId, "acting", (held) => ({
            ...held,
            state: "done",
            actedAt: held.actedAt ?? isoAt(nowMs),
            results: [...results],
          }))) ??
          // Nothing else moves an acting intent; if the write was lost, the hooks still run.
          ({ ...acting, state: "done", results: [...results] } satisfies AwayIntentRecord);
        settled.push(done);
        yield* PubSub.publish(published, done);
        yield* Effect.forEach(
          handlers,
          (handler) =>
            handler(done).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("An away intent hook failed", { intentId: done.intentId, cause }),
              ),
            ),
          { discard: true },
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const left = (following.get(done.sourceEnvironmentId) ?? 1) - 1;
              if (left <= 0) following.delete(done.sourceEnvironmentId);
              else following.set(done.sourceEnvironmentId, left);
            }),
          ),
        );
      }
      return settled;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away intents could not be checked", { cause }).pipe(Effect.as([])),
      ),
    );

    return {
      record,
      cancel,
      latestState: (sourceEnvironmentId) =>
        deps.store.read.pipe(
          Effect.map((file) => latestOf(file, sourceEnvironmentId)?.state ?? null),
        ),
      list: deps.store.read.pipe(Effect.map((file) => file.intents)),
      tick,
      onIntentDue: (handler) => Effect.sync(() => void handlers.push(handler)),
      due: Stream.fromPubSub(published),
      followUpRunning: (sourceEnvironmentId) =>
        Effect.sync(() => (following.get(sourceEnvironmentId) ?? 0) > 0),
    } satisfies AwayIntentsShape;
  });

/** The source's newest intent here. */
function latestOf(file: StoreFile, sourceEnvironmentId: string): AwayIntentRecord | undefined {
  return file.intents.findLast((intent) => intent.sourceEnvironmentId === sourceEnvironmentId);
}

/** The source projects an intent took over. */
function takenOverBy(intent: AwayIntentRecord): ProjectId[] {
  return (intent.results ?? [])
    .filter((result) => result.outcome === "handed-over")
    .map((result) => result.projectId);
}

/** Keeps every open intent and the newest settled ones. */
function trim(file: StoreFile): StoreFile {
  const settled = file.intents.filter(
    (intent) => intent.state !== "waiting" && intent.state !== "acting",
  );
  if (settled.length <= KEEP_SETTLED) return file;
  const drop = new Set(settled.slice(0, settled.length - KEEP_SETTLED).map((i) => i.intentId));
  return { ...file, intents: file.intents.filter((intent) => !drop.has(intent.intentId)) };
}

const decodeIntent = Schema.decodeUnknownOption(AwayIntentRequest);
export interface IntentAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Records an intent for `caller`. The projects kept are the source's copies
 * that are linked here and that the caller's grant covers; the rest are
 * answered as refused, so the source lists them as staying.
 */
export const recordIntent = (
  intents: Pick<AwayIntentsShape, "record">,
  caller: ReceiverCaller,
  raw: unknown,
  projects: ReadonlyArray<Project>,
): Effect.Effect<IntentAnswer> =>
  Effect.gen(function* () {
    const body = decodeIntent(raw);
    if (Option.isNone(body))
      return { status: 400, body: { error: "The request does not match this version." } };
    if (body.value.sourceEnvironmentId !== caller.sourceEnvironmentId)
      return {
        status: 403,
        body: { error: "A machine may record an away intent only for itself." },
      };
    const kept: ProjectId[] = [];
    const refused: ProjectId[] = [];
    for (const projectId of body.value.projectIds) {
      const copy = linkedCopyOf(projects, caller.sourceEnvironmentId, projectId);
      const covered =
        copy !== undefined &&
        (caller.grant === null ||
          projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, copy));
      (covered ? kept : refused).push(projectId);
    }
    const recorded = yield* intents
      .record(caller.sourceEnvironmentId, {
        graceMinutes: body.value.graceMinutes,
        projectIds: kept,
        threadIds: body.value.threadIds,
      })
      .pipe(Effect.result);
    if (recorded._tag === "Failure")
      return { status: 500, body: { error: recorded.failure.message } };
    return {
      status: 200,
      body: { intent: recorded.success satisfies AwayIntentRecord, refusedProjectIds: refused },
    };
  });
