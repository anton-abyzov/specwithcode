/**
 * Away intents on the target (1390 AC-36, T-23). A machine going to sleep no
 * longer leaves work here: a new intent is refused, and one an earlier
 * release recorded is drained. Waiting, it is cancelled and nothing is taken
 * over. Already acted on, it keeps answering what was taken over, so the
 * source gives way. Cut off while acting, it is settled from what this
 * machine really took over. The earlier release is
 * `previousRelease.*.test.fixture.ts`, run on the same store.
 */
import {
  type AwayConfig,
  AwayError,
  type AwayHandoverResult,
  type AwayIntentRecord,
  EnvironmentId,
  type Project,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  type CoordinatorLeaseResponse,
} from "../handoff/handoffWire.ts";
import * as CoordinatorLeaseRoute from "../project/CoordinatorLeaseRoute.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { heardAwakeSince } from "../project/CoordinatorStandbyWatch.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectLink from "../project/ProjectLink.ts";
import { checkout, machine, removeCheckouts } from "../project/ProjectLink.testkit.ts";
import { actedResults, linkedCopyOf, makeAwayIntents, memoryIntentStore } from "./AwayIntents.ts";
import { cancelIntent, intentStatus, recordIntent } from "./awayIntentRoute.ts";
import { AwayPeerError, type AwayPeerPost } from "./awayPeerCall.ts";
import { memoryWakeHoldStore } from "./AwayWakeHold.ts";
import { previousAwayAnswerKind } from "../handoff/previousRelease.test.fixture.ts";
import * as PreviousIntents from "./previousRelease.awayIntents.test.fixture.ts";
import * as PreviousSleep from "./previousRelease.awaySleep.test.fixture.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-09T22:00:00.000Z");

