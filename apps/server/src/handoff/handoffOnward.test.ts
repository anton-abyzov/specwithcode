/**
 * A handed-off worker's result is pulled by the machine its launcher is on.
 * So a takeover says who waits and which machines that one can ask, the
 * receiver keeps it with the continuation, and a later move from there is
 * declined, before anything about the thread changes, when it would take the
 * work out of that reach. The world is handoffFollow.testkit.ts: here its
 * "source" also plays the machine in the middle, holding a continuation that
 * arrived with a launcher of its own.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { allow, quiet, rows, settled } from "../fleet/remoteWorkers.testkit.ts";
import {
  removeStages,
  source,
  type Stage,
  stage,
  target,
  worker,
} from "./handoffFollow.testkit.ts";

afterEach(removeStages);

const LIVE = { timeout: 30_000 };

const begin = (life: ReturnType<Stage["boot"]>) =>
  Effect.andThen(allow("auto", target.id), life.start);

/** The thread arrived here by a takeover that said who waits for its result. */
const arrivedWith = (
  s: Stage,
  launcher: { readonly environmentId: string; readonly label: string; readonly reachable: ReadonlyArray<string> },
) => {
  s.fixture.workerIs = "continuation";
  const record = s.documents.source.threads[worker];
  s.documents.source = {
    ...s.documents.source,
    threads: { ...s.documents.source.threads, [worker]: { ...record, launcher } },
  } as never;
};

describe("a handed-off worker that moves again", () => {
  it.live(
    "says in the takeover who waits for the result and which machines that one can ask, and the receiver keeps it",
    () => {
      const s = stage();
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        const moved = yield* handOff;
        const waits = {
          environmentId: source,
          label: "Source",
          reachable: [target.environmentId],
        };
        expect(s.network.takeovers).toHaveLength(1);
        expect((s.network.takeovers[0] as { launcher?: unknown }).launcher).toEqual(waits);
        const kept = s.documents.target.threads[moved.threadId] as { launcher?: unknown };
        expect(kept.launcher).toEqual(waits);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "is not handed off while the source cannot read which machines it can ask: an unread fleet is not an empty one",
    () => {
      const s = stage();
      s.network.fleetUnread = true;
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        const outcome = yield* Effect.result(handOff);
        // Sent with an empty list, the target would decline every later move for good.
        expect(s.network.takeovers).toEqual([]);
        expect(s.launches).toEqual([]);
        expect(outcome._tag).toBe("Failure");
        const record = s.documents.source.threads[worker];
        expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
        expect(record?.continuedOn).toBeNull();
        // Read again, the same move is made and names the machine it went to.
        s.network.fleetUnread = false;
        yield* handOff;
        expect((s.network.takeovers[0] as { launcher?: unknown }).launcher).toMatchObject({
          reachable: [target.environmentId],
        });
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "is not handed to a machine its launcher cannot ask: declined before the thread is held, with the reason",
    () => {
      const s = stage();
      arrivedWith(s, { environmentId: "env-launcher", label: "Launcher", reachable: ["env-other"] });
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        const outcome = yield* Effect.result(handOff);
        // Nothing left this machine, and the work is still its own.
        expect(s.network.takeovers).toEqual([]);
        expect(s.launches).toEqual([]);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag !== "Failure") return;
        expect(outcome.failure.message).toContain("a thread on Launcher waits for this work's result");
        expect(outcome.failure.message).toContain("back to Launcher");
        const record = s.documents.source.threads[worker];
        expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
        expect(record?.checkpoint).toBeNull();
        expect(record?.continuedOn).toBeNull();
        expect(yield* rows).toEqual([]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "names only machines where the source holds a work grant for this project, and the source gets the result once",
    () => {
      const s = stage();
      // Listed by the source, but that machine never let the source run work there.
      s.network.ungranted.push({
        machineId: "machine-listed-only",
        environmentId: EnvironmentId.make("env-listed-only"),
        label: "Listed only",
      });
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOff } = yield* begin(life);
        yield* handOff;
        // So the target declines a later move there, as for any machine outside the reach.
        expect((s.network.takeovers[0] as { launcher?: unknown }).launcher).toEqual({
          environmentId: source,
          label: "Source",
          reachable: [target.environmentId],
        });
        yield* s.finish();
        yield* settled(life.world, rows, (current) => current[0]?.state === "idle");
        yield* quiet(life.world);
        expect(s.kept).toHaveLength(1);
        expect(s.kept[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  it.live(
    "is not continued under another model on this machine while a thread elsewhere waits: the launcher follows this thread",
    () => {
      const s = stage();
      arrivedWith(s, {
        environmentId: "env-launcher",
        label: "Launcher",
        reachable: [target.environmentId],
      });
      const life = s.boot();
      return Effect.gen(function* () {
        const { handOffHere } = yield* begin(life);
        const outcome = yield* Effect.result(handOffHere);
        expect(outcome._tag).toBe("Failure");
        if (outcome._tag !== "Failure") return;
        expect(outcome.failure.message).toContain("a thread on Launcher waits for this work's result");
        // Nothing about the thread changed: it is still this machine's, and never held.
        expect(s.network.takeovers).toEqual([]);
        expect(s.launches).toEqual([]);
        const record = s.documents.source.threads[worker];
        expect(record?.lease).toMatchObject({ state: "active", epoch: 1 });
        expect(record?.checkpoint).toBeNull();
        expect(record?.continuedOn).toBeNull();
        expect(yield* rows).toEqual([]);
      }).pipe(Effect.provide(life.layer));
    },
    LIVE,
  );

  for (const route of ["to a machine its launcher can ask", "back to its launcher's machine"] as const) {
    it.live(
      `is handed ${route}, and the takeover passes on who waits`,
      () => {
        const s = stage();
        const waits =
          route === "back to its launcher's machine"
            ? { environmentId: target.environmentId, label: "Target", reachable: [] }
            : { environmentId: "env-launcher", label: "Launcher", reachable: [target.environmentId] };
        arrivedWith(s, waits);
        const life = s.boot();
        return Effect.gen(function* () {
          const { handOff } = yield* begin(life);
          const moved = yield* handOff;
          expect(s.launches.map((launch) => launch.threadId)).toEqual([moved.threadId]);
          expect((s.network.takeovers[0] as { launcher?: unknown }).launcher).toEqual(waits);
          // Nobody on this machine waits: it follows nothing.
          expect(yield* rows).toEqual([]);
        }).pipe(Effect.provide(life.layer));
      },
      LIVE,
    );
  }
});
