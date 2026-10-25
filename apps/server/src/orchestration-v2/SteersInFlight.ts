import type { MessageId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface SteersInFlightShape {
  /** Marks `messageId`'s steer in flight while `effect` runs (the provider call and its outcome). */
  readonly track: <A, E, R>(
    messageId: MessageId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Keeps a provider acknowledgement through retries until its receipt commits. */
  readonly accept: (messageId: MessageId) => Effect.Effect<void>;
  readonly wasAccepted: (messageId: MessageId) => Effect.Effect<boolean>;
  readonly forget: (messageId: MessageId) => Effect.Effect<void>;
  readonly inFlight: (messageId: MessageId) => Effect.Effect<boolean>;
  /** Waits until `messageId`'s steer has an outcome; returns at once with none in flight. */
  readonly awaitSettled: (messageId: MessageId) => Effect.Effect<void>;
}

/**
 * Steer now leaves the queued row in place until the provider answers. While
 * that answer is pending nobody knows whether the provider has the message, so
 * the queue must not deliver the row: a turn that ends meanwhile would start it
 * and an accepted steer would then deliver it a second time. The default knows
 * no steer, so code built without the shared layer behaves as before; the live
 * layer must be the same reference where steers run and where the queue starts.
 */
export class SteersInFlight extends Context.Reference<SteersInFlightShape>(
  "specweave-studio/orchestration-v2/SteersInFlight",
  {
    defaultValue: () => ({
      track: (_messageId, effect) => effect,
      accept: () => Effect.void,
      wasAccepted: () => Effect.succeed(false),
      forget: () => Effect.void,
      inFlight: () => Effect.succeed(false),
      awaitSettled: () => Effect.void,
    }),
  },
) {}

const make = Effect.gen(function* () {
  const accepted = yield* Ref.make<ReadonlySet<MessageId>>(new Set());
  const steers = yield* Ref.make<
    ReadonlyMap<MessageId, { readonly count: number; readonly settled: Deferred.Deferred<void> }>
  >(new Map());
  const begin = (messageId: MessageId) =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      yield* Ref.update(steers, (current) => {
        const next = new Map(current);
        const existing = next.get(messageId);
        next.set(
          messageId,
          existing === undefined
            ? { count: 1, settled }
            : { ...existing, count: existing.count + 1 },
        );
        return next;
      });
    });
  const end = (messageId: MessageId) =>
    Effect.gen(function* () {
      const done = yield* Ref.modify(steers, (current) => {
        const existing = current.get(messageId);
        if (existing === undefined) return [undefined, current] as const;
        const next = new Map(current);
        if (existing.count > 1) {
          next.set(messageId, { ...existing, count: existing.count - 1 });
          return [undefined, next] as const;
        }
        next.delete(messageId);
        return [existing.settled, next] as const;
      });
      if (done !== undefined) yield* Deferred.succeed(done, undefined);
    });
  return {
    track: (messageId, effect) =>
      Effect.acquireUseRelease(
        begin(messageId),
        () => effect,
        () => end(messageId),
      ),
    accept: (messageId) => Ref.update(accepted, (current) => new Set([...current, messageId])),
    wasAccepted: (messageId) =>
      Ref.get(accepted).pipe(Effect.map((current) => current.has(messageId))),
    forget: (messageId) =>
      Ref.update(accepted, (current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      }),
    inFlight: (messageId) => Ref.get(steers).pipe(Effect.map((current) => current.has(messageId))),
    awaitSettled: (messageId) =>
      Ref.get(steers).pipe(
        Effect.flatMap((current) => {
          const existing = current.get(messageId);
          return existing === undefined ? Effect.void : Deferred.await(existing.settled);
        }),
      ),
  } satisfies SteersInFlightShape;
});

export const layer = Layer.effect(SteersInFlight, make);
