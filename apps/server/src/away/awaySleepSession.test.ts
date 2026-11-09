/**
 * A lid close as an Away session (1267 AC-09, #4, #5, #13): the session the
 * sleep records, the routines it pauses here, what a wake does with each, and
 * the sleep trigger's store as a pointer into that session.
 */
import {
  type AwaySession,
  type AwaySleepSession,
  EnvironmentId,
  ProjectId,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  fillSleepThreads,
  handoffOffFor,
  makeSleepSessionPort,
  routinesToPauseOnSleep,
  type SleepSessionDeps,
  sleepMayStart,
  sleepStoreOver,
} from "./awaySleepSession.ts";

const MS = EnvironmentId.make("ministorm");
const P1 = ProjectId.make("p1");
const P2 = ProjectId.make("p2");

const SLEEP: AwaySleepSession = {
  state: "pending-intent",
  targetEnvironmentId: MS,
  graceMinutes: 2,
  projectIds: [P1],
  threadIds: ["t1", "t2"],
  sentAt: "2026-11-09T22:00:00.000Z",
  dueAt: "2026-11-09T22:02:00.000Z",
};

const task = (id: string, patch: Partial<Record<string, unknown>>): ScheduledTask =>
  ({
    id,
    title: id,
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: P1,
    threadId: null,
    ownThread: false,
    ...patch,
  }) as unknown as ScheduledTask;

const TASKS = [
  task("r-worker", { threadId: "t1" }),
  task("r-own", { ownThread: true }),
  task("r-own-other", { ownThread: true, projectId: P2 }),
  task("r-hook", { ownThread: true, schedule: { type: "webhook" } }),
  task("r-off", { threadId: "t1", enabled: false }),
  task("r-free", {}),
];

function harness(
  options: {
    pauseFails?: ReadonlySet<string>;
    coordinates?: boolean;
    queued?: ReadonlySet<string>;
  } = {},
) {
  let saved: AwaySession | null = null;
  const log: string[] = [];
  const writes = { count: 0, fail: false };
  let ids = 0;
  const deps: SleepSessionDeps = {
    load: Effect.sync(() => saved),
    update: (change) =>
      Effect.sync(() => {
        writes.count += 1;
        if (writes.fail) return false;
        saved = change(saved) ?? saved;
        return true;
      }),
    now: Effect.succeed("2026-11-09T22:30:00.000Z"),
    newId: Effect.sync(() => `s-${(ids += 1)}`),
    targetLabel: () => Effect.succeed("Ministorm"),
    facts: () =>
      Effect.succeed({
        projectTitles: new Map([["p1", "EasyChamp"]]),
        threadTitles: new Map([
          ["t1", "Fix login"],
          ["t2", "Write tests"],
        ]),
        handoffOff: [{ id: "t9", title: "Local notes", projectId: P1 }],
        tasks: TASKS,
      }),
    pauseHere: (id, note) =>
      Effect.sync(() => {
        log.push(`${note === null ? "on" : "off"}:${id}`);
        return !(options.pauseFails?.has(id) ?? false);
      }),
    heartbeat: Effect.sync(() => void log.push("heartbeat")),
    continuedOn: () => Effect.succeed(new Map([["t1", "t1-there"]])),
    coordinates: () => Effect.succeed(options.coordinates ?? false),
    routineThreads: Effect.succeed(
      new Map(TASKS.map((entry) => [entry.id as string, entry.threadId])),
    ),
    queued: Effect.succeed(options.queued ?? new Set<string>()),
  };
  return { deps, port: makeSleepSessionPort(deps), log, saved: () => saved, writes };
}

const item = (session: AwaySession, kind: string, id: string) =>
  session.items.find((entry) => entry.kind === kind && entry.id === id);

describe("routinesToPauseOnSleep (#5)", () => {
  it("pauses worker routines of threads in the intent and coordinator routines of its projects", () => {
    expect(routinesToPauseOnSleep(TASKS, SLEEP).map((entry) => entry.id)).toEqual([
      "r-worker",
      "r-own",
    ]);
  });
});

