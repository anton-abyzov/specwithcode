/**
 * Where a handed-off thread's result comes from when the work moves again,
 * which run is its result, and how often its launcher is told. The stage is
 * handoffFollower.testkit.ts: the source is this server, and a thread handed
 * back to it is one of its own threads.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { continuationThreadId } from "../handoff/HandoffReceiver.ts";
import {
  follow,
  handedOff,
  keptCount,
  LAUNCHER,
  removeStages,
  ROW,
  seed,
  stage,
  THREAD,
} from "./handoffFollower.testkit.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import { allow, quiet, ROLES, rows, settled } from "./remoteWorkers.testkit.ts";

afterEach(removeStages);

const LIVE = { timeout: 20_000 };
/** For a state that, on a server without the rule, never comes. */
const SHORT = { timeout: 8_000 };

/** The row once its following ended, one way or the other. */
const ended = (world: Parameters<typeof settled>[0]) =>
  Effect.map(
    settled(world, rows, (current) => current[0]?.state === "idle" || current[0]?.state === "stopped"),
    (current) => current[0],
  );

describe("a handed-off thread that moves again", () => {
  it.live(
    "is followed on this machine when the target hands it back, and reports once",
    () => {
      const { target, here, kept, boot } = stage();
      target.create(THREAD);
      target.start(THREAD);
      target.handOn(THREAD, { environmentId: ROLES.self, label: "Source", epoch: 3 });
      // The takeover created the continuation here, as the system: not a launched worker.
      const back = continuationThreadId(ROLES.target.environmentId, THREAD, 3);
      here.create(back, "local-project");
      const run = here.start(back, { creationSource: "server" });
      here.set(back, run.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        const row = yield* ended(world);
        expect(row).toMatchObject({
          id: ROW,
          state: "idle",
          callerThreadId: LAUNCHER,
          environmentId: ROLES.self,
          remoteThreadId: back,
          lastStatus: "completed",
          lastError: null,
        });
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ threadId: LAUNCHER });
        expect(kept[0]?.text).toContain("finished: completed");
        yield* quiet(world);
        expect(kept).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "waits for a run still going on this machine after the hand-back, saying nothing until it ends",
    () => {
      const { target, here, kept, boot } = stage();
      target.create(THREAD);
      target.start(THREAD);
      target.handOn(THREAD, { environmentId: ROLES.self, label: "Source", epoch: 3 });
      const back = continuationThreadId(ROLES.target.environmentId, THREAD, 3);
      here.create(back, "local-project");
      const run = here.start(back, { creationSource: "server" });
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        const [going] = yield* settled(
          world,
          rows,
          (current) => current[0]?.state === "stopped" || current[0]?.followedRunId === run.id,
        );
        expect(going).toMatchObject({ state: "following", remoteThreadId: back });
        expect(kept).toEqual([]);
        here.set(back, run.id, "failed");
        yield* settled(world, keptCount(kept), (count) => count >= 1);
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain("finished: failed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "is followed from this machine on to the next one when it is handed on again from here",
    () => {
      const { target, onward, here, kept, boot } = stage();
      target.create(THREAD);
      target.start(THREAD);
      target.handOn(THREAD, { environmentId: ROLES.self, label: "Source", epoch: 3 });
      const back = continuationThreadId(ROLES.target.environmentId, THREAD, 3);
      here.create(back, "local-project");
      here.start(back, { creationSource: "server" });
      here.handOn(back, { environmentId: onward.environmentId, label: "Onward", epoch: 4 });
      const next = continuationThreadId(ROLES.self, back, 4);
      onward.create(next);
      const run = onward.start(next);
      onward.set(next, run.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* allow("auto", "onward");
        yield* follow(handedOff());
        const row = yield* ended(world);
        expect(row).toMatchObject({ state: "idle", machineId: "onward", remoteThreadId: next });
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain("on Onward finished: completed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "asks again when its own fleet could not be read, and still follows the work onward",
    () => {
      const { target, onward, kept, boot } = stage();
      target.create(THREAD);
      target.start(THREAD);
      target.handOn(THREAD, { environmentId: onward.environmentId, label: "Onward", epoch: 3 });
      const next = continuationThreadId(ROLES.target.environmentId, THREAD, 3);
      onward.create(next);
      const run = onward.start(next);
      onward.set(next, run.id, "completed");
      const { world, layer } = boot();
      // The read that looks the next machine up fails once; the machine is configured.
      let failures = 1;
      let failed = 0;
      world.fleetReadFails = () => {
        if (target.asked(THREAD, "studio_thread_read") === 0 || failures === 0) return false;
        failures -= 1;
        failed += 1;
        return true;
      };
      return Effect.gen(function* () {
        yield* allow("auto", "onward");
        yield* follow(handedOff());
        const row = yield* ended(world);
        expect(failed).toBe(1);
        expect(row).toMatchObject({
          state: "idle",
          machineId: "onward",
          remoteThreadId: next,
          lastError: null,
        });
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ threadId: LAUNCHER });
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "keeps its route while a copy says handed on but not yet under which move, on a machine visited before",
    () => {
      // Source -> onward (2) -> target (3) -> onward again (4). The row follows the target's copy.
      const { target, onward, kept, boot } = stage();
      const copy = target.create(THREAD);
      copy.cameFrom = [{ environmentId: onward.environmentId, epoch: 2 }];
      target.start(THREAD);
      // The fence is written; the history entry of this move is not yet.
      target.handOn(
        THREAD,
        { environmentId: onward.environmentId, label: "Onward", epoch: 4 },
        { historyWritten: false },
      );
      const next = continuationThreadId(ROLES.target.environmentId, THREAD, 4);
      onward.create(next);
      const run = onward.start(next);
      onward.set(next, run.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* allow("auto", "onward");
        yield* follow(handedOff({ handoff: { sourceThreadId: "thread-1", epoch: 1, awaiting: "run" } }));
        const [between] = yield* settled(
          world,
          rows,
          (current) =>
            current[0]?.remoteThreadId !== THREAD ||
            target.asked(THREAD, "studio_thread_read") >= 3,
        );
        // Asked again where it was: the earlier visit at epoch 2 names no continuation.
        expect(between).toMatchObject({
          state: "following",
          machineId: ROLES.target.id,
          remoteThreadId: THREAD,
        });
        expect(between?.lastError).toContain("not yet said");
        expect(kept).toEqual([]);
        copy.historyWritten = true;
        const row = yield* ended(world);
        expect(row).toMatchObject({
          state: "idle",
          machineId: "onward",
          remoteThreadId: next,
          lastError: null,
        });
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain("on Onward finished: completed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );
});

describe("the run that is a handed-off thread's result", () => {
  /**
   * The continuation's first message carries the handoff note, so its run is
   * the handoff's. A message queued after it is moved ahead: it starts first
   * and keeps the later ordinal.
   */
  const reordered = (target: ReturnType<typeof stage>["target"]) => {
    target.create(THREAD);
    const first = target.start(THREAD, { status: "queued", creationSource: "web" });
    const ahead = target.start(THREAD, { status: "queued", creationSource: "web" });
    target.set(THREAD, ahead.id, "running");
    target.set(THREAD, ahead.id, "failed");
    return { first, ahead };
  };
  /** Enough later messages that the first run is no longer in the 50 runs a read lists. */
  const pushOffPage = (target: ReturnType<typeof stage>["target"]) => {
    for (let index = 0; index < 49; index++)
      target.start(THREAD, { status: "queued", creationSource: "web" });
  };

  it.live(
    "is the first run's, not that of a message moved ahead of it, while the first run is off the page and still queued",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      const { first } = reordered(target);
      pushOffPage(target);
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        const [waiting] = yield* settled(
          world,
          rows,
          (current) => current[0]?.state !== "following" || current[0]?.followedRunId === first.id,
        );
        // The run moved ahead failed; it is not the handoff's, so nothing is said.
        expect(waiting).toMatchObject({ state: "following", followedRunId: first.id });
        expect(kept).toEqual([]);
        target.set(THREAD, first.id, "running");
        target.set(THREAD, first.id, "completed");
        const row = yield* ended(world);
        expect(row).toMatchObject({ state: "idle", lastStatus: "completed" });
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ threadId: LAUNCHER });
        expect(kept[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "is not a run that ended before the first run was stopped: the run started after the stop is",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      target.create(THREAD);
      const first = target.start(THREAD, { status: "queued", creationSource: "web" });
      const ahead = target.start(THREAD, { status: "queued", creationSource: "web" });
      target.set(THREAD, ahead.id, "running");
      target.set(THREAD, ahead.id, "completed");
      target.set(THREAD, first.id, "running");
      target.set(THREAD, first.id, "interrupted");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        // Read more than once: the success that came before the stop is never the result.
        yield* settled(
          world,
          Effect.sync(() => target.asked(THREAD, "studio_thread_read")),
          (reads) => reads >= 3,
        );
        expect(kept).toEqual([]);
        expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
        const next = target.start(THREAD, { creationSource: "web" });
        target.set(THREAD, next.id, "failed");
        const row = yield* ended(world);
        expect(row).toMatchObject({ state: "idle", lastStatus: "failed" });
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatchObject({ threadId: LAUNCHER });
        expect(kept[0]?.text).toContain("finished: failed");
        yield* quiet(world);
        expect(kept).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  for (const layout of ["on the page", "off the page"] as const) {
    it.live(
      `is the first run's when both ran while the source was away and the first run is ${layout}`,
      () => {
        const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
        const { first } = reordered(target);
        target.set(THREAD, first.id, "running");
        target.set(THREAD, first.id, "completed");
        if (layout === "off the page") pushOffPage(target);
        const { world, layer } = boot();
        return Effect.gen(function* () {
          yield* follow(handedOff());
          const row = yield* ended(world);
          // The same message wherever the page boundary falls.
          expect(row).toMatchObject({ state: "idle", lastStatus: "completed" });
          expect(kept).toHaveLength(1);
          expect(kept[0]?.text).toContain("finished: completed");
          yield* quiet(world);
          expect(kept).toHaveLength(1);
        }).pipe(Effect.provide(layer));
      },
      LIVE,
    );
  }
});

describe("one handoff, one message", () => {
  const failedThenContinued = (target: ReturnType<typeof stage>["target"]) => {
    target.create(THREAD);
    const job = target.start(THREAD);
    target.set(THREAD, job.id, "failed");
    return {
      job,
      /** The target's fallback sweep continues the failed run on another model. */
      continueIt: () => {
        const fallback = target.start(THREAD, {
          creationSource: "server",
          messageId: `limit-fallback:${THREAD}:${job.id}`,
        });
        target.set(THREAD, fallback.id, "completed");
        return fallback;
      },
    };
  };

  it.live(
    "shows how the target's late continuation of a reported failure ended, without a second message",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      const { continueIt } = failedThenContinued(target);
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain("finished: failed");
        continueIt();
        // No restart: the same life of the source sees it.
        const [row] = yield* settled(
          world,
          rows,
          (current) => current[0]?.state === "idle" && current[0]?.lastStatus === "completed",
        );
        expect(row).toMatchObject({ state: "idle", lastStatus: "completed" });
        yield* quiet(world);
        expect(kept).toHaveLength(1);
        expect(world.wakes.every((wake) => wake.commandId === kept[0]?.commandId)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
    SHORT,
  );

  it.live(
    "shows it after a restart of the source too, and the launcher still keeps one message",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      const { continueIt } = failedThenContinued(target);
      const first = boot();
      const second = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff()).pipe(
          Effect.andThen(settled(first.world, rows, (current) => current[0]?.state === "idle")),
          Effect.provide(first.layer),
        );
        expect(kept).toHaveLength(1);
        continueIt();
        yield* Effect.gen(function* () {
          const [row] = yield* settled(
            second.world,
            rows,
            (current) =>
              kept.length >= 2 ||
              (current[0]?.state === "idle" && current[0]?.lastStatus === "completed"),
          );
          expect(kept).toHaveLength(1);
          expect(row).toMatchObject({ state: "idle", lastStatus: "completed" });
          yield* quiet(second.world);
        }).pipe(Effect.provide(second.layer));
        expect(kept).toHaveLength(1);
        expect(kept[0]?.text).toContain("finished: failed");
        const sends = [...first.world.wakes, ...second.world.wakes];
        expect(new Set(sends.map((send) => send.commandId)).size).toBe(1);
      });
    },
    LIVE,
  );

  it.live(
    "still tells the launcher about a run it starts there after the result, as for any worker",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        const [done] = yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toHaveLength(1);
        if (done === undefined) return;
        // The launcher sends the worker another message; its send notes the new run.
        const more = target.start(THREAD);
        target.set(THREAD, more.id, "completed");
        yield* seed({ ...done, state: "following", followedRunId: more.id });
        const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
        yield* follower.follow(ROW);
        yield* settled(world, keptCount(kept), (count) => count >= 2);
        expect(new Set(kept.map((message) => message.commandId)).size).toBe(2);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );
});
