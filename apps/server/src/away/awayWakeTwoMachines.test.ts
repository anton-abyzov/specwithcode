/**
 * A lid-close Away across two machines (1267 AC-09): the M4 coordinates
 * EasyChamp and sleeps; Ministorm holds the linked copy and the away intent.
 * The M4 runs the real sleep trigger, wake check, wake hold, coordinator gate
 * and lease give-way; Ministorm runs the real intents and routes. Every call
 * between them crosses a stub network that can lose a request or its answer.
 * After every step at most one copy may start a coordinator turn, and once
 * the wake check settled exactly one does.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayHandoverResult,
  type AwayIntentRecord,
  EnvironmentId,
  type Project,
  type ProjectId,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { makeCoordinatorLease, verifyTakenOver } from "../project/CoordinatorLease.ts";
import { makeMemory } from "../project/CoordinatorLeaseStore.ts";
import { makeCheck } from "../project/CoordinatorWakeGate.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectLink from "../project/ProjectLink.ts";
import { checkout, machine, removeCheckouts } from "../project/ProjectLink.testkit.ts";
import { linkedCopyOf, makeAwayIntents, memoryIntentStore } from "./AwayIntents.ts";
import { cancelIntent, intentStatus, recordIntent } from "./awayIntentRoute.ts";
import { AwayPeerError, type AwayPeerPost } from "./awayPeerCall.ts";
import { makeAwaySleep, memorySleepStore } from "./awaySleepRoute.ts";
import {
  AWAY_THREAD_HOLD_REFUSAL,
  COORDINATOR_AWAY_HOLD_REFUSAL,
  memoryWakeHoldStore,
} from "./AwayWakeHold.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-09T22:00:00.000Z");
const M4 = EnvironmentId.make("m4");
const MS = EnvironmentId.make("ministorm");

afterEach(() => removeCheckouts());

const callerFrom = (environment: string): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects: { kind: "linked" },
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

/**
 * - `deliver`: reaches Ministorm and the answer comes back.
 * - `lose`: never reaches it; the M4 cannot tell (uncertain).
 * - `lose-after`: reaches it and it acts, but the answer is lost (uncertain).
 * - `unreachable`: no address answered; nothing left (definite).
 * - `refuse`: Ministorm answered with a refusal (definite).
 */
type Mode = "deliver" | "lose" | "lose-after" | "unreachable" | "refuse";

const isActive = (project: Project | undefined) =>
  project !== undefined &&
  (project.workspaceSettings?.coordinatorBinding === undefined ||
    project.workspaceSettings.coordinatorBinding.state === "active");

