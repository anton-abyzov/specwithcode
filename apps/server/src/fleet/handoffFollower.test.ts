// @effect-diagnostics nodeBuiltinImport:off - a folder that outlives one server life.
/**
 * A thread handed off to another machine, as the follower on the machine it
 * left sees it. The other machine answers as a released peer does
 * (releasedPeer.testkit.ts), a restart is a second server over the same
 * folder, and the launcher's messages are counted as its thread keeps them.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { continuationThreadId } from "../handoff/HandoffReceiver.ts";
import { releasedPeer } from "./releasedPeer.testkit.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import {
  allow,
  type KeptMessage,
  machine,
  makeSignal,
  quiet,
  ROLES,
  rows,
  settled,
  setup,
} from "./remoteWorkers.testkit.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const LAUNCHER = "coordinator";
const THREAD = "handoff:1";
const ROW = "handoff-follow:1";
const wakeOf = (runId: string) => `remote-worker-wake:${ROW}:${runId}`;
const LIVE = { timeout: 20_000 };

/** The row the source writes before it sends the takeover. */
const handedOff = (
  overrides: Partial<RemoteWorkerStore.RemoteWorkerRecord> = {},
): RemoteWorkerStore.RemoteWorkerRecord => ({
  id: ROW,
  callerThreadId: LAUNCHER,
  projectId: "local-project",
  machineId: ROLES.target.id,
  environmentId: ROLES.target.environmentId,
  remoteProjectId: null,
  remoteThreadId: THREAD,
  title: "Fix the flaky test",
  launchStartedAt: "2026-10-12T00:00:00.000Z",
  followedRunId: null,
  reportBack: true,
  state: "following",
  lastStatus: null,
  deliveredRunIds: [],
  lostContactNotified: false,
  lastError: null,
  updatedAt: "2026-10-12T00:00:00.000Z",
  handoff: { sourceThreadId: "thread-1", epoch: 2, awaiting: "continuation" },
  ...overrides,
});

/**
 * The source's folder, the messages its threads keep, and the machines it can
 * ask. `boot` is one life of the source's server over them: what the first
 * life wrote is all the next one has.
 */
const stage = (timings: Partial<RemoteWorkerFollower.RemoteWorkerFollowerTimingsShape> = {}) => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-follower-"));
  temporary.push(baseDir);
  const target = releasedPeer(ROLES.target.environmentId);
  const onward = releasedPeer(machine("onward").environmentId);
  const kept: Array<KeptMessage> = [];
  const changed = makeSignal();
  const boot = (options: { readonly knowsOnward?: boolean } = {}) =>
    setup(target.tools, timings, {
      roles: {
        ...ROLES,
        more: options.knowsOnward === false ? [] : [{ target: machine("onward"), tools: onward.tools }],
      },
      baseDir,
      kept,
      changed,
    });
  return { target, onward, kept, changed, boot };
};

const seed = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  Effect.flatMap(RemoteWorkerStore.RemoteWorkerStore, (store) => store.modify(row.id, () => row));

const follow = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
  Effect.gen(function* () {
    yield* allow("auto", ROLES.target.id);
    yield* seed(row);
    const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
    yield* follower.follow(row.id);
  });

const keptCount = (kept: ReadonlyArray<KeptMessage>) => Effect.sync(() => kept.length);

