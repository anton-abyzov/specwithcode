// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * A seat that turned Percy off, or undid, and left (1448 C1, AC-18): with a
 * one-way grant the seat still on the link cannot call it to learn that, so
 * the leaving seat's own reconciler call says so. Only that seat is dropped,
 * recorded as its departure; nothing is ever added.
 */
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { personalLinkIdForAccount } from "./personalLinkId.ts";
import {
  linkedTick,
  makeShareSeat,
  type Network,
  pairUp,
  reconcileRounds,
  type ShareSeat,
  USER,
} from "./personalShare.testkit.ts";

const LINK = personalLinkIdForAccount(USER);

const removedRefs = (seat: ShareSeat) =>
  (seat.binding()?.removedMembers ?? []).map(
    (entry) => `${entry.environmentId}:${entry.projectId}`,
  );

/**
 * Laptop can call Desktop; Desktop cannot call Laptop. With `tower`, Tower is
 * a third seat with own grants both ways to each of them.
 */
const seats = (options: { readonly tower?: boolean; readonly twoWay?: boolean } = {}) =>
  Effect.gen(function* () {
    const network: Network = new Map();
    const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
    const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
    const tower = options.tower ? yield* makeShareSeat(network, "tower", "Tower") : undefined;
    const all = [laptop, desktop, ...(tower ? [tower] : [])];
    for (const seat of all)
      seat.switchOn(
        all.filter((other) => other !== seat).map((other) => other.environmentId),
        seat === laptop ? { start: true } : {},
      );
    pairUp(laptop, desktop, options.twoWay ? undefined : { aIssuesB: undefined, bIssuesA: "own" });
    if (tower) {
      pairUp(laptop, tower);
      pairUp(desktop, tower);
    }
    yield* reconcileRounds(all, 6);
    for (const seat of all) {
      assert.strictEqual(seat.identity()?.id, LINK);
      assert.lengthOf(seat.members(), all.length);
    }
    return { laptop, desktop, tower, all };
  });

/** The owner turns Percy off on `seat`, which leaves the link, as `PersonalShare.setShared` does. */
const turnOff = (seat: ShareSeat) =>
  Effect.gen(function* () {
    seat.switchOff();
    yield* seat.unlink;
    assert.lengthOf(seat.members(), 1);
  });

describe("PersonalShareEngine: a departed seat that the others cannot call", () => {
  it.effect("two seats, one-way grant: the seat still linked drops the one that left", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats();
      yield* turnOff(laptop);
      // Only Laptop can call: Desktop learns it left from Laptop's own call.
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop"]);
      assert.notStrictEqual(desktop.identity()?.id, LINK);
      // The departure is remembered as the link it left, as the fenced path does.
      assert.include(
        (desktop.binding()?.formerLinks ?? []).map((entry) => entry.logicalProjectId),
        LINK,
      );
    }),
  );

  it.effect("three seats: only the departed seat goes, recorded as removed now", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats({ tower: true });
      yield* turnOff(laptop);
      const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-tower"]);
      assert.strictEqual(desktop.identity()?.id, LINK);
      assert.deepStrictEqual(removedRefs(desktop), ["env-laptop:percy-laptop"]);
      assert.strictEqual(desktop.binding()?.removedMembers?.[0]?.removedAt, now);
    }),
  );

  it.effect("records the same departure the two-way fenced path records", () =>
    Effect.gen(function* () {
      // Two-way: Desktop calls Laptop in LinkedPeerSync and is told it left.
      const fenced = yield* seats({ tower: true, twoWay: true });
      yield* turnOff(fenced.laptop);
      yield* linkedTick(fenced.desktop, fenced.all);
      // One-way: Desktop learns it from Laptop's share call.
      const answered = yield* seats({ tower: true });
      yield* turnOff(answered.laptop);
      yield* answered.laptop.engine.exchange(answered.desktop.environmentId);
      assert.deepStrictEqual(answered.desktop.members(), fenced.desktop.members());
      // The join order differs with the grants, so members compare as a set.
      const sorted = (seat: ShareSeat) => {
        const identity = seat.identity()!;
        return {
          ...identity,
          members: identity.members.toSorted((a, b) =>
            a.environmentId.localeCompare(b.environmentId),
          ),
        };
      };
      assert.deepStrictEqual(sorted(answered.desktop), sorted(fenced.desktop));
      // Both runs share one test clock: each entry is stamped when its own departure was seen.
      const entries = (seat: ShareSeat) =>
        (seat.binding()?.removedMembers ?? []).map(({ removedAt: _at, ...entry }) => entry);
      assert.deepStrictEqual(entries(answered.desktop), entries(fenced.desktop));
      assert.lengthOf(entries(answered.desktop), 1);
    }),
  );

  it.effect("the seat joins again once its owner turns Percy on there again", () =>
    Effect.gen(function* () {
      const { laptop, desktop, tower, all } = yield* seats({ tower: true });
      yield* turnOff(laptop);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-tower"]);
      yield* TestClock.adjust("1 minute");
      const later = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      laptop.switchOn([desktop.environmentId, tower!.environmentId], { enabledAt: later });
      yield* reconcileRounds(all, 6);
      for (const seat of all) {
        assert.strictEqual(seat.identity()?.id, LINK);
        assert.deepStrictEqual(seat.members(), ["env-desktop", "env-laptop", "env-tower"]);
      }
    }),
  );
});

describe("PersonalShareEngine: a refusal never removes anyone else", () => {
  it.effect("a caller that is not a member changes nothing", () =>
    Effect.gen(function* () {
      const network: Network = new Map();
      const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
      const tower = yield* makeShareSeat(network, "tower", "Tower");
      const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
      desktop.switchOn([tower.environmentId, laptop.environmentId], { start: true });
      tower.switchOn([desktop.environmentId]);
      pairUp(desktop, tower);
      pairUp(laptop, desktop, { aIssuesB: undefined, bIssuesA: "own" });
      yield* reconcileRounds([desktop, tower], 6);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-tower"]);
      // Laptop, listed but never linked, calls with its switch off.
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-tower"]);
      assert.deepStrictEqual(removedRefs(desktop), []);
    }),
  );

  it.effect("a member that refuses for another reason stays", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats();
      // The owner drops Desktop from Laptop's list: Laptop refuses as not confirmed.
      laptop.switchOn([EnvironmentId.make("env-elsewhere")], { start: true });
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
      assert.deepStrictEqual(removedRefs(desktop), []);
    }),
  );

  it.effect("a member calling with a team grant is refused before its state is read", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats();
      desktop.issue(laptop.environmentId, "team");
      yield* turnOff(laptop);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
    }),
  );

  it.effect("a member signed in to another Connect account is refused the same way", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats();
      laptop.setHeader("user_someone_else");
      yield* turnOff(laptop);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
    }),
  );

  it.effect("a member with only its assistant setting off is still linked, so it stays", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* seats({ tower: true });
      // It refuses with switch_off, like a seat that left, but says it is still linked.
      laptop.setAideEnabled(false);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop", "env-tower"]);
    }),
  );
});