const fleet = Effect.gen(function* () {
  yield* TestClock.setTime(T0);
  const m4 = machine("m4");
  const ms = machine("ministorm");
  const members = {
    m4: {
      ...m4.member("easychamp-m4"),
      workspaceRoot: m4.add("easychamp-m4", checkout("git@github.com:anton/sw-easychamp.git"))
        .workspaceRoot,
    },
    ms: {
      ...ms.member("easychamp-ms"),
      workspaceRoot: ms.add("easychamp-ms", checkout("https://github.com/anton/sw-easychamp.git"))
        .workspaceRoot,
    },
  };
  const on =
    (layer: typeof m4.layer) =>
    <A, E>(use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, E>) =>
      Effect.flatMap(ProjectLink.ProjectLink, use).pipe(
        Effect.provide(Layer.merge(layer, ProjectAdmission.layer)),
      );
  const link4 = on(m4.layer);
  const linkS = on(ms.layer);
  const operationId = "11111111-1111-4111-8111-111111111111";
  const prepared = yield* link4((service) =>
    service.prepare({ operationId, projectId: members.m4.projectId, joining: members.ms }),
  );
  const accepted = yield* linkS((service) =>
    service.accept({
      operationId,
      projectId: members.ms.projectId,
      kept: prepared.kept,
      logicalProject: prepared.logicalProject,
      coordinatorBinding: prepared.coordinatorBinding,
      keptFingerprint: prepared.fingerprint,
    }),
  );
  yield* link4((service) =>
    service.commit({
      operationId,
      projectId: members.m4.projectId,
      joining: accepted.member,
      notes: [],
    }),
  );
  const m4ProjectId = members.m4.projectId as ProjectId;
  const coordinatorThread = `project-coordinator:${m4ProjectId}`;

  // --- Ministorm: the intents, with a takeover that can be held mid-act ---
  const intentStore = memoryIntentStore();
  const dueHooks: AwayIntentRecord[] = [];
  const actGate = { hold: null as Deferred.Deferred<void> | null, started: 0 };
  let ids = 0;
  const intents = yield* makeAwayIntents({
    store: intentStore,
    newId: Effect.sync(() => `intent-${++ids}`),
    // The M4 is asleep for the whole grace in these tests.
    heardAwake: () => Effect.succeed(false),
    act: (intent) =>
      Effect.gen(function* () {
        actGate.started += 1;
        if (actGate.hold !== null) yield* Deferred.await(actGate.hold);
        const results: AwayHandoverResult[] = [];
        for (const projectId of intent.projectIds) {
          const copy = linkedCopyOf([...ms.projects.values()], "m4", projectId)!;
          const taken = yield* linkS((service) =>
            service.awayTakeover({ projectId: copy.id, sourceEnvironmentId: "m4" }),
          );
          results.push({
            projectId,
            outcome: "handed-over",
            detail: "This machine coordinates the project now.",
            epoch: taken.coordinatorBinding.epoch,
          });
        }
        return results;
      }).pipe(Effect.orDie),
  });
  yield* intents.onIntentDue((intent) => Effect.sync(() => void dueHooks.push(intent)));
  const projectsOnMs = (): ReadonlyArray<Project> => [...ms.projects.values()];
  /** Source threads Ministorm continued, as its handoff record lists them. */
  const continuedOnMs = new Map<string, string>();
  /** Threads the M4's handoff record shows as continued there (fenced here). */
  const fencedOnM4 = new Set<string>();
  const resumedQueues: string[] = [];

  // --- the network between them ---
  const network = {
    down: false,
    modes: new Map<string, Mode[]>(),
    sent: [] as Array<{ path: string; mode: Mode }>,
  };
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  const route = (path: string, body: unknown) =>
    Effect.gen(function* () {
      const caller = callerFrom("m4");
      if (path === AWAY_INTENT_PATH)
        return yield* recordIntent(intents, caller, body, projectsOnMs());
      if (path === AWAY_INTENT_CANCEL_PATH) return yield* cancelIntent(intents, caller, body);
      if (path === AWAY_INTENT_STATUS_PATH)
        return yield* intentStatus(
          intents,
          caller,
          body,
          projectsOnMs(),
          "ministorm",
          (threadId) => continuedOnMs.get(threadId) ?? null,
        );
      return { status: 404, body: { error: "not found" } };
    });
  const post: AwayPeerPost = (_target, path, body) =>
    Effect.gen(function* () {
      const queued = network.modes.get(path);
      const mode: Mode = network.down ? "unreachable" : (queued?.shift() ?? "deliver");
      network.sent.push({ path, mode });
      if (mode === "unreachable")
        return yield* new AwayPeerError({
          message: "Ministorm did not answer.",
          refused: false,
          uncertain: false,
        });
      if (mode === "lose")
        return yield* new AwayPeerError({
          message: "Ministorm did not answer.",
          refused: false,
          uncertain: true,
        });
      if (mode === "refuse")
        return yield* new AwayPeerError({
          message: "Ministorm: no",
          refused: true,
          uncertain: false,
          status: 403,
        });
      const answer = yield* route(path, wire(body));
      if (mode === "lose-after")
        return yield* new AwayPeerError({
          message: "Ministorm did not answer.",
          refused: false,
          uncertain: true,
        });
      if (answer.status >= 300)
        return yield* new AwayPeerError({
          message: "Ministorm refused.",
          refused: true,
          uncertain: false,
          status: answer.status,
        });
      return { status: answer.status, json: wire(answer.body) };
    });

  // --- the M4: lease give-way, the gate and the sleep trigger ---
  const hold = memoryWakeHoldStore();
  const stopped = { coordinator: 0, workers: 0 };
  const lease = yield* Effect.gen(function* () {
    const service = yield* ProjectLink.ProjectLink;
    const admission = yield* ProjectAdmission.ProjectAdmission;
    return makeCoordinatorLease({
      store: makeMemory().service,
      admission,
      link: service,
      selfEnvironmentId: "m4",
      peers: {
        coordinatorLease: () => Effect.die("no standby in this test"),
        coordinatorReplica: () => Effect.die("no standby in this test"),
      },
      listProjects: Effect.sync(() => [...m4.projects.values()]),
      loadProject: (id) => Effect.sync(() => m4.projects.get(id)),
      runningThreads: () => Effect.succeed([]),
      workers: () => Effect.succeed([]),
      stopCoordinator: () => Effect.sync(() => void stopped.coordinator++),
      stopCoordinatorWorkers: () =>
        Effect.sync(() => {
          stopped.workers += 1;
          return 1;
        }),
      plannedPauseUntil: Effect.succeed(null),
      awayTargets: hold.read.pipe(
        Effect.map((held) => (held === null ? [] : [held.targetEnvironmentId])),
      ),
    });
  }).pipe(Effect.provide(Layer.merge(m4.layer, ProjectAdmission.layer)));
  const gate = makeCheck(makeMemory().service, undefined, undefined, hold);
  const session = memorySleepStore();
  const away = yield* makeAwaySleep({
    self: M4,
    store: session,
    config: Effect.succeed({
      target: MS,
      sleepTrigger: "on-battery",
      graceMinutes: 2,
      bringBack: "prompt",
      coordinatorScope: "live",
    }),
    ids: () => Effect.succeed({ projectIds: [m4ProjectId], threadIds: ["thread-reel"] }),
    post,
    hold,
    giveWay: (input) =>
      input.status.coordinatorBinding === undefined || input.status.successor === undefined
        ? Effect.succeed(false)
        : lease.acceptAwayTakeover({
            projectId: input.projectId,
            targetEnvironmentId: input.targetEnvironmentId,
            takenOver: {
              coordinatorBinding: input.status.coordinatorBinding,
              successor: input.status.successor,
            },
            receivedAt: input.receivedAt,
            sentAtMs: input.sentAtMs,
            answeredAtMs: input.answeredAtMs,
          }),
    stopCoordinator: lease.stopCoordinatorOf,
    confirmContinued: (threadIds) =>
      Effect.sync(() => new Set(threadIds.filter((threadId) => fencedOnM4.has(threadId)))),
    resumeQueues: (threadIds) => Effect.sync(() => void resumedQueues.push(...threadIds)),
  });

  /** Copies that would start a coordinator turn now: active and not held by the gate. */
  const running = Effect.gen(function* () {
    const m4Runs =
      isActive(m4.projects.get(m4ProjectId)) && (yield* gate(coordinatorThread as never)) === null;
    const msRuns = isActive(ms.projects.get(members.ms.projectId));
    return { m4: m4Runs, ms: msRuns };
  });
  const steps: Array<{ step: string; m4: boolean; ms: boolean }> = [];
  /** At most one copy runs at every step. */
  const check = (step: string) =>
    Effect.gen(function* () {
      const now = yield* running;
      steps.push({ step, ...now });
      expect(now.m4 && now.ms, `both copies run at ${step}`).toBe(false);
      return now;
    });
  /** Exactly one copy runs. */
  const settled = (step: string) =>
    Effect.gen(function* () {
      const now = yield* check(step);
      expect(Number(now.m4) + Number(now.ms), `one copy runs at ${step}`).toBe(1);
      return now;
    });
  const lidClose = Effect.gen(function* () {
    const decision = yield* away.sleep({ onBattery: true });
    expect(decision.answer).toEqual({ outcome: "left" });
    yield* check("sleep-notice");
    yield* decision.send;
    yield* check("intent-sent");
  });
  const binding = (name: "m4" | "ms") =>
    (name === "m4" ? m4.projects.get(m4ProjectId) : ms.projects.get(members.ms.projectId))
      ?.workspaceSettings?.coordinatorBinding;
  yield* settled("linked");
  return {
    intents,
    intentStore,
    dueHooks,
    actGate,
    network,
    hold,
    session,
    away,
    gate,
    stopped,
    steps,
    check,
    settled,
    lidClose,
    binding,
    members,
    coordinatorThread,
    m4ProjectId,
    lease,
    continuedOnMs,
    fencedOnM4,
    resumedQueues,
  };
});

