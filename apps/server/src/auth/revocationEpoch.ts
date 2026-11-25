import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Orders "sign out every other client" against sign-ins already under way.
 *
 * A sign-in reads `current` when it starts (a pairing code spent, an MCP code
 * minted) and issues its session through `issueIfUnrevoked`. Revoke-all bumps
 * the counter under the same lock before it ends sessions and codes, so a
 * sign-in that began before the revoke never gets a session after it.
 */
export interface RevocationEpoch {
  readonly current: Effect.Effect<number>;
  readonly issueIfUnrevoked: <A, E, R, E2>(
    startedAt: number,
    issue: Effect.Effect<A, E, R>,
    refused: () => E2,
  ) => Effect.Effect<A, E | E2, R>;
  readonly revokeAll: <A, E, R>(revoke: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const makeRevocationEpoch: Effect.Effect<RevocationEpoch> = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  let epoch = 0;
  return {
    current: Effect.sync(() => epoch),
    issueIfUnrevoked: (startedAt, issue, refused) =>
      lock.withPermits(1)(
        Effect.suspend(() => (epoch === startedAt ? issue : Effect.fail(refused()))),
      ),
    revokeAll: (revoke) =>
      lock.withPermits(1)(
        Effect.sync(() => {
          epoch += 1;
        }).pipe(Effect.andThen(revoke)),
      ),
  } satisfies RevocationEpoch;
});
