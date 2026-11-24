// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * The one Percy joining across several seats, end to end in process (1448
 * T-14, D-15, D-16): each seat runs the reconciler and then `LinkedPeerSync`
 * every minute, as the server does. A join saves its copies once per series,
 * merges without loss, writes the link last and is safe to repeat; a lapse
 * pauses; a seat that leaves and comes back joins again without new
 * renamed copies.
 */
import { assert, describe, it } from "@effect/vitest";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { personalLinkIdForAccount } from "./personalLinkId.ts";
import {
  makeShareSeat,
  type Network,
  pairUp,
  serverRounds,
  type ShareSeat,
  USER,
} from "./personalShare.testkit.ts";

const LINK = personalLinkIdForAccount(USER);

const beforeLink = (seat: ShareSeat) =>
  seat.points.filter((point) => point.reason === "before-link").length;

const hasClashMarkers = (files: Record<string, string>) =>
  Object.values(files).some((content) => /^(<{7}|={7}|>{7})/m.test(content));

const laterThanNow = Effect.map(Clock.currentTimeMillis, (now) =>
  DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)),
);

/** Desktop starts with memory; Laptop has an index and a clashing note; Tower has nothing. */
const trio = Effect.gen(function* () {
  const network: Network = new Map();
  const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
  const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
  const tower = yield* makeShareSeat(network, "tower", "Tower");
  const all = [desktop, laptop, tower];
  for (const seat of all)
    seat.switchOn(
      all.filter((other) => other !== seat).map((other) => other.environmentId),
      seat === desktop ? { start: true } : {},
    );
  pairUp(desktop, laptop);
  pairUp(desktop, tower);
  pairUp(laptop, tower);
  yield* desktop.write("MEMORY.md", "# Memory\n\n- [Notes](notes.md): desktop notes\n");
  yield* desktop.write("notes.md", "Desktop notes.\n");
  yield* desktop.write("travel.md", "Window seat.\n");
  yield* laptop.write("MEMORY.md", "# Memory\n\n- [Notes](notes.md): laptop notes\n");
  yield* laptop.write("notes.md", "Laptop notes.\n");
  return { desktop, laptop, tower, all };
});