describe("lid close, grace, wake: one coordinator at every step", () => {
  it.effect("the target acted while asleep: the wake check gives way to it (#1a)", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      // Held from the sleep notice on.
      expect(yield* f.gate(f.coordinatorThread as never)).toBe(COORDINATOR_AWAY_HOLD_REFUSAL);
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      expect(f.binding("ms")).toMatchObject({
        state: "active",
        predecessor: { environmentId: "m4" },
      });
      yield* f.check("target-acted");
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      const woke = yield* f.away.wake({ onBattery: true });
      expect(woke).toEqual({ outcome: "prompt" });
      // The cancel came too late and said so; the status named the takeover.
      expect(f.network.sent.map((call) => call.path)).toEqual([
        AWAY_INTENT_PATH,
        AWAY_INTENT_CANCEL_PATH,
        AWAY_INTENT_STATUS_PATH,
      ]);
      expect(f.binding("m4")).toMatchObject({
        state: "transferred",
        successor: { environmentId: "ministorm" },
        epoch: f.binding("ms")?.epoch,
      });
      expect(f.stopped.coordinator).toBeGreaterThan(0);
      expect(f.stopped.workers).toBe(1);
      expect(f.hold.current()).toBeNull();
      expect(f.session.current()?.state).toBe("wake-prompt");
      yield* f.settled("gave-way");
    }),
  );

  it.effect("back before the grace: the cancel wins, nothing moves, the hold lifts", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + MINUTE);
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      yield* TestClock.setTime(T0 + 10 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.binding("ms")?.state).toBe("transferred");
      expect(f.hold.current()).toBeNull();
      expect(f.session.current()).toBeNull();
      yield* f.settled("cancelled-in-time");
    }),
  );

  it.effect("the target is unreachable on wake: the hold stays and the retry gives way (#1c)", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      f.network.down = true;
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      // Fenced, not resumed at the old epoch: its binding is still active, but the gate holds it.
      expect(f.binding("m4")?.state ?? "active").toBe("active");
      expect(yield* f.gate(f.coordinatorThread as never)).toBe(COORDINATOR_AWAY_HOLD_REFUSAL);
      expect(f.stopped.coordinator).toBeGreaterThan(0);
      yield* f.settled("wake-unreachable");
      expect(yield* f.away.retry).toBe("unresolved");
      yield* f.settled("retry-unreachable");
      f.network.down = false;
      expect(yield* f.away.retry).toBe("moved");
      expect(f.binding("m4")?.state).toBe("transferred");
      expect(f.session.current()?.state).toBe("wake-prompt");
      yield* f.settled("retry-gave-way");
    }),
  );

  it.effect("unreachable before the grace ran out: the hold stays while the intent may fire", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + MINUTE);
      f.network.down = true;
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(f.session.current()?.state).toBe("pending-intent");
      yield* f.check("woke-early-unreachable");
      // The target never heard the cancel and acts when the grace ends.
      yield* TestClock.setTime(T0 + 3 * MINUTE);
      yield* f.intents.tick;
      yield* f.settled("target-acted-meanwhile");
      f.network.down = false;
      expect(yield* f.away.retry).toBe("moved");
      expect(f.binding("m4")?.state).toBe("transferred");
      yield* f.settled("retry-gave-way");
    }),
  );

  it.effect(
    "a cancel while the target acts is refused; the source waits, then gives way (#2)",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet;
        yield* f.lidClose;
        f.actGate.hold = yield* Deferred.make<void>();
        yield* TestClock.setTime(T0 + 2 * MINUTE);
        const ticking = yield* Effect.forkChild(f.intents.tick);
        while (f.actGate.started === 0) yield* Effect.yieldNow;
        expect(f.intentStore.current().intents[0]?.state).toBe("acting");
        // The source wakes while the target is mid-takeover.
        const woke = yield* f.away.wake({ onBattery: true });
        expect(woke).toEqual({ outcome: "none" });
        const cancelAnswer = yield* cancelIntent(f.intents, callerFrom("m4"), {
          sourceEnvironmentId: "m4",
        });
        expect(cancelAnswer.body).toEqual({ cancelled: 0, state: "acting", takenOver: [] });
        expect(f.intentStore.current().intents[0]?.state).toBe("acting");
        expect(f.session.current()?.state).toBe("pending-intent");
        expect(f.session.current()?.wokeAt).toBeDefined();
        yield* f.check("acting");
        yield* Deferred.succeed(f.actGate.hold, undefined);
        yield* Fiber.join(ticking);
        // The takeover finished and the runner's hook ran, despite the cancel.
        expect(f.intentStore.current().intents[0]?.state).toBe("done");
        expect(f.dueHooks.map((intent) => intent.threadIds)).toEqual([["thread-reel"]]);
        yield* f.settled("acted");
        const done = yield* cancelIntent(f.intents, callerFrom("m4"), {
          sourceEnvironmentId: "m4",
        });
        expect(done.body).toEqual({ cancelled: 0, state: "done", takenOver: [f.m4ProjectId] });
        expect(yield* f.away.retry).toBe("moved");
        expect(f.binding("m4")?.state).toBe("transferred");
        yield* f.settled("gave-way");
      }),
  );

  it.effect(
    "an unanswered intent send is uncertain; the wake still checks and gives way (#3)",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet;
        f.network.modes.set(AWAY_INTENT_PATH, ["lose-after"]);
        yield* f.lidClose;
        expect(f.session.current()?.state).toBe("send-uncertain");
        expect(f.hold.current()).not.toBeNull();
        yield* TestClock.setTime(T0 + 2 * MINUTE);
        yield* f.intents.tick;
        yield* f.check("target-acted");
        yield* TestClock.setTime(T0 + 30 * MINUTE);
        expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "prompt" });
        expect(f.network.sent.map((call) => call.path)).toContain(AWAY_INTENT_CANCEL_PATH);
        expect(f.binding("m4")?.state).toBe("transferred");
        yield* f.settled("gave-way");
      }),
  );

  it.effect("an unanswered send that never arrived: the wake finds no intent and runs here", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      f.network.modes.set(AWAY_INTENT_PATH, ["lose"]);
      yield* f.lidClose;
      expect(f.session.current()?.state).toBe("send-uncertain");
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(f.hold.current()).toBeNull();
      expect(f.session.current()).toBeNull();
      yield* f.settled("nothing-moved");
    }),
  );

  it.effect("a definite refusal is send-failed: the hold lifts at once and nothing moves", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      f.network.modes.set(AWAY_INTENT_PATH, ["refuse"]);
      yield* f.lidClose;
      expect(f.session.current()?.state).toBe("send-failed");
      expect(f.hold.current()).toBeNull();
      yield* f.settled("refused");
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(f.network.sent.map((call) => call.path)).toEqual([AWAY_INTENT_PATH]);
      yield* f.settled("woke");
    }),
  );

  it.effect("without a wake notice, the check runs on its own long after the grace", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      // Too early: the machine may be about to sleep, so nothing is cancelled.
      expect(yield* f.away.retry).toBeNull();
      yield* f.intents.tick;
      yield* TestClock.setTime(T0 + 10 * MINUTE);
      expect(yield* f.away.retry).toBe("moved");
      expect(f.binding("m4")?.state).toBe("transferred");
      yield* f.settled("gave-way");
    }),
  );
});