describe("a lid close records a normal Away session (#4)", () => {
  it.effect("lists coordinators, threads, handoff-off threads and pauses routines here", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.port.begin(SLEEP, "live");
      const session = h.saved()!;
      expect(session).toMatchObject({
        trigger: "sleep",
        stage: "pending-intent",
        finishedAt: null,
        targetLabel: "Ministorm",
        sleep: SLEEP,
      });
      expect(item(session, "coordinator", "p1")).toMatchObject({
        outcome: "pending",
        title: "EasyChamp",
      });
      expect(item(session, "thread", "t1")).toMatchObject({
        outcome: "pending",
        title: "Fix login",
      });
      expect(item(session, "thread", "t9")).toMatchObject({
        outcome: "stayed",
        detail: "Handoff mode is off, so it had no copy on Ministorm.",
      });
      expect(item(session, "routine", "r-worker")).toMatchObject({
        outcome: "paused",
        via: "paused",
        wasEnabled: true,
        detail: "Paused while away on Ministorm.",
      });
      expect(h.log).toEqual(["off:r-worker", "off:r-own"]);
      expect(sleepMayStart(session)).toBe(false);
    }),
  );

  it.effect("a routine that could not be turned off is listed as running here", () =>
    Effect.gen(function* () {
      const h = harness({ pauseFails: new Set(["r-own"]) });
      yield* h.port.begin(SLEEP, "live");
      expect(item(h.saved()!, "routine", "r-own")?.outcome).toBe("stayed");
      expect(item(h.saved()!, "routine", "r-worker")?.outcome).toBe("paused");
    }),
  );

  it.effect("woke before the target acted: routines on again, everything stayed, closed", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.port.begin(SLEEP, "live");
      h.log.length = 0;
      yield* h.port.nothingMoved;
      const session = h.saved()!;
      expect(h.log).toEqual(["on:r-worker", "on:r-own"]);
      expect(session.stage).toBe("done");
      expect(session.broughtBackAt).not.toBeNull();
      expect(item(session, "thread", "t1")?.outcome).toBe("stayed");
      expect(item(session, "routine", "r-own")?.back?.outcome).toBe("returned");
      expect(sleepMayStart(session)).toBe(true);
    }),
  );

  it.effect("a routine that would not turn back on keeps the session for Bring back", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.port.begin(SLEEP, "live");
      const failing = harness({ pauseFails: new Set(["r-own"]) });
      yield* failing.deps.update(() => h.saved());
      yield* failing.port.nothingMoved;
      expect(failing.saved()!.broughtBackAt).toBeNull();
      expect(item(failing.saved()!, "routine", "r-own")?.back?.outcome).toBe("failed");
    }),
  );

  it.effect(
    "woke after it acted: fences now, fills threads and coordinators, waits for Bring back",
    () =>
      Effect.gen(function* () {
        const h = harness({ coordinates: false });
        yield* h.port.begin(SLEEP, "live");
        h.log.length = 0;
        yield* h.port.moved();
        const session = h.saved()!;
        expect(h.log).toEqual(["heartbeat"]);
        expect(session.stage).toBe("done");
        expect(session.finishedAt).not.toBeNull();
        expect(session.broughtBackAt).toBeNull();
        expect(item(session, "coordinator", "p1")?.outcome).toBe("moved");
        expect(item(session, "thread", "t1")).toMatchObject({
          outcome: "moved",
          targetId: "t1-there",
        });
        // Not placed yet; Bring back reads the handoff record again.
        expect(item(session, "thread", "t2")?.outcome).toBe("pending");
        expect(item(session, "routine", "r-own")?.outcome).toBe("paused");
        expect(
          fillSleepThreads(session, new Map(), true).items.find((i) => i.id === "t2")?.outcome,
        ).toBe("stayed");
      }),
  );

  it.effect("a coordinator this copy still runs after the wake stayed here", () =>
    Effect.gen(function* () {
      const h = harness({ coordinates: true });
      yield* h.port.begin(SLEEP, "live");
      yield* h.port.moved();
      expect(item(h.saved()!, "coordinator", "p1")?.outcome).toBe("stayed");
    }),
  );

  it.effect(
    "a project the target did not take turns its coordinator routines on here now (N4)",
    () =>
      Effect.gen(function* () {
        const h = harness({ coordinates: true });
        yield* h.port.begin(SLEEP, "live");
        h.log.length = 0;
        expect(yield* h.port.moved()).toBe(true);
        const session = h.saved()!;
        // The coordinator's own routine runs here again; the worker's waits for its thread.
        expect(h.log).toEqual(["heartbeat", "on:r-own"]);
        expect(item(session, "routine", "r-own")).toMatchObject({
          outcome: "stayed",
          detail: "Ministorm did not take this project, so its routines stayed here.",
        });
        expect(item(session, "routine", "r-own")?.via).toBeUndefined();
        expect(item(session, "routine", "r-worker")?.outcome).toBe("paused");
      }),
  );

  it.effect("the stage and the wake prompt are one write; a failed write says so (N2)", () =>
    Effect.gen(function* () {
      const h = harness({ coordinates: false });
      yield* h.port.begin(SLEEP, "live");
      h.writes.fail = true;
      const before = h.writes.count;
      expect(yield* h.port.moved({ ...SLEEP, state: "wake-prompt" })).toBe(false);
      expect(h.saved()!.stage).toBe("pending-intent");
      h.writes.fail = false;
      const counted = h.writes.count;
      expect(yield* h.port.moved({ ...SLEEP, state: "wake-prompt" })).toBe(true);
      expect(h.writes.count - counted).toBe(1);
      expect(counted - before).toBe(1);
      expect(h.saved()).toMatchObject({ stage: "done", sleep: { state: "wake-prompt" } });
    }),
  );

  it.effect("nothing moved closes the session and drops its sleep record in one write (N2)", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.port.begin(SLEEP, "live");
      const counted = h.writes.count;
      expect(yield* h.port.nothingMoved).toBe(true);
      expect(h.writes.count - counted).toBe(1);
      expect(h.saved()!.stage).toBe("done");
      expect(h.saved()!.sleep).toBeUndefined();
    }),
  );

  it.effect("a thread that continued there lists its queued messages as held here (#13)", () =>
    Effect.gen(function* () {
      const h = harness({ queued: new Set(["t1"]) });
      yield* h.port.begin(SLEEP, "live");
      yield* h.port.moved();
      expect(item(h.saved()!, "thread", "t1")?.detail).toBe(
        "Continued on Ministorm while this machine slept. Its queued messages are held here; open it on Ministorm and send them there.",
      );
    }),
  );
});