describe("the follower of a handed-off thread", () => {
  it.live(
    "asks again for a thread the target does not have yet, then reports its run once",
    () => {
      const { target, kept, boot } = stage();
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(
          world,
          Effect.sync(() => target.asked(THREAD)),
          (asked) => asked >= 3,
        );
        expect(yield* rows).toMatchObject([{ state: "following", lastError: null }]);
        expect(kept).toEqual([]);
        target.create(THREAD);
        const run = target.start(THREAD);
        yield* settled(world, rows, (current) => current[0]?.followedRunId === run.id);
        // Its run is going: nothing has ended, so nothing is said.
        expect(kept).toEqual([]);
        target.set(THREAD, run.id, "completed");
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(run.id) }]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reads a thread that arrived idle as not started, and a restart keeps waiting for its run",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const first = boot();
      const second = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff()).pipe(
          Effect.andThen(
            settled(first.world, rows, (current) => current[0]?.handoff?.awaiting === "run"),
          ),
          Effect.provide(first.layer),
        );
        expect(kept).toEqual([]);
        // The source restarted: the row alone restarts the follow.
        yield* Effect.gen(function* () {
          const asked = target.asked(THREAD);
          yield* settled(
            second.world,
            Effect.sync(() => target.asked(THREAD)),
            (now) => now >= asked + 2,
          );
          expect(yield* rows).toMatchObject([{ state: "following", deliveredRunIds: [] }]);
          expect(kept).toEqual([]);
          const run = target.start(THREAD);
          target.set(THREAD, run.id, "completed");
          yield* settled(second.world, keptCount(kept), (count) => count === 1);
          expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(run.id) }]);
        }).pipe(Effect.provide(second.layer));
      });
    },
    LIVE,
  );

  it.live(
    "reports the job that completed while the source was away, not the message queued after it",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "completed");
      const followUp = target.start(THREAD, { status: "queued", creationSource: "web" });
      const { world, layer } = boot();
      return Effect.gen(function* () {
        // The source reconnects and sees both at once.
        yield* follow(handedOff());
        yield* settled(
          world,
          Effect.sync(() => target.asked(THREAD)),
          (asked) => asked >= 2,
        );
        // Someone cancels the queued message after the follower has looked.
        target.set(THREAD, followUp.id, "cancelled");
        yield* settled(world, keptCount(kept), (count) => count >= 1);
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(job.id) }]);
        expect(kept[0]?.text).toContain("finished: completed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "finds the job among more runs than the target lists at once",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "completed");
      // Sixty more messages there, each someone's own, while the source was away.
      for (let index = 0; index < 60; index++) {
        const later = target.start(THREAD, { creationSource: "web" });
        target.set(THREAD, later.id, "completed");
      }
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(job.id) }]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports the failure, not a message someone sent there after it",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "failed");
      const own = target.start(THREAD, { creationSource: "web" });
      target.set(THREAD, own.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(job.id) }]);
        expect(kept[0]?.text).toContain("finished: failed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "reports the failed run when the target's own continuation of it was only stopped",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "failed");
      const fallback = target.start(THREAD, {
        creationSource: "server",
        messageId: `limit-fallback:${THREAD}:${job.id}`,
      });
      target.set(THREAD, fallback.id, "interrupted");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(job.id) }]);
        expect(kept[0]?.text).toContain("finished: failed");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "keeps following when the target no longer has the run it was waiting on",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const run = target.start(THREAD);
      target.set(THREAD, run.id, "completed");
      const { world, layer } = boot();
      return Effect.gen(function* () {
        // The released wait answers run_not_found for a run the thread does not have.
        yield* follow(
          handedOff({
            followedRunId: "run-the-target-never-had",
            handoff: { sourceThreadId: "thread-1", epoch: 2 },
          }),
        );
        yield* settled(world, keptCount(kept), (count) => count >= 1);
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(run.id) }]);
        expect((yield* rows)[0]?.lastError).toBeNull();
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "takes the launcher's own wait seeing a stop as no result, and reports the run that finishes",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      const stopped = target.start(THREAD);
      const { world, layer } = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff());
        yield* settled(world, rows, (current) => current[0]?.followedRunId === stopped.id);
        // The follower's next answer is held: the launcher's wait sees the stop first.
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let parked = 0;
        target.hold = () => {
          parked += 1;
          world.changed.fire();
          return held;
        };
        yield* settled(
          world,
          Effect.sync(() => parked),
          (count) => count >= 1,
        );
        target.set(THREAD, stopped.id, "interrupted");
        const workers = yield* RemoteWorkers.RemoteWorkers;
        yield* workers.noteFinished({
          callerThreadId: ThreadId.make(LAUNCHER),
          machineId: ROLES.target.id,
          remoteThreadId: THREAD,
          runId: stopped.id,
          status: "interrupted",
        });
        target.hold = undefined;
        release();
        expect(kept).toEqual([]);
        // Someone continues the work there, and that run finishes.
        const run = target.start(THREAD, { creationSource: "web" });
        target.set(THREAD, run.id, "completed");
        yield* settled(world, keptCount(kept), (count) => count >= 1);
        yield* settled(world, rows, (current) => current[0]?.state === "idle");
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(run.id) }]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "tells the launcher nothing more after a restart when someone else's run follows its result",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "failed");
      const first = boot();
      const second = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff()).pipe(
          Effect.andThen(settled(first.world, rows, (current) => current[0]?.state === "idle")),
          Effect.provide(first.layer),
        );
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(job.id) }]);
        // Later someone sends that thread a message of their own, and it completes.
        const own = target.start(THREAD, { creationSource: "web" });
        target.set(THREAD, own.id, "completed");
        yield* Effect.gen(function* () {
          const asked = target.asked(THREAD);
          // The restarted server looks at the failed row again, and that is all it does.
          yield* settled(
            second.world,
            Effect.sync(() => target.asked(THREAD)),
            (now) => now > asked,
          );
          yield* quiet(second.world);
          expect(kept).toHaveLength(1);
          expect(yield* rows).toMatchObject([{ state: "idle", deliveredRunIds: [job.id] }]);
          // Every send was the one wake, to the launcher.
          expect(new Set(second.world.wakes.map((wake) => wake.commandId))).toEqual(
            new Set([wakeOf(job.id)]),
          );
        }).pipe(Effect.provide(second.layer));
      });
    },
    LIVE,
  );

  it.live(
    "follows the target's own continuation of a failure it already reported",
    () => {
      const { target, kept, boot } = stage({ fallbackGraceMs: 1 });
      target.create(THREAD);
      const job = target.start(THREAD);
      target.set(THREAD, job.id, "failed");
      const first = boot();
      const second = boot();
      return Effect.gen(function* () {
        yield* follow(handedOff()).pipe(
          Effect.andThen(settled(first.world, rows, (current) => current[0]?.state === "idle")),
          Effect.provide(first.layer),
        );
        expect(kept).toHaveLength(1);
        // The target's fallback sweep continues the failed run on another model.
        const fallback = target.start(THREAD, {
          creationSource: "server",
          messageId: `limit-fallback:${THREAD}:${job.id}`,
        });
        target.set(THREAD, fallback.id, "completed");
        yield* settled(second.world, keptCount(kept), (count) => count === 2).pipe(
          Effect.provide(second.layer),
        );
        expect(kept.map((message) => message.commandId)).toEqual([
          wakeOf(job.id),
          wakeOf(fallback.id),
        ]);
      });
    },
    LIVE,
  );

  it.live(
    "follows the work to the machine the target handed it on to, and reports once",
    () => {
      const { target, onward, kept, boot } = stage();
      target.create(THREAD);
      const interrupted = target.start(THREAD);
      const first = boot();
      const second = boot();
      const third = boot();
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* allow("auto", "onward");
          yield* follow(handedOff());
          yield* settled(
            first.world,
            rows,
            (current) => current[0]?.followedRunId === interrupted.id,
          );
        }).pipe(Effect.provide(first.layer));
        // The source is off. The target hands the thread on, and it finishes there.
        target.handOn(THREAD, { environmentId: onward.environmentId, label: "Onward", epoch: 3 });
        const next = continuationThreadId(ROLES.target.environmentId, THREAD, 3);
        onward.create(next);
        const run = onward.start(next);
        onward.set(next, run.id, "completed");
        // The source comes back.
        yield* Effect.gen(function* () {
          yield* settled(second.world, keptCount(kept), (count) => count >= 1);
          const [row] = yield* settled(
            second.world,
            rows,
            (current) => current[0]?.state === "idle",
          );
          expect(row).toMatchObject({
            id: ROW,
            callerThreadId: LAUNCHER,
            machineId: "onward",
            environmentId: onward.environmentId,
            remoteThreadId: next,
            lastStatus: "completed",
          });
        }).pipe(Effect.provide(second.layer));
        expect(kept).toMatchObject([{ threadId: LAUNCHER, commandId: wakeOf(run.id) }]);
        expect(kept[0]?.text).toContain("on Onward finished: completed");
        // A later restart re-sends that wake at most; the launcher keeps one message.
        yield* Effect.gen(function* () {
          yield* settled(third.world, Effect.sync(() => third.world.wakes.length), (n) => n >= 1);
          yield* quiet(third.world);
        }).pipe(Effect.provide(third.layer));
        expect(kept).toHaveLength(1);
        expect(third.world.wakes.every((wake) => wake.threadId === LAUNCHER)).toBe(true);
      });
    },
    LIVE,
  );

  it.live(
    "stops with a reason when the work was handed on to a machine it cannot ask",
    () => {
      const { target, kept, boot } = stage();
      target.create(THREAD);
      target.start(THREAD);
      target.handOn(THREAD, { environmentId: "env-elsewhere", label: "Elsewhere", epoch: 3 });
      const { world, layer } = boot({ knowsOnward: false });
      return Effect.gen(function* () {
        yield* follow(handedOff());
        const [row] = yield* settled(world, rows, (current) => current[0]?.state === "stopped");
        expect(row?.lastError).toContain("handed on");
        expect(kept).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );

  it.live(
    "shows a handed-off thread as waiting, not working, until a run is seen there",
    () => {
      const { boot } = stage();
      const { layer } = boot();
      const shown = Effect.gen(function* () {
        const workers = yield* RemoteWorkers.RemoteWorkers;
        const [worker] = yield* workers.workersForProject(ProjectId.make("local-project"));
        return worker;
      });
      return Effect.gen(function* () {
        // Seeded without a follow: only what the row says is shown.
        yield* seed(handedOff());
        expect(yield* shown).toMatchObject({ state: "following", awaiting: "handoff" });
        yield* seed(
          handedOff({
            lastStatus: "idle",
            handoff: { sourceThreadId: "thread-1", epoch: 2, awaiting: "run" },
          }),
        );
        expect(yield* shown).toMatchObject({ state: "following", awaiting: "run" });
        yield* seed(
          handedOff({
            followedRunId: "run-1",
            lastStatus: "running",
            handoff: { sourceThreadId: "thread-1", epoch: 2 },
          }),
        );
        expect(yield* shown).not.toHaveProperty("awaiting");
      }).pipe(Effect.provide(layer));
    },
    LIVE,
  );
});