describe("verifyTakenOver from the recorded away target (#1b)", () => {
  const member = (environmentId: string, projectId: string) => ({
    environmentId: EnvironmentId.make(environmentId),
    projectId: projectId as ProjectId,
    workspaceRoot: `/w/${projectId}`,
    coordinatorThreadId: `project-coordinator:${projectId}`,
  });
  const self = member("m4", "p-m4");
  const standby = member("m3", "p-m3");
  const target = member("ministorm", "p-ms");
  const answer = {
    coordinatorBinding: {
      epoch: 2,
      state: "active" as const,
      operationId: "away:x:2",
      predecessor: self,
      takenOverAt: "2026-11-09T22:02:00.000Z",
    },
    successor: target,
  };
  const own = { epoch: 1, state: "active" as const };

  it("accepts the away target's takeover only when it is recorded and listed", () => {
    expect(verifyTakenOver({ own, self, sentTo: standby, answer } as never)).toBe(
      "the sender is not the standby",
    );
    expect(
      verifyTakenOver({
        own,
        self,
        sentTo: standby,
        answer,
        alsoFrom: ["ministorm"],
        members: [self, standby, target],
      } as never),
    ).toBeNull();
    expect(
      verifyTakenOver({
        own,
        self,
        sentTo: standby,
        answer,
        alsoFrom: ["ministorm"],
        members: [self, standby],
      } as never),
    ).toBe("the sender is not the standby");
  });
});