const callerFrom = (environment: string): ReceiverCaller => ({
  sourceEnvironmentId: EnvironmentId.make(environment),
  grant: {
    coordinatorEnvironmentId: EnvironmentId.make(environment),
    projects: { kind: "linked" },
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
});

afterEach(() => removeCheckouts());

/** The M4 coordinates EasyChamp; Ministorm holds the linked copy and keeps the intents. */
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

  const awake = { m4: false };
  const dueHooks: AwayIntentRecord[] = [];
  const store = memoryIntentStore();
  let ids = 0;
  /** Takeovers started for an intent, by either version. */
  const takeovers: string[] = [];
  /** Intents this version settled from what was already taken over. */
  const settledActed: string[] = [];
  const earlier = {
    store,
    newId: Effect.sync(() => `intent-${++ids}`),
    heardAwake: () => Effect.succeed(awake.m4),
    act: (intent: AwayIntentRecord) =>
      Effect.gen(function* () {
        takeovers.push(intent.intentId);
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
  };
  /** Ministorm before its update: it records intents and acts on them after the grace. */
  const before = yield* PreviousIntents.makeAwayIntents(earlier);
  yield* before.onIntentDue((intent) => Effect.sync(() => void dueHooks.push(intent)));
  /** Ministorm on this version, reading the same saved intents. */
  const intents = yield* makeAwayIntents({
    ...earlier,
    settleActed: (intent: AwayIntentRecord) =>
      Effect.sync(() => {
        settledActed.push(intent.intentId);
        return actedResults([...ms.projects.values()], "ministorm", intent);
      }),
  });
  /** What the earlier release did with an intent from the M4. */
  const recordedEarlier = (overrides: Record<string, unknown> = {}) =>
    PreviousIntents.recordIntent(before, callerFrom("m4"), intentBody(overrides), [
      ...ms.projects.values(),
    ]);
  const binding = (name: "m4" | "ms") =>
    (name === "m4" ? m4.projects.get(members.m4.projectId) : ms.projects.get(members.ms.projectId))
      ?.workspaceSettings?.coordinatorBinding;
  const projectsHere = (): ReadonlyArray<Project> => [...ms.projects.values()];
  /** Ministorm's lease receiver, with a project list the testkit leaves out. */
  const projectsLayer = Layer.succeed(ProjectService.ProjectService, {
    getById: (projectId: string) =>
      Effect.sync(() => Option.fromNullishOr(ms.projects.get(projectId))),
    snapshot: Effect.sync(() => ({ projects: projectsHere() })),
  } as unknown as ProjectService.ProjectService["Service"]);
  const lease = (logicalProjectId: string) =>
    Effect.exit(
      Effect.flatMap(CoordinatorLeaseRoute.CoordinatorLeaseReceiver, (receiver) =>
        receiver.lease(callerFrom("m4"), {
          protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
          kind: "lease",
          logicalProjectId,
          epoch: 0,
          seq: 1,
          afterMinutes: 5,
          contentDigest: "digest",
          runningThreads: [],
          workers: [],
        }),
      ).pipe(
        Effect.provide(
          CoordinatorLeaseRoute.layer.pipe(
            Layer.provide(projectsLayer),
            Layer.provideMerge(ms.layer),
          ),
        ),
      ) as Effect.Effect<CoordinatorLeaseResponse, HandoffRefusal>,
    );
  return {
    before,
    intents,
    store,
    awake,
    dueHooks,
    takeovers,
    settledActed,
    recordedEarlier,
    binding,
    members,
    projectsHere,
    lease,
  };
});

const intentBody = (overrides: Record<string, unknown> = {}) => ({
  sourceEnvironmentId: "m4",
  graceMinutes: 2,
  projectIds: ["easychamp-m4"],
  threadIds: ["thread-reel"],
  ...overrides,
});

describe("away intent route", () => {
  it.effect("refuses a new intent: only the calling machine is told, and nothing is recorded", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const forged = recordIntent(callerFrom("m1"), intentBody());
      expect(forged.status).toBe(403);
      const invalid = recordIntent(callerFrom("m4"), { graceMinutes: -1 });
      expect(invalid.status).toBe(400);
      const answer = recordIntent(callerFrom("m4"), intentBody());
      expect(answer.status).toBe(409);
      expect(answer.body).toEqual({ error: expect.stringContaining("goes to sleep") });
      expect(f.store.current().intents).toEqual([]);
      // Grace or no grace, nothing is ever taken over for it.
      yield* TestClock.setTime(T0 + 10 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.takeovers).toEqual([]);
      expect(f.binding("ms")?.state).toBe("transferred");
    }),
  );

  it.effect("the source cancels an intent an earlier release recorded: nothing moved", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.recordedEarlier();
      const forged = yield* cancelIntent(f.intents, callerFrom("m1"), {
        sourceEnvironmentId: "m4",
      });
      expect(forged.status).toBe(403);
      const cancelled = yield* cancelIntent(f.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(cancelled).toEqual({
        status: 200,
        body: { cancelled: 1, state: "cancelled", takenOver: [] },
      });
      yield* TestClock.setTime(T0 + 10 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.binding("ms")?.state).toBe("transferred");
      expect(f.binding("m4")?.state ?? "active").toBe("active");
      expect(f.dueHooks).toEqual([]);
      expect(f.store.current().intents[0]).toMatchObject({
        state: "cancelled",
        cancelReason: "source-back",
      });
    }),
  );

  it.effect("pending: a waiting intent is cancelled, never acted on", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.recordedEarlier();
      // This machine updated while the intent waited; the source is asleep and silent.
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      const settled = yield* f.intents.tick;
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ state: "cancelled", cancelReason: "sleep-start-retired" });
      expect(f.takeovers).toEqual([]);
      expect(f.settledActed).toEqual([]);
      expect(f.dueHooks).toEqual([]);
      expect(f.binding("ms")?.state).toBe("transferred");
      // The source wakes and asks: a definite answer, so it runs its own work again.
      const status = yield* intentStatus(
        f.intents,
        callerFrom("m4"),
        { sourceEnvironmentId: "m4", projectIds: ["easychamp-m4"], threadIds: ["thread-reel"] },
        f.projectsHere(),
        "ministorm",
      );
      expect(status.body).toMatchObject({
        intentState: "cancelled",
        projects: [{ projectId: "easychamp-m4", takenOver: false }],
        threads: [{ threadId: "thread-reel", continuedThreadId: null }],
        threadsSettled: true,
      });
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
    }),
  );

  it.effect("already acted on: the takeover is still answered, never as not accepted", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const epoch = f.binding("ms")?.epoch ?? 0;
      yield* f.recordedEarlier();
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      // The earlier release acted while the source slept; its answer never reached the source.
      expect((yield* f.before.tick)[0]).toMatchObject({ state: "done" });
      expect(f.takeovers).toEqual(["intent-1"]);
      // Updated since. The source asks again: the same facts, and it must give way.
      const cancel = yield* cancelIntent(f.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(cancel).toEqual({
        status: 200,
        body: { cancelled: 0, state: "done", takenOver: ["easychamp-m4"] },
      });
      const status = yield* intentStatus(
        f.intents,
        callerFrom("m4"),
        { sourceEnvironmentId: "m4", projectIds: ["easychamp-m4"] },
        f.projectsHere(),
        "ministorm",
      );
      expect(status.body).toMatchObject({
        intentState: "done",
        projects: [{ projectId: "easychamp-m4", takenOver: true, epoch: epoch + 1 }],
      });
      // A new intent from that source is refused without disturbing the record of the old one.
      expect(recordIntent(callerFrom("m4"), intentBody()).status).toBe(409);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.takeovers).toEqual(["intent-1"]);
      expect(f.store.current().intents.map((intent) => intent.state)).toEqual(["done"]);
      expect(f.binding("ms")).toMatchObject({ state: "active", epoch: epoch + 1 });
    }),
  );

  it.effect("unknown: an intent cut off while acting settles from what was really taken", () =>
    Effect.gen(function* () {
      // The process stopped after marking it acting, before any takeover.
      const untouched = yield* fleet;
      yield* untouched.recordedEarlier();
      const [waiting] = untouched.store.current().intents;
      yield* untouched.store.write({ version: 1, intents: [{ ...waiting!, state: "acting" }] });
      const refused = yield* cancelIntent(untouched.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      // Not cancellable while unknown: the source keeps its hold.
      expect(refused.body).toEqual({ cancelled: 0, state: "acting", takenOver: [] });
      const settled = yield* untouched.intents.tick;
      // Nothing was taken, so it ends as cancelled: the source reads "done" as "work moved".
      expect(settled[0]).toMatchObject({
        state: "cancelled",
        cancelReason: "sleep-start-retired",
        results: [{ projectId: "easychamp-m4", outcome: "skipped" }],
      });
      expect(untouched.settledActed).toEqual(["intent-1"]);
      expect(untouched.takeovers).toEqual([]);
      expect(untouched.dueHooks).toEqual([]);
      expect(untouched.binding("ms")?.state).toBe("transferred");
      const after = yield* cancelIntent(untouched.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(after.body).toEqual({ cancelled: 0, state: "cancelled", takenOver: [] });

      // The process stopped after the takeover, before the intent was marked done.
      const taken = yield* fleet;
      yield* taken.recordedEarlier();
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* taken.before.tick;
      const [done] = taken.store.current().intents;
      const { results: _results, ...unfinished } = done!;
      yield* taken.store.write({ version: 1, intents: [{ ...unfinished, state: "acting" }] });
      const finished = yield* taken.intents.tick;
      expect(finished[0]).toMatchObject({
        state: "done",
        results: [{ projectId: "easychamp-m4", outcome: "handed-over" }],
      });
      // Nothing new was started to get there.
      expect(taken.takeovers).toEqual(["intent-1"]);
      expect(taken.dueHooks).toHaveLength(1);
      const told = yield* cancelIntent(taken.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(told.body).toEqual({ cancelled: 0, state: "done", takenOver: ["easychamp-m4"] });
    }),
  );

  it.effect("an unreadable intent file is an error, never a cancelled intent", () =>
    Effect.gen(function* () {
      const failing = yield* makeAwayIntents({
        store: {
          read: Effect.fail(new AwayError({ code: "failed", message: "Could not read." })),
          write: () => Effect.void,
        },
        settleActed: () => Effect.succeed([]),
      });
      const answer = yield* cancelIntent(failing, callerFrom("m4"), { sourceEnvironmentId: "m4" });
      // The source reads a 500 with our body as no answer about its intent: it keeps its hold.
      expect(answer.status).toBe(500);
      expect(yield* failing.tick).toEqual([]);
    }),
  );
});

describe("against the previous release (v1.0.378)", () => {
  it.effect(
    "a machine on the previous release sleeps: this one refuses, and that one runs on",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        expect(PreviousSleep.PREVIOUS_RELEASE).toBe("v1.0.378");
        const sent: string[] = [];
        const answered: number[] = [];
        // The previous release's own reading of this machine's answer.
        const post: AwayPeerPost = (_target, path, body) =>
          Effect.gen(function* () {
            sent.push(path);
            const answer = recordIntent(callerFrom("m4"), JSON.parse(JSON.stringify(body)));
            answered.push(answer.status);
            const kind = previousAwayAnswerKind(answer.status, answer.body);
            if (kind === "answered") return { status: answer.status, json: answer.body };
            return yield* new AwayPeerError({
              message: "Ministorm refused.",
              refused: kind === "refused",
              uncertain: kind === "uncertain",
              status: answer.status,
            });
          });
        const session = PreviousSleep.memorySleepStore();
        const hold = memoryWakeHoldStore();
        const source = yield* PreviousSleep.makeAwaySleep({
          self: EnvironmentId.make("m4"),
          store: session,
          hold,
          config: Effect.succeed<AwayConfig>({
            target: EnvironmentId.make("ministorm"),
            sleepTrigger: "always",
            graceMinutes: 2,
            bringBack: "prompt",
            coordinatorScope: "live",
          }),
          ids: () => Effect.succeed({ projectIds: [], threadIds: ["thread-reel"] }),
          post,
        });
        const decision = yield* source.sleep({ onBattery: false });
        expect(decision.answer).toEqual({ outcome: "left" });
        expect(hold.current()).not.toBeNull();
        yield* decision.send;
        // A definite refusal: the old sender lets its hold go and keeps the work.
        expect(session.current()?.state).toBe("send-failed");
        expect(hold.current()).toBeNull();
        expect(sent).toHaveLength(1);
        expect(answered).toEqual([409]);
      }),
  );
});

