import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeRevocationEpoch } from "./revocationEpoch.ts";

it.effect("refuses a sign-in that started before a revoke-all and lets a later one through", () =>
  Effect.gen(function* () {
    const gate = yield* makeRevocationEpoch;
    const started = yield* gate.current;
    yield* gate.revokeAll(Effect.void);

    const refused = yield* Effect.flip(
      gate.issueIfUnrevoked(started, Effect.succeed("session"), () => "revoked"),
    );
    assert.equal(refused, "revoked");

    const later = yield* gate.current;
    assert.equal(
      yield* gate.issueIfUnrevoked(later, Effect.succeed("session"), () => "revoked"),
      "session",
    );
  }),
);

it.effect("a revoke-all waits for an issue already holding the lock, then ends it", () =>
  Effect.gen(function* () {
    const gate = yield* makeRevocationEpoch;
    const issuing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const issued: Array<string> = [];
    const started = yield* gate.current;
    const issue = yield* gate
      .issueIfUnrevoked(
        started,
        Deferred.succeed(issuing, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => issued.push("session"))),
        ),
        () => "revoked",
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(issuing);
    const revoked: Array<ReadonlyArray<string>> = [];
    const revoke = yield* gate
      .revokeAll(Effect.sync(() => revoked.push([...issued])))
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(issue);
    yield* Fiber.join(revoke);
    // The revoke ran after the session existed, so it saw (and ends) it.
    assert.deepEqual(revoked, [["session"]]);
  }),
);