describe("the sleep trigger's store points into the session", () => {
  it.effect(
    "write starts a bare session, begin fills the same one, clearing drops the pointer",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const store = sleepStoreOver(h.deps);
        expect(yield* store.read).toBeNull();
        yield* store.write(SLEEP);
        const bare = h.saved()!;
        expect(bare).toMatchObject({ trigger: "sleep", stage: "pending-intent" });
        // Even before begin, a wake finds what the intent named.
        expect(bare.items.map((entry) => entry.id)).toEqual(["p1", "t1", "t2"]);
        yield* h.port.begin(SLEEP, "live");
        expect(h.saved()!.sessionId).toBe(bare.sessionId);
        yield* store.write({ ...SLEEP, state: "wake-prompt" });
        expect((yield* store.read)?.state).toBe("wake-prompt");
        expect(h.saved()!.items.length).toBeGreaterThan(0);
        yield* store.write(null);
        expect(yield* store.read).toBeNull();
        // The session itself stays, for the summary and Bring back.
        expect(h.saved()!.sessionId).toBe(bare.sessionId);
      }),
  );

  it("a new lid close waits while work is still away", () => {
    const away: AwaySession = {
      sessionId: "s",
      targetEnvironmentId: MS,
      targetLabel: "Ministorm",
      trigger: "manual",
      coordinatorScope: "live",
      startedAt: "2026-11-09T22:00:00.000Z",
      finishedAt: "2026-11-09T22:01:00.000Z",
      stage: "done",
      bringBackStartedAt: null,
      broughtBackAt: null,
      items: [{ kind: "thread", id: "t1", title: "T", outcome: "moved", detail: "There." }],
    };
    expect(sleepMayStart(away)).toBe(false);
    expect(sleepMayStart({ ...away, broughtBackAt: "2026-11-09T23:00:00.000Z" })).toBe(true);
    expect(sleepMayStart(null)).toBe(true);
  });
});

describe("handoffOffFor (#13)", () => {
  it("reads the thread's mode, else the project's, else the default", () => {
    const off = handoffOffFor({
      config: { defaultMode: "off" } as never,
      projectModes: { [P2]: "on" } as never,
      threads: { t1: { mode: "on" } } as never,
    });
    expect(off({ id: "t1" as never, projectId: P1 })).toBe(false);
    expect(off({ id: "t2" as never, projectId: P2 })).toBe(false);
    expect(off({ id: "t3" as never, projectId: P1 })).toBe(true);
  });
});