describe("the lease route after an away takeover", () => {
  it.effect("tells the old coordinator it was taken over, with no standby record here", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const logicalProjectId = f.projectsHere()[0]!.workspaceSettings!.logicalProject!.id;
      const before = yield* f.lease(logicalProjectId);
      expect(before._tag).toBe("Failure");
      // The takeover an earlier release made for a sleeping machine still stands.
      yield* f.recordedEarlier();
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.before.tick;
      const after = yield* f.lease(logicalProjectId);
      expect(after._tag).toBe("Success");
      if (after._tag === "Success")
        expect(after.value.takenOver).toMatchObject({
          coordinatorBinding: { state: "active", predecessor: { environmentId: "m4" } },
          successor: { environmentId: "ministorm" },
        });
    }),
  );
});

describe("heardAwakeSince", () => {
  const since = Date.parse("2026-11-09T22:00:00.000Z");
  it("counts only a lease after the intent that was not the going-to-sleep one", () => {
    expect(
      heardAwakeSince({ lastLeaseAt: "2026-11-09T22:01:00.000Z", coordinatorSleptAt: null }, since),
    ).toBe(true);
    expect(
      heardAwakeSince(
        {
          lastLeaseAt: "2026-11-09T22:00:01.000Z",
          coordinatorSleptAt: "2026-11-09T22:00:01.000Z",
        },
        since,
      ),
    ).toBe(false);
    expect(
      heardAwakeSince({ lastLeaseAt: "2026-11-09T21:59:00.000Z", coordinatorSleptAt: null }, since),
    ).toBe(false);
    expect(heardAwakeSince({ lastLeaseAt: null, coordinatorSleptAt: null }, since)).toBe(false);
  });
});

describe("intent status for threads (#13)", () => {
  it.effect("names each asked thread's continuation, settled once no intent waits or acts", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.recordedEarlier({ projectIds: [] });
      const caller = callerFrom("m4");
      const continued = new Map<string, string>();
      const ask = intentStatus(
        f.intents,
        caller,
        { sourceEnvironmentId: "m4", projectIds: [], threadIds: ["thread-reel"] },
        [],
        "ms",
        (threadId) => continued.get(threadId) ?? null,
      ).pipe(Effect.map((answer) => answer.body as Record<string, unknown>));
      expect(yield* ask).toMatchObject({
        intentState: "waiting",
        threads: [{ threadId: "thread-reel", continuedThreadId: null }],
        threadsSettled: false,
      });
      // A thread the earlier release continued before the update is still named.
      continued.set("thread-reel", "thread-reel-ms");
      yield* TestClock.setTime(T0 + 3 * MINUTE);
      yield* f.intents.tick;
      expect(yield* ask).toMatchObject({
        intentState: "cancelled",
        threads: [{ threadId: "thread-reel", continuedThreadId: "thread-reel-ms" }],
        threadsSettled: true,
      });
    }),
  );
});
