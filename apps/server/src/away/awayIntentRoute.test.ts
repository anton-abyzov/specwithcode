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
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_INTENT_STATUS_PATH,
  type AwayConfig,
  AwayError,
  type AwayHandoverResult,
  type AwayIntentRecord,
  type AwayIntentRequest,
  EnvironmentId,
  type Project,
  ProjectId,
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
import type { ContinuationEvidence } from "../handoff/handoffState.ts";
import { heardAwakeSince } from "../project/CoordinatorStandbyWatch.ts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectLink from "../project/ProjectLink.ts";
import { checkout, machine, removeCheckouts } from "../project/ProjectLink.testkit.ts";
import {
  actedResults,
  type AwayIntentsShape,
  linkedCopyOf,
  makeAwayIntents,
  memoryIntentStore,
} from "./AwayIntents.ts";
import { cancelIntent, type IntentAnswer, intentStatus, recordIntent } from "./awayIntentRoute.ts";
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
  /** What handoff mode here answers for each of the source's threads; unlisted: never began. */
  const evidence = new Map<string, ContinuationEvidence>();
  const continuation = (threadId: string) =>
    Effect.sync((): ContinuationEvidence => evidence.get(threadId) ?? { kind: "none" });
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
    continuation: (_source, threadId) => continuation(threadId),
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
  /** This version's status route on the target, as the source asks it. */
  const status = (body: unknown) =>
    intentStatus(
      { latestState: intents.latestState, continuation },
      callerFrom("m4"),
      body,
      Effect.sync(projectsHere),
      "ministorm",
    );
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
    evidence,
    status,
  };
});

const intentBody = (overrides: Record<string, unknown> = {}) => ({
  sourceEnvironmentId: "m4",
  graceMinutes: 2,
  projectIds: ["easychamp-m4"],
  threadIds: ["thread-reel"],
  ...overrides,
});

/** `POST /intent` here; it answers without reading the store on releases before it did. */
const register = (...args: Parameters<typeof recordIntent>): Effect.Effect<IntentAnswer> => {
  const answer: Effect.Effect<IntentAnswer> | IntentAnswer = recordIntent(...args);
  return Effect.isEffect(answer) ? answer : Effect.succeed(answer);
};