describe("worker threads in the intent wait for the target's word (#13)", () => {
  it.effect("held while the target is silent; not continued, they run here again", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      expect(yield* f.gate("thread-reel" as never)).toBe(AWAY_THREAD_HOLD_REFUSAL);
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      f.network.down = true;
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      // Its queue must not start here while the target may have continued it.
      expect(yield* f.gate("thread-reel" as never)).toBe(AWAY_THREAD_HOLD_REFUSAL);
      expect(f.resumedQueues).toEqual([]);
      f.network.down = false;
      expect(yield* f.away.retry).toBe("moved");
      // The target settled and never continued it: it runs here, its queue started.
      expect(yield* f.gate("thread-reel" as never)).toBeNull();
      expect(f.resumedQueues).toEqual(["thread-reel"]);
      expect(f.hold.current()).toBeNull();
    }),
  );

  it.effect("continued there: released only once handoff mode fences it here, queue kept", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      f.continuedOnMs.set("thread-reel", "thread-reel-ms");
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      // Not fenced here yet: the hold keeps it.
      expect(yield* f.away.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(yield* f.gate("thread-reel" as never)).toBe(AWAY_THREAD_HOLD_REFUSAL);
      f.fencedOnM4.add("thread-reel");
      expect(yield* f.away.retry).toBe("moved");
      expect(f.hold.current()).toBeNull();
      // Its queue is not started here; the fence keeps it for the machine that runs it.
      expect(f.resumedQueues).toEqual([]);
    }),
  );
});

