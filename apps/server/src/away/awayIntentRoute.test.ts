/**
 * Away intents on the target (1267 AC-09): the source records one before it
 * sleeps; nothing happens while the grace runs or after the source cancels;
 * after the grace the target takes the coordinator over from the sleeping
 * source, and hands the intent to the runner's hook.
 */
import {
  type AwayHandoverResult,
  type AwayIntentRecord,
  EnvironmentId,
  type Project,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { linkedCopyOf, makeAwayIntents, memoryIntentStore } from "./AwayIntents.ts";
import { cancelIntent, intentStatus, recordIntent } from "./awayIntentRoute.ts";

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
  const intents = yield* makeAwayIntents({
    store,
    newId: Effect.sync(() => `intent-${++ids}`),
    heardAwake: () => Effect.succeed(awake.m4),
    act: (intent) =>
      Effect.gen(function* () {
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
  return { intents, store, awake, dueHooks, binding, members, projectsHere, lease };
});

const intentBody = (overrides: Record<string, unknown> = {}) => ({
  sourceEnvironmentId: "m4",
  graceMinutes: 2,
  projectIds: ["easychamp-m4"],
  threadIds: ["thread-reel"],
  ...overrides,
});

describe("away intent route", () => {
  it.effect("records an intent only for the calling machine and its linked projects", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const forged = yield* recordIntent(
        f.intents,
        callerFrom("m1"),
        intentBody(),
        f.projectsHere(),
      );
      expect(forged.status).toBe(403);
      const invalid = yield* recordIntent(
        f.intents,
        callerFrom("m4"),
        { graceMinutes: -1 },
        f.projectsHere(),
      );
      expect(invalid.status).toBe(400);
      const answer = yield* recordIntent(
        f.intents,
        callerFrom("m4"),
        intentBody({ projectIds: ["easychamp-m4", "not-linked"] }),
        f.projectsHere(),
      );
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        intent: {
          sourceEnvironmentId: "m4",
          projectIds: ["easychamp-m4"],
          threadIds: ["thread-reel"],
          state: "waiting",
          receivedAt: "2026-11-09T22:00:00.000Z",
          dueAt: "2026-11-09T22:02:00.000Z",
        },
        refusedProjectIds: ["not-linked"],
      });
    }),
  );

  it.effect("does nothing when the source cancels before the grace runs out", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      yield* TestClock.setTime(T0 + MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
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

  it.effect("takes the coordinator over after the grace, once, and calls the runner hook", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      const before = f.binding("ms")?.epoch ?? 0;
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      yield* TestClock.setTime(T0 + 2 * MINUTE - 1);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.binding("ms")?.state).toBe("transferred");
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      const settled = yield* f.intents.tick;
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        state: "done",
        results: [{ projectId: "easychamp-m4", outcome: "handed-over", epoch: before + 1 }],
      });
      expect(f.binding("ms")).toMatchObject({
        state: "active",
        epoch: before + 1,
        takenOverBy: "auto",
        predecessor: { environmentId: "m4" },
      });
      expect(f.dueHooks.map((intent) => intent.threadIds)).toEqual([["thread-reel"]]);
      // A later tick finds nothing left to do.
      yield* TestClock.setTime(T0 + 5 * MINUTE);
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.binding("ms")?.epoch).toBe(before + 1);
    }),
  );

  it.effect("cancels instead of taking over when the source was heard awake", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      f.awake.m4 = true;
      yield* TestClock.setTime(T0 + 3 * MINUTE);
      const settled = yield* f.intents.tick;
      expect(settled[0]).toMatchObject({ state: "cancelled", cancelReason: "heard-awake" });
      expect(f.binding("ms")?.state).toBe("transferred");
      expect(f.dueHooks).toEqual([]);
    }),
  );

  it.effect("an intent left acting by a restart is finished, and cannot be cancelled", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      const [held] = f.store.current().intents;
      // The process stopped after marking it acting, before the takeover.
      yield* f.store.write({ version: 1, intents: [{ ...held!, state: "acting" }] });
      const refused = yield* cancelIntent(f.intents, callerFrom("m4"), {
        sourceEnvironmentId: "m4",
      });
      expect(refused.body).toEqual({ cancelled: 0, state: "acting", takenOver: [] });
      f.awake.m4 = true;
      const settled = yield* f.intents.tick;
      // Heard awake no longer cancels it: the takeover may be under way.
      expect(settled[0]).toMatchObject({ state: "done" });
      expect(f.binding("ms")?.state).toBe("active");
      expect(f.dueHooks).toHaveLength(1);
    }),
  );

  it.effect("a new intent from the same source replaces the waiting one", () =>
    Effect.gen(function* () {
      const f = yield* fleet;
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      yield* recordIntent(
        f.intents,
        callerFrom("m4"),
        intentBody({ graceMinutes: 5 }),
        f.projectsHere(),
      );
      const held = f.store.current().intents;
      expect(held.map((intent) => [intent.intentId, intent.state])).toEqual([
        ["intent-1", "cancelled"],
        ["intent-2", "waiting"],
      ]);
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
      yield* recordIntent(f.intents, callerFrom("m4"), intentBody(), f.projectsHere());
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* f.intents.tick;
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
  it.effect("names each asked thread's continuation, settled only once the follow-up ended", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-09T22:00:00.000Z"));
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const intents = yield* makeAwayIntents({
        store: memoryIntentStore(),
        newId: Effect.succeed("intent-1"),
        heardAwake: () => Effect.succeed(false),
        act: () => Effect.succeed([]),
      });
      yield* intents.onIntentDue(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      );
      const caller = callerFrom("m4");
      yield* recordIntent(intents, caller, intentBody({ projectIds: [] }), []);
      const continued = new Map<string, string>();
      const ask = intentStatus(
        intents,
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
      yield* TestClock.setTime(Date.parse("2026-11-09T22:03:00.000Z"));
      const ticking = yield* Effect.forkChild(intents.tick);
      yield* Deferred.await(entered);
      // Done, but the follow-up that continues threads still runs.
      expect(yield* ask).toMatchObject({ intentState: "done", threadsSettled: false });
      continued.set("thread-reel", "thread-reel-ms");
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(ticking);
      expect(yield* ask).toMatchObject({
        intentState: "done",
        threads: [{ threadId: "thread-reel", continuedThreadId: "thread-reel-ms" }],
        threadsSettled: true,
      });
    }),
  );
});
