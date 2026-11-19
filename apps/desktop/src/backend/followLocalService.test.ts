import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AttachedLocalService } from "./DesktopLocalService.ts";
import {
  FOLLOW_LOCAL_SERVICE_MISSES,
  checkAttachedLocalService,
  type FollowLocalServiceInput,
} from "./followLocalService.ts";

class ExposureRefused extends Data.TaggedError("ExposureRefused")<{}> {}

const service = (origin: string, pid: number) =>
  ({
    baseDir: "/home/anton/.specwithcode/ministorm",
    runtime: { pid, port: Number(new URL(origin).port), origin },
    descriptor: { environmentId: "linux-mini", serverVersion: "1.0.302" },
    httpBaseUrl: new URL(origin),
    serviceManaged: true,
  }) as unknown as AttachedLocalService;

const harness = (input: {
  readonly answers: boolean;
  readonly moved: AttachedLocalService | null;
  readonly reattachFails?: boolean;
}) => {
  let current: AttachedLocalService = service("http://127.0.0.1:36465", 100);
  const reattached: AttachedLocalService[] = [];
  let relocations = 0;
  const follow: FollowLocalServiceInput = {
    attached: Effect.sync(() => Option.some(current)),
    answers: () => Effect.succeed(input.answers),
    relocate: () =>
      Effect.sync(() => {
        relocations += 1;
        return Option.fromNullishOr(input.moved);
      }),
    reattach: (next) =>
      input.reattachFails
        ? Effect.fail(new ExposureRefused())
        : Effect.sync(() => {
            reattached.push(next);
            current = next;
          }),
  };
  return { follow, reattached, relocations: () => relocations };
};

const runChecks = (follow: FollowLocalServiceInput, checks: number) =>
  Effect.gen(function* () {
    let missed = 0;
    for (let i = 0; i < checks; i += 1) missed = yield* checkAttachedLocalService(follow, missed);
    return missed;
  });

describe("checkAttachedLocalService", () => {
  it.effect("follows the service to its new port after a fleet update", () =>
    Effect.gen(function* () {
      const moved = service("http://127.0.0.1:8319", 200);
      const h = harness({ answers: false, moved });
      const missed = yield* runChecks(h.follow, FOLLOW_LOCAL_SERVICE_MISSES);
      assert.strictEqual(missed, 0);
      assert.deepStrictEqual(h.reattached, [moved]);
    }),
  );

  it.effect("waits out a short blip before reading the home again", () =>
    Effect.gen(function* () {
      const h = harness({ answers: false, moved: service("http://127.0.0.1:8319", 200) });
      const missed = yield* runChecks(h.follow, FOLLOW_LOCAL_SERVICE_MISSES - 1);
      assert.strictEqual(missed, FOLLOW_LOCAL_SERVICE_MISSES - 1);
      assert.strictEqual(h.relocations(), 0);
      assert.strictEqual(h.reattached.length, 0);
    }),
  );

  it.effect("leaves a service that answers alone", () =>
    Effect.gen(function* () {
      const h = harness({ answers: true, moved: null });
      const missed = yield* runChecks(h.follow, FOLLOW_LOCAL_SERVICE_MISSES + 2);
      assert.strictEqual(missed, 0);
      assert.strictEqual(h.relocations(), 0);
    }),
  );

  it.effect("keeps checking while the home names no new address", () =>
    Effect.gen(function* () {
      const h = harness({ answers: false, moved: null });
      const missed = yield* runChecks(h.follow, FOLLOW_LOCAL_SERVICE_MISSES + 1);
      assert.strictEqual(missed, FOLLOW_LOCAL_SERVICE_MISSES + 1);
      assert.strictEqual(h.relocations(), 2);
      assert.strictEqual(h.reattached.length, 0);
    }),
  );

  it.effect("fails a reattach that did not go through, so the next check retries it", () =>
    Effect.gen(function* () {
      const h = harness({
        answers: false,
        moved: service("http://127.0.0.1:8319", 200),
        reattachFails: true,
      });
      const result = yield* checkAttachedLocalService(
        h.follow,
        FOLLOW_LOCAL_SERVICE_MISSES - 1,
      ).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
