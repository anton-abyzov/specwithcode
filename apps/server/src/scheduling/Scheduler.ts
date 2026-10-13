import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";

/** Sources load due work from their durable state; registration owns its execution lifetime. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>;
    /**
     * How much of `fromMs`..`toMs` (epoch ms) the scheduler sat out for the
     * latest update hold, so a source can tell work held back from work missed.
     * Test doubles may leave it out: nothing was held.
     */
    readonly heldMsBetween?: (fromMs: number, toMs: number) => Effect.Effect<number>;
  }
>()("studio/scheduling/Scheduler") {}

const make = Effect.gen(function* () {
  const sources = yield* Ref.make(new Map<symbol, Effect.Effect<void>>());
  // Scheduled tasks, usage-limit recovery and provider fallback all start work,
  // so none of them ticks while the service is held for an update.
  const updateHold = yield* ServiceUpdateHold.optional;
  // The latest span the scheduler skipped for the hold; `endMs` is null while it lasts.
  const heldSpan = yield* Ref.make<{ readonly startMs: number; readonly endMs: number | null }>({
    startMs: 0,
    endMs: 0,
  });
  const skipWhileHeld = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const held = yield* updateHold.isHeld;
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(heldSpan, (span) =>
        held === (span.endMs === null)
          ? span
          : held
            ? { startMs: now, endMs: null }
            : { ...span, endMs: now },
      );
      if (!held) yield* effect;
    });
  const heldMsBetween = (fromMs: number, toMs: number) =>
    Effect.gen(function* () {
      const span = yield* Ref.get(heldSpan);
      const endMs = span.endMs ?? (yield* Clock.currentTimeMillis);
      return Math.max(0, Math.min(toMs, endMs) - Math.max(fromMs, span.startMs));
    });
  const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <
    E,
    R,
  >(name: string, runDueWork: Effect.Effect<void, E, R>) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const permit = yield* Semaphore.make(1);
    const run = runDueWork.pipe(
      Effect.provideContext(context),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Scheduler source failed", { source: name, cause }),
      ),
      permit.withPermitsIfAvailable(1),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
    const id = Symbol(name);
    yield* Effect.acquireRelease(
      Ref.update(sources, (current) => new Map(current).set(id, run)),
      () =>
        Ref.update(sources, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    );
    // Due work waits for startup recovery, which would cancel runs it started. A
    // process started by an update install waits for the helper's gate too.
    yield* forkParked(skipWhileHeld(run));
  });
  const tick = Ref.get(sources).pipe(
    Effect.flatMap((current) => Effect.forEach(current.values(), (run) => run, { discard: true })),
    skipWhileHeld,
  );
  // One clock for all due-work sources. A slow source cannot block another
  // source or overlap itself, and no extra missed-tick backlog is queued.
  yield* forkParked(Effect.sleep("5 seconds").pipe(Effect.andThen(tick), Effect.forever));
  return Scheduler.of({ register, heldMsBetween });
});

export const layer = Layer.effect(Scheduler, make);