describe("away intent route", () => {
  it.effect("refuses a new intent: only the calling machine is told, and nothing is recorded", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const forged = yield* register(callerFrom("m1"), intentBody(), f.intents);
      expect(forged.status).toBe(403);
      const invalid = yield* register(callerFrom("m4"), { graceMinutes: -1 }, f.intents);
      expect(invalid.status).toBe(400);
      const answer = yield* register(callerFrom("m4"), intentBody(), f.intents);
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
      const status = yield* f.status({
        sourceEnvironmentId: "m4",
        projectIds: ["easychamp-m4"],
        threadIds: ["thread-reel"],
      });
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
      const status = yield* f.status({ sourceEnvironmentId: "m4", projectIds: ["easychamp-m4"] });
      expect(status.body).toMatchObject({
        intentState: "done",
        projects: [{ projectId: "easychamp-m4", takenOver: true, epoch: epoch + 1 }],
      });
      // The same body again may be its lost first delivery: the record answers, unchanged.
      expect(yield* register(callerFrom("m4"), intentBody(), f.intents)).toMatchObject({
        status: 200,
        body: { intent: { intentId: "intent-1", state: "done" }, refusedProjectIds: [] },
      });
      // A different one is new work, refused without disturbing the record of the old one.
      expect(
        (yield* register(callerFrom("m4"), intentBody({ graceMinutes: 5 }), f.intents)).status,
      ).toBe(409);
      // However late the same body arrives, it may still be that delivery: never "not accepted".
      yield* TestClock.setTime(T0 + 61 * MINUTE);
      expect((yield* register(callerFrom("m4"), intentBody(), f.intents)).status).toBe(200);
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
        continuation: () => Effect.succeed({ kind: "none" }),
      });
      const answer = yield* cancelIntent(failing, callerFrom("m4"), { sourceEnvironmentId: "m4" });
      // The source reads a 500 with our body as no answer about its intent: it keeps its hold.
      expect(answer.status).toBe(500);
      expect(yield* failing.tick).toEqual([]);
      // A repeated intent cannot be told from a new one: no answer, so the sender keeps its hold.
      const record = yield* register(callerFrom("m4"), intentBody(), failing);
      expect(record.status).toBe(503);
      expect(previousAwayAnswerKind(record.status, record.body)).toBe("uncertain");
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
        const intents = yield* makeAwayIntents({
          store: memoryIntentStore(),
          settleActed: () => Effect.succeed([]),
          continuation: () => Effect.succeed({ kind: "none" }),
        });
        // The previous release's own reading of this machine's answer.
        const post: AwayPeerPost = (_target, path, body) =>
          Effect.gen(function* () {
            sent.push(path);
            const answer = yield* register(
              callerFrom("m4"),
              JSON.parse(JSON.stringify(body)),
              intents,
            );
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
        expect(yield* intents.list).toEqual([]);
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
      const ask = f
        .status({ sourceEnvironmentId: "m4", projectIds: [], threadIds: ["thread-reel"] })
        .pipe(Effect.map((answer) => answer.body as Record<string, unknown>));
      expect(yield* ask).toMatchObject({
        intentState: "waiting",
        threads: [{ threadId: "thread-reel", continuedThreadId: null }],
        threadsSettled: false,
      });
      // A thread the earlier release continued before the update is still named.
      f.evidence.set("thread-reel", { kind: "continued", threadId: "thread-reel-ms" });
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

/**
 * The source on the previous release: its lid close, wake hold and wake check,
 * over a network to `route`. A route that dies is answered 500 without a
 * body, as the HTTP server answers it.
 */
const previousSource = (
  route: (path: string, body: unknown) => Effect.Effect<IntentAnswer>,
  ids: Pick<AwayIntentRequest, "projectIds" | "threadIds">,
) =>
  Effect.gen(function* () {
    const resumed: string[] = [];
    const fenced: string[] = [];
    const gaveWay: string[] = [];
    const wire = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;
    const post: AwayPeerPost = (_target, path, body) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(route(path, wire(body)));
        const answer = exit._tag === "Success" ? exit.value : { status: 500, body: null };
        const kind = previousAwayAnswerKind(answer.status, answer.body);
        if (kind === "answered") return { status: answer.status, json: wire(answer.body) };
        return yield* new AwayPeerError({
          message: "The target did not take it.",
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
      ids: () => Effect.succeed(ids),
      post,
      giveWay: (input) =>
        Effect.sync(() => {
          gaveWay.push(input.projectId);
          return true;
        }),
      // Handoff mode here fences a thread the target names as continued.
      confirmContinued: (threadIds) =>
        Effect.sync(() => {
          fenced.push(...threadIds);
          return new Set(threadIds);
        }),
      resumeQueues: (threadIds) => Effect.sync(() => void resumed.push(...threadIds)),
    });
    return { source, session, hold, resumed, fenced, gaveWay };
  });

/** The target's away routes as the source reaches them: the earlier release's until it updated. */
const ministorm =
  (
    f: {
      readonly before: PreviousIntents.AwayIntentsShape;
      readonly intents: AwayIntentsShape;
      readonly status: (body: unknown) => Effect.Effect<IntentAnswer>;
      readonly projectsHere: () => ReadonlyArray<Project>;
    },
    net: { updated: boolean },
  ) =>
  (path: string, body: unknown): Effect.Effect<IntentAnswer> => {
    const caller = callerFrom("m4");
    if (path === AWAY_INTENT_PATH)
      return net.updated
        ? register(caller, body, f.intents)
        : PreviousIntents.recordIntent(f.before, caller, body, f.projectsHere());
    if (path === AWAY_INTENT_CANCEL_PATH) return cancelIntent(f.intents, caller, body);
    if (path === AWAY_INTENT_STATUS_PATH) return f.status(body);
    return Effect.succeed({ status: 404, body: { error: "not found" } });
  };

const threadOnly = { projectIds: [], threadIds: ["thread-reel"] };

describe("a thread whose launch here is in doubt is never released as not continued", () => {
  it.effect("cut after the continuation launched, before it was recorded: held, then fenced", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const net = { updated: false };
      const m4 = yield* previousSource(ministorm(f, net), threadOnly);
      yield* (yield* m4.source.sleep({ onBattery: false })).send;
      expect(m4.session.current()?.state).toBe("pending-intent");
      // The earlier release acts after the grace: done first, then its hook launches the thread...
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      expect((yield* f.before.tick)[0]).toMatchObject({ state: "done" });
      expect(f.dueHooks).toHaveLength(1);
      // ...and stops before handoff mode records it. The target updates.
      net.updated = true;
      f.evidence.set("thread-reel", { kind: "unresolved" });
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      expect(yield* m4.source.wake({ onBattery: true })).toEqual({ outcome: "none" });
      // In doubt: still held, its queue not started here, nothing fenced.
      expect(m4.hold.current()?.threads).toEqual(["thread-reel"]);
      expect(m4.resumed).toEqual([]);
      expect(m4.fenced).toEqual([]);
      expect(yield* f.intents.tick).toEqual([]);
      // Handoff mode recovers the launched continuation: the source fences it and never runs it.
      f.evidence.set("thread-reel", { kind: "continued", threadId: "thread-reel-ms" });
      expect(yield* m4.source.retry).toBe("moved");
      expect(m4.fenced).toEqual(["thread-reel"]);
      expect(m4.resumed).toEqual([]);
      expect(m4.hold.current()).toBeNull();
    }),
  );

  it.effect("an acting intent that launched a thread but took no project ends done", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.recordedEarlier({ projectIds: [] });
      const [waiting] = f.store.current().intents;
      // The earlier release stopped mid-act; whether its thread launched is not known yet.
      yield* f.store.write({ version: 1, intents: [{ ...waiting!, state: "acting" }] });
      f.evidence.set("thread-reel", { kind: "unresolved" });
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.store.current().intents.map((intent) => intent.state)).toEqual(["acting"]);
      const asked = yield* cancelIntent(f.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(asked.body).toEqual({ cancelled: 0, state: "acting", takenOver: [] });
      // It launched: done, never "cancelled", which a source reads as "release everything".
      f.evidence.set("thread-reel", { kind: "continued", threadId: "thread-reel-ms" });
      expect((yield* f.intents.tick)[0]).toMatchObject({ state: "done" });
      expect(f.takeovers).toEqual([]);
      const status = yield* f.status({
        sourceEnvironmentId: "m4",
        projectIds: [],
        threadIds: ["thread-reel"],
      });
      expect(status).toMatchObject({
        status: 200,
        body: {
          intentState: "done",
          threads: [{ threadId: "thread-reel", continuedThreadId: "thread-reel-ms" }],
        },
      });
    }),
  );

  it.effect("the handoff record does not read: no answer yet, then the recorded continuation", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const net = { updated: false };
      const m4 = yield* previousSource(ministorm(f, net), threadOnly);
      yield* (yield* m4.source.sleep({ onBattery: false })).send;
      net.updated = true;
      // Updated within the grace: the waiting intent is cancelled and nothing is taken over.
      yield* TestClock.setTime(T0 + MINUTE);
      expect((yield* f.intents.tick)[0]).toMatchObject({ state: "cancelled" });
      // The first read of handoff mode's record fails. With the intent cancelled, a source
      // releases every thread it is not told was continued, so the whole answer waits.
      f.evidence.set("thread-reel", { kind: "unresolved" });
      const ask = { sourceEnvironmentId: "m4", projectIds: [], threadIds: ["thread-reel"] };
      expect((yield* f.status(ask)).status).toBe(503);
      expect(yield* m4.source.wake({ onBattery: true })).toEqual({ outcome: "none" });
      expect(m4.hold.current()?.threads).toEqual(["thread-reel"]);
      expect(m4.resumed).toEqual([]);
      // It reads now and names the thread an earlier release continued here.
      f.evidence.set("thread-reel", { kind: "continued", threadId: "thread-reel-ms" });
      expect(yield* f.status(ask)).toMatchObject({
        status: 200,
        body: {
          intentState: "cancelled",
          threads: [{ threadId: "thread-reel", continuedThreadId: "thread-reel-ms" }],
        },
      });
      expect(yield* m4.source.retry).toBe("moved");
      expect(m4.fenced).toEqual(["thread-reel"]);
      expect(m4.resumed).toEqual([]);
      expect(m4.hold.current()).toBeNull();
    }),
  );

  it.effect("projects that do not read are no answer, never not taken over", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* f.recordedEarlier();
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.before.tick;
      let failures = 1;
      const projects = Effect.suspend((): Effect.Effect<ReadonlyArray<Project>, string> =>
        failures-- > 0 ? Effect.fail("The project store is busy.") : Effect.sync(f.projectsHere),
      );
      const ask = Effect.exit(
        intentStatus(
          {
            latestState: f.intents.latestState,
            continuation: () => Effect.succeed({ kind: "none" }),
          },
          callerFrom("m4"),
          { sourceEnvironmentId: "m4", projectIds: ["easychamp-m4"] },
          projects,
          "ministorm",
        ),
      );
      const unread = yield* ask;
      expect(unread._tag).toBe("Success");
      if (unread._tag === "Success") expect(unread.value.status).toBe(503);
      const read = yield* ask;
      expect(read._tag).toBe("Success");
      if (read._tag === "Success")
        expect(read.value).toMatchObject({
          status: 200,
          body: { projects: [{ projectId: "easychamp-m4", takenOver: true }] },
        });
    }),
  );
});