describe("the boot is a wake (N2)", () => {
  it.effect("a lid close the restart cut off after the target acted gives way on start", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      yield* TestClock.setTime(T0 + 5 * MINUTE);
      expect(yield* f.away.boot).toEqual({ outcome: "prompt" });
      expect(f.binding("m4")?.state).toBe("transferred");
      expect(f.session.current()?.state).toBe("wake-prompt");
      yield* f.settled("boot-gave-way");
    }),
  );

  it.effect("a send-failed lid close is settled as nothing moved on start", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      f.network.modes.set(AWAY_INTENT_PATH, ["refuse"]);
      yield* f.lidClose;
      expect(f.session.current()?.state).toBe("send-failed");
      expect(yield* f.away.boot).toEqual({ outcome: "none" });
      expect(f.session.current()).toBeNull();
      expect(f.hold.current()).toBeNull();
      yield* f.settled("boot-nothing-moved");
    }),
  );
});

describe("Run here anyway (hold never lifts)", () => {
  it.effect(
    "offered after ten silent minutes; lifts the unknown hold and still gives way later",
    () =>
      Effect.gen(function* () {
        const f = yield* fleet;
        yield* f.lidClose;
        yield* TestClock.setTime(T0 + 2 * MINUTE);
        yield* f.intents.tick;
        yield* TestClock.setTime(T0 + 30 * MINUTE);
        f.network.down = true;
        yield* f.away.wake({ onBattery: true });
        expect(f.session.current()?.unreachableSince).toBe("2026-11-09T22:30:00.000Z");
        yield* TestClock.setTime(T0 + 35 * MINUTE);
        expect((yield* f.away.forceLocal).ok).toBe(false);
        expect(f.hold.current()).not.toBeNull();
        yield* TestClock.setTime(T0 + 41 * MINUTE);
        const forced = yield* f.away.forceLocal;
        expect(forced).toEqual({
          ok: true,
          projectIds: [f.m4ProjectId],
          threadIds: ["thread-reel"],
        });
        expect(f.hold.current()).toBeNull();
        expect(f.session.current()).toMatchObject({
          forcedLocalAt: "2026-11-09T22:41:00.000Z",
          forcedProjectIds: [f.m4ProjectId],
        });
        expect(f.resumedQueues).toEqual(["thread-reel"]);
        // The owner accepted it: both may run until the target answers.
        expect(yield* f.gate(f.coordinatorThread as never)).toBeNull();
        // Once it answers, this copy still gives way to its takeover.
        f.network.down = false;
        expect(yield* f.away.retry).toBe("moved");
        expect(f.binding("m4")?.state).toBe("transferred");
        yield* f.settled("forced-then-gave-way");
      }),
  );
});