describe("PersonalShare: several seats join one Percy", () => {
  it.effect(
    "ends with the same files everywhere, both clashing notes kept, nothing renamed on the starter",
    () =>
      Effect.gen(function* () {
        const { desktop, laptop, tower, all } = yield* trio;
        yield* serverRounds(all, 6);
        for (const seat of all) {
          assert.strictEqual(seat.identity()?.id, LINK);
          assert.deepStrictEqual(seat.members(), ["env-desktop", "env-laptop", "env-tower"]);
        }
        const onDesktop = yield* desktop.contents;
        assert.deepStrictEqual(yield* laptop.contents, onDesktop);
        assert.deepStrictEqual(yield* tower.contents, onDesktop);
        assert.isFalse(hasClashMarkers(onDesktop));
        // The starter's note kept its name; the joiner's clashing note kept its content under its own.
        const laptopNotes = renamedMemoryName("notes.md", "Laptop", laptop.environmentId);
        assert.strictEqual(onDesktop["notes.md"], "Desktop notes.\n");
        assert.strictEqual(onDesktop[laptopNotes], "Laptop notes.\n");
        assert.strictEqual(onDesktop["travel.md"], "Window seat.\n");
        assert.include(onDesktop["MEMORY.md"]!, "desktop notes");
        assert.include(onDesktop["MEMORY.md"]!, laptopNotes);
        // Only the joiner renamed anything.
        assert.isFalse(Object.keys(onDesktop).some((name) => name.includes("desktop")));
        assert.strictEqual(desktop.current().title, "Percy");
        // One before-link point and one database copy per seat for this series.
        for (const seat of all) {
          assert.strictEqual(beforeLink(seat), 1, seat.label);
          assert.lengthOf(seat.snapshots, 1, seat.label);
        }
      }),
  );

  it.effect("a link write that fails is tried again, without a second copy or rename", () =>
    Effect.gen(function* () {
      const { desktop, laptop } = yield* trio;
      const pair = [desktop, laptop];
      laptop.switchOn([desktop.environmentId]);
      desktop.switchOn([laptop.environmentId], { start: true });
      laptop.failNextLinkWrites(1);
      yield* serverRounds(pair, 1);
      // The merge ran and the copies were saved; the link itself was not written.
      assert.notStrictEqual(laptop.identity()?.id, LINK);
      assert.strictEqual(beforeLink(laptop), 1);
      const laptopNotes = renamedMemoryName("notes.md", "Laptop", laptop.environmentId);
      assert.strictEqual((yield* laptop.contents)[laptopNotes], "Laptop notes.\n");
      assert.include(laptop.refusals, "link write failed");
      yield* serverRounds(pair, 3);
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
      assert.strictEqual(beforeLink(laptop), 1);
      assert.lengthOf(laptop.snapshots, 1);
      const names = Object.keys(yield* laptop.contents);
      assert.lengthOf(
        names.filter((name) => name !== "notes.md" && name.startsWith("notes")),
        1,
      );
      assert.deepStrictEqual(yield* laptop.contents, yield* desktop.contents);
    }),
  );

  it.effect("an unreadable Connect sign-in pauses a joined seat: it stays, and saves nothing", () =>
    Effect.gen(function* () {
      const { desktop, laptop, tower, all } = yield* trio;
      yield* serverRounds(all, 5);
      assert.strictEqual(laptop.identity()?.id, LINK);
      const points = laptop.points.length;
      const revision = laptop.current().workspaceSettings!.revision;
      laptop.setAccount({ status: "unknown" });
      yield* serverRounds(all, 3);
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.deepStrictEqual(laptop.members(), ["env-desktop", "env-laptop", "env-tower"]);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop", "env-tower"]);
      assert.deepStrictEqual(tower.members(), ["env-desktop", "env-laptop", "env-tower"]);
      assert.strictEqual(laptop.points.length, points);
      assert.strictEqual(laptop.current().workspaceSettings!.revision, revision);
      const state = (yield* laptop.states.states).get(desktop.environmentId);
      assert.include(state?.detail ?? "", "Paused");
      // Back again: in step, still one before-link point.
      laptop.setAccount({ status: "linked", cloudUserId: USER });
      yield* serverRounds(all, 2);
      assert.strictEqual((yield* laptop.states.states).get(desktop.environmentId)?.state, "joined");
      assert.strictEqual(beforeLink(laptop), 1);
    }),
  );

  it.effect("switched off and on again, a seat joins again without new renamed copies", () =>
    Effect.gen(function* () {
      const { desktop, laptop, tower, all } = yield* trio;
      yield* serverRounds(all, 6);
      const settled = yield* desktop.contents;
      // The owner turns Percy off on Laptop: the switch goes off, then the seat leaves.
      laptop.switchOff();
      yield* laptop.unlink;
      yield* serverRounds(all, 3);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-tower"]);
      assert.deepStrictEqual(tower.members(), ["env-desktop", "env-tower"]);
      assert.notStrictEqual(laptop.identity()?.id, LINK);
      // On again, later than the others noted it left.
      laptop.switchOn([desktop.environmentId, tower.environmentId], {
        enabledAt: yield* laterThanNow,
      });
      yield* serverRounds(all, 5);
      for (const seat of all)
        assert.deepStrictEqual(seat.members(), ["env-desktop", "env-laptop", "env-tower"]);
      const after = yield* laptop.contents;
      assert.deepStrictEqual(after, yield* desktop.contents);
      assert.deepStrictEqual(Object.keys(after).toSorted(), Object.keys(settled).toSorted());
      assert.isFalse(hasClashMarkers(after));
      // A new series: one more before-link point for it, none for the others.
      assert.strictEqual(beforeLink(laptop), 2);
      assert.strictEqual(beforeLink(desktop), 1);
      assert.strictEqual(beforeLink(tower), 1);
    }),
  );
});

/** Deletes a file on `seat` as the owner would before any link: it leaves a tombstone. */
const deleteBeforeLink = (seat: ShareSeat, name: string) =>
  Effect.gen(function* () {
    const file = yield* seat.workspace.readMemory({ projectId: seat.projectId, name });
    yield* seat.workspace.deleteMemory({
      projectId: seat.projectId,
      name,
      expectedRevision: file.revision,
    });
    assert.isDefined((yield* seat.histories.read(seat.projectId)).tombstones[name]);
  });

describe("PersonalShare: the first join honours no deletion made before the link", () => {
  it.effect("a file only one seat holds stays on both, whichever seat deleted its copy", () =>
    Effect.gen(function* () {
      const network: Network = new Map();
      const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
      const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
      desktop.switchOn([laptop.environmentId], { start: true });
      laptop.switchOn([desktop.environmentId]);
      pairUp(desktop, laptop);
      // Copied userdata: both Percys hold the same two files.
      for (const seat of [desktop, laptop]) {
        yield* seat.write("old-trip.md", "Lisbon, May.\n");
        yield* seat.write("packing.md", "Passport, charger.\n");
      }
      // Before linking, the joiner deleted one and the starter the other.
      yield* deleteBeforeLink(laptop, "old-trip.md");
      yield* deleteBeforeLink(desktop, "packing.md");

      yield* serverRounds([desktop, laptop], 6);
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
      const expected = { "old-trip.md": "Lisbon, May.\n", "packing.md": "Passport, charger.\n" };
      assert.deepStrictEqual(yield* desktop.contents, expected);
      assert.deepStrictEqual(yield* laptop.contents, expected);
    }),
  );
});