describe("an intent delivered again across the update (lost answer)", () => {
  it.effect("the record answers, the source keeps its hold, and its wake gives way to it", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const epoch = f.binding("ms")?.epoch ?? 0;
      const caller = callerFrom("m4");
      const delivered: number[] = [];
      const route = ministorm(f, { updated: true });
      const m4 = yield* previousSource(
        (path, body) =>
          path !== AWAY_INTENT_PATH
            ? route(path, body)
            : Effect.gen(function* () {
                // The first delivery reached the earlier release, which recorded it and acted
                // after the grace; its answer was lost. The same request arrives again after
                // the target updated, and that answer reaches the source.
                yield* PreviousIntents.recordIntent(f.before, caller, body, f.projectsHere());
                yield* TestClock.setTime(T0 + 2 * MINUTE);
                expect((yield* f.before.tick)[0]).toMatchObject({ state: "done" });
                const again = yield* register(caller, body, f.intents);
                delivered.push(again.status);
                return again;
              }),
        { projectIds: [ProjectId.make("easychamp-m4")], threadIds: ["thread-reel"] },
      );
      yield* (yield* m4.source.sleep({ onBattery: false })).send;
      // The recorded outcome, never "not accepted": the source keeps its hold for the wake check.
      expect(delivered).toEqual([200]);
      expect(m4.session.current()?.state).toBe("pending-intent");
      expect(m4.hold.current()).not.toBeNull();
      // Nothing new was recorded or started for the second delivery.
      expect(f.store.current().intents.map((intent) => intent.state)).toEqual(["done"]);
      expect(f.takeovers).toEqual(["intent-1"]);
      // It wakes: it gives way where the target took over, and runs the thread it never continued.
      yield* TestClock.setTime(T0 + 30 * MINUTE);
      expect(yield* m4.source.wake({ onBattery: false })).toEqual({ outcome: "prompt" });
      expect(m4.gaveWay).toEqual(["easychamp-m4"]);
      expect(m4.resumed).toEqual(["thread-reel"]);
      expect(m4.hold.current()).toBeNull();
      expect(m4.session.current()?.state).toBe("wake-prompt");
      expect(f.binding("ms")).toMatchObject({ state: "active", epoch: epoch + 1 });
      expect(f.takeovers).toEqual(["intent-1"]);
    }),
  );
});