describe("acceptAwayTakeover checks the recorded target's member (LOW)", () => {
  it.effect("a target that is not listed here, or an answer from another member, is refused", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.lidClose;
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
      const status = (yield* intentStatus(
        f.intents,
        callerFrom("m4"),
        { sourceEnvironmentId: "m4", projectIds: [f.m4ProjectId] },
        [],
        "ministorm",
      )).body as { projects: ReadonlyArray<{ takenOver: boolean }> };
      expect(status.projects[0]?.takenOver).toBe(false);
      // A takeover claimed under a machine this copy does not list is not accepted.
      const answer = {
        coordinatorBinding: {
          epoch: 9,
          state: "active" as const,
          operationId: "away:x:9",
          predecessor: f.members.m4,
          takenOverAt: "2026-11-09T22:02:00.000Z",
        },
        successor: { ...f.members.ms, environmentId: EnvironmentId.make("stranger") },
      };
      const accepted = yield* f.lease.acceptAwayTakeover({
        projectId: f.m4ProjectId,
        targetEnvironmentId: "stranger",
        takenOver: answer as never,
        receivedAt: "2026-11-09T22:30:00.000Z",
        sentAtMs: T0,
        answeredAtMs: T0,
      });
      expect(accepted).toBe(false);
      // The recorded target is listed, but the answer names another member: refused too.
      const refused = yield* f.lease.acceptAwayTakeover({
        projectId: f.m4ProjectId,
        targetEnvironmentId: "ministorm",
        takenOver: answer as never,
        receivedAt: "2026-11-09T22:30:00.000Z",
        sentAtMs: T0,
        answeredAtMs: T0,
      });
      expect(refused).toBe(false);
      expect(f.binding("m4")?.state ?? "active").toBe("active");
    }),
  );
});
