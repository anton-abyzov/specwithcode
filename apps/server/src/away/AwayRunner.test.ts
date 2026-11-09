/**
 * The Away runner (1267 AC-04, AC-06, AC-07, AC-08): coordinators, then
 * routines, then threads, then routines bound to moved threads; a resumed
 * session redoes nothing already settled; Bring back returns threads, then
 * routines, then coordinators, and re-arms the standby.
 */
import {
  AwayError,
  type AwayHandoverInput,
  type AwayPlan,
  type AwaySession,
  type CoordinatorRoutineCopy,
  EnvironmentId,
  type HandoffMachineThreadResult,
  type ScheduledTask,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AwayReturnRequest, AwayReturnResponse } from "./awayReturnRoute.ts";
import {
  awaySessionOf,
  hasWorkAway,
  makeAwayRunner,
  sessionFromPlan,
  type AwayRunnerDeps,
} from "./AwayRunner.ts";

const SELF = EnvironmentId.make("env-m4");
const TARGET = EnvironmentId.make("env-ministorm");

const task = (id: string, overrides: Partial<Record<string, unknown>>): ScheduledTask =>
  ({
    id,
    title: id,
    prompt: "Do it.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "p1",
    threadId: null,
    ownThread: false,
    ...overrides,
  }) as unknown as ScheduledTask;

const TASKS: ReadonlyArray<ScheduledTask> = [
  task("r-own", { ownThread: true }),
  task("r-hook", { schedule: { type: "webhook" } }),
  task("r-free", {}),
  task("r-bound", { threadId: "t1" }),
];

const PLAN: AwayPlan = {
  targetEnvironmentId: TARGET,
  targetLabel: "Ministorm",
  ready: true,
  checkedAt: "2026-11-09T22:00:00.000Z",
  missingGrants: [],
  items: [
    { kind: "thread", id: "t1", title: "Thread 1", action: "move", reason: "Moves." },
    { kind: "thread", id: "t2", title: "Thread 2", action: "move", reason: "Moves." },
    { kind: "thread", id: "t3", title: "Thread 3", action: "stay", reason: "Worktree set." },
    ...TASKS.map((entry) => ({
      kind: "routine" as const,
      id: entry.id,
      title: entry.title,
      projectId: entry.projectId,
      action: entry.schedule.type === "webhook" ? ("pause" as const) : ("move" as const),
      reason: "Moves.",
    })),
    {
      kind: "coordinator",
      id: "p1",
      title: "Project",
      projectId: "p1",
      action: "move",
      reason: "Hands over.",
    },
  ] as AwayPlan["items"],
};

function harness(options: {
  readonly saved?: AwaySession | null;
  readonly moveResults?: ReadonlyArray<HandoffMachineThreadResult>;
  readonly returnAnswer?: (request: AwayReturnRequest) => AwayReturnResponse;
}) {
  const log: Array<string> = [];
  let saved: AwaySession | null = options.saved ?? null;
  let ids = 0;
  const deps: AwayRunnerDeps = {
    selfEnvironmentId: SELF,
    loadSession: Effect.sync(() => saved),
    saveSession: (session) => Effect.sync(() => void (saved = session)),
    plan: () => Effect.sync(() => (log.push("plan"), PLAN)),
    now: Effect.succeed("2026-11-09T22:01:00.000Z"),
    newId: Effect.sync(() => `session-${(ids += 1)}`),
    fork: (effect) => effect,
    handOver: (input: AwayHandoverInput) =>
      Effect.sync(() => {
        log.push(`handOver:${input.projectId}:${input.reason}`);
        return { projectId: input.projectId, outcome: "handed-over", detail: "Done.", epoch: 4 };
      }),
    standbyMinutesOf: () => Effect.succeed(15),
    rearm: (projectId, target, minutes) =>
      Effect.sync(() => (log.push(`rearm:${projectId}:${target}:${minutes}`), null)),
    routines: Effect.succeed(TASKS),
    routineCopy: (entry) => ({ id: entry.id }) as unknown as CoordinatorRoutineCopy,
    transferOut: (input) =>
      Effect.sync(() => {
        log.push(`transfer:${input.task.id}:${input.boundThreadId ?? "-"}`);
        return { kind: "moved", targetProjectId: "q1", detail: "Runs there now." } as const;
      }),
    transferBack: (input) =>
      Effect.sync(() => {
        log.push(`transferBack:${input.task.id}`);
        return { kind: "returned", detail: "Runs here again." } as const;
      }),
    pauseHere: (id, note) =>
      Effect.sync(() => (log.push(`${note === null ? "resume" : "pause"}:${id}`), true)),
    rebind: (id, threadId) => Effect.sync(() => void log.push(`rebind:${id}:${threadId}`)),
    moveThreads: (_target, threadIds) =>
      Effect.sync(() => {
        log.push(`moveThreads:${threadIds.join(",")}`);
        return (
          options.moveResults ?? [
            {
              threadId: ThreadId.make("t1"),
              title: "Thread 1",
              outcome: "moved",
              detail: "Its queued message went too.",
              continuedThreadId: ThreadId.make("t1-on-target"),
              resumed: true,
            },
            {
              threadId: ThreadId.make("t2"),
              title: "Thread 2",
              outcome: "stayed",
              detail: "Ministorm: no .env.local",
              continuedThreadId: null,
              resumed: false,
            },
          ]
        );
      }),
    askReturn: (_target, request) =>
      Effect.sync(() => {
        log.push(
          `askReturn:${request.threadIds.join(",") || "-"}:${(request.projectIds ?? []).join(",") || "-"}`,
        );
        return (
          options.returnAnswer?.(request) ?? {
            results: request.threadIds.map((threadId) => ({
              threadId,
              outcome: "moved" as const,
              detail: "Continues here.",
              continuedThreadId: `${threadId}-back`,
            })),
            coordinators: (request.projectIds ?? []).map((projectId) => ({
              projectId,
              outcome: "handed-over" as const,
              detail: "Coordinates there.",
            })),
          }
        );
      }),
  };
  return { deps, log, saved: () => saved };
}

const item = (session: AwaySession, kind: string, id: string) =>
  session.items.find((entry) => entry.kind === kind && entry.id === id)!;

describe("AwayRunner leaving", () => {
  it.effect("runs coordinators, routines, threads, then routines bound to moved threads", () =>
    Effect.gen(function* () {
      const h = harness({});
      const runner = makeAwayRunner(h.deps);
      const first = yield* runner.start({ targetEnvironmentId: TARGET });
      expect(first.stage).toBe("coordinators");
      expect(h.log).toEqual([
        "plan",
        "handOver:p1:away",
        "pause:r-hook",
        "transfer:r-free:-",
        "moveThreads:t1,t2",
        "transfer:r-bound:t1-on-target",
      ]);
      const done = h.saved()!;
      expect(done.stage).toBe("done");
      expect(done.finishedAt).not.toBeNull();
      expect(item(done, "coordinator", "p1")).toMatchObject({
        outcome: "moved",
        standbyAfterMinutes: 15,
      });
      expect(item(done, "routine", "r-own")).toMatchObject({
        outcome: "moved",
        via: "coordinator",
      });
      expect(item(done, "routine", "r-hook")).toMatchObject({
        outcome: "paused",
        wasEnabled: true,
      });
      expect(item(done, "routine", "r-free")).toMatchObject({ outcome: "moved", via: "transfer" });
      expect(item(done, "routine", "r-bound")).toMatchObject({ outcome: "moved", via: "transfer" });
      expect(item(done, "thread", "t1")).toMatchObject({
        outcome: "moved",
        targetId: "t1-on-target",
      });
      // Never stopped: a thread that could not move stays here, ready, with the reason.
      expect(item(done, "thread", "t2")).toMatchObject({
        outcome: "handoff-ready",
        detail: "Ministorm: no .env.local",
      });
      expect(item(done, "thread", "t3")).toMatchObject({ outcome: "stayed" });
    }),
  );

  it.effect("keeps a routine bound to a thread that stayed", () =>
    Effect.gen(function* () {
      const h = harness({ moveResults: [] });
      yield* makeAwayRunner(h.deps).start({ targetEnvironmentId: TARGET });
      expect(h.log).not.toContain("transfer:r-bound:t1-on-target");
      expect(item(h.saved()!, "routine", "r-bound")).toMatchObject({ outcome: "stayed" });
    }),
  );

  it.effect("resumes an unfinished session at its stage without redoing settled items", () =>
    Effect.gen(function* () {
      const base = sessionFromPlan({
        sessionId: "s1",
        plan: PLAN,
        trigger: "manual",
        coordinatorScope: "live",
        startedAt: "2026-11-09T22:00:00.000Z",
      });
      const partway: AwaySession = {
        ...base,
        stage: "threads",
        items: base.items.map((entry) =>
          entry.kind === "thread"
            ? entry
            : { ...entry, outcome: entry.id === "r-bound" ? "pending" : "moved" },
        ),
      };
      const h = harness({ saved: partway });
      const resumed = yield* makeAwayRunner(h.deps).start({ targetEnvironmentId: TARGET });
      expect(resumed.sessionId).toBe("s1");
      expect(h.log).toEqual(["moveThreads:t1,t2", "transfer:r-bound:t1-on-target"]);
      expect(h.saved()!.stage).toBe("done");
    }),
  );

  it.effect("remembers the machine a person left for, but not one a lid close chose", () =>
    Effect.gen(function* () {
      const remembered: Array<string> = [];
      const h = harness({});
      const deps = {
        ...h.deps,
        rememberTarget: (target: EnvironmentId) => Effect.sync(() => void remembered.push(target)),
      };
      yield* makeAwayRunner(deps).start({ targetEnvironmentId: TARGET });
      expect(remembered).toEqual([TARGET]);

      const asleep = harness({});
      const slept: Array<string> = [];
      yield* makeAwayRunner({
        ...asleep.deps,
        rememberTarget: (target: EnvironmentId) => Effect.sync(() => void slept.push(target)),
      }).start({ targetEnvironmentId: TARGET, trigger: "sleep" });
      expect(slept).toEqual([]);
    }),
  );

  it.effect("refuses to leave again while work is still on the target", () =>
    Effect.gen(function* () {
      const h = harness({});
      const runner = makeAwayRunner(h.deps);
      yield* runner.start({ targetEnvironmentId: TARGET });
      const again = yield* runner.start({ targetEnvironmentId: TARGET }).pipe(Effect.flip);
      expect(again.message).toContain("Bring it back");
    }),
  );
});

describe("AwayRunner Bring back", () => {
  it.effect("returns threads, then routines, then coordinators, and re-arms the standby", () =>
    Effect.gen(function* () {
      const h = harness({});
      const runner = makeAwayRunner(h.deps);
      yield* runner.start({ targetEnvironmentId: TARGET });
      h.log.length = 0;
      yield* runner.bringBack({});
      expect(h.log).toEqual([
        "askReturn:t1-on-target:-",
        "resume:r-hook",
        "transferBack:r-free",
        "transferBack:r-bound",
        "rebind:r-bound:t1-on-target-back",
        "askReturn:-:p1",
        "rearm:p1:env-ministorm:15",
      ]);
      const back = h.saved()!;
      expect(back.broughtBackAt).not.toBeNull();
      expect(hasWorkAway(back)).toBe(false);
      expect(item(back, "thread", "t1").back).toMatchObject({
        outcome: "returned",
        localId: "t1-on-target-back",
      });
      expect(item(back, "routine", "r-own").back).toMatchObject({ outcome: "returned" });
      expect(item(back, "coordinator", "p1").back?.detail).toContain("standby again");
    }),
  );

  it.effect("keeps the session open when the target keeps a coordinator", () =>
    Effect.gen(function* () {
      const h = harness({
        returnAnswer: (request) => ({
          results: [],
          coordinators: (request.projectIds ?? []).map((projectId) => ({
            projectId,
            outcome: "failed" as const,
            detail: "Ministorm did not answer.",
          })),
        }),
      });
      const runner = makeAwayRunner(h.deps);
      yield* runner.start({ targetEnvironmentId: TARGET });
      yield* runner.bringBack({});
      const back = h.saved()!;
      expect(back.broughtBackAt).toBeNull();
      expect(item(back, "coordinator", "p1").back?.outcome).toBe("failed");
      expect(h.log.some((line) => line.startsWith("rearm:"))).toBe(false);
    }),
  );
});

describe("awaySessionOf", () => {
  it("reads a saved session and drops one it cannot read", () => {
    const session = sessionFromPlan({
      sessionId: "s1",
      plan: PLAN,
      trigger: "sleep",
      coordinatorScope: "all",
      startedAt: "2026-11-09T22:00:00.000Z",
    });
    expect(awaySessionOf(JSON.parse(JSON.stringify(session)))?.sessionId).toBe("s1");
    expect(awaySessionOf({ ...session, stage: "from-a-newer-version" })).toBeNull();
    expect(awaySessionOf(null)).toBeNull();
  });
});

describe("AwayRunner one run at a time (#10)", () => {
  it.effect("a second start while the first one runs answers its session, marked", () =>
    Effect.gen(function* () {
      const h = harness({});
      const held: Array<Effect.Effect<void>> = [];
      // The stages wait, as they would while moving work.
      const runner = makeAwayRunner({
        ...h.deps,
        fork: (effect) => Effect.sync(() => void held.push(effect)),
      });
      const first = yield* runner.start({ targetEnvironmentId: TARGET });
      expect(first.alreadyRunning).toBeUndefined();
      const second = yield* runner.start({ targetEnvironmentId: TARGET });
      expect(second).toMatchObject({ sessionId: first.sessionId, alreadyRunning: true });
      const back = yield* runner.bringBack({});
      expect(back.alreadyRunning).toBe(true);
      // Only one plan, one session.
      expect(h.log.filter((line) => line === "plan")).toHaveLength(1);
      yield* held[0]!;
      expect(yield* runner.isRunning).toBe(false);
    }),
  );

  it.effect("the claim is taken before anything waits", () =>
    Effect.gen(function* () {
      const h = harness({});
      const runner = makeAwayRunner({
        ...h.deps,
        plan: (input) => Effect.yieldNow.pipe(Effect.andThen(h.deps.plan(input))),
      });
      const [a, b] = yield* Effect.all(
        [
          runner.start({ targetEnvironmentId: TARGET }).pipe(Effect.result),
          runner.start({ targetEnvironmentId: TARGET }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      // One leaves; the other found it planning, with nothing saved yet, and was refused.
      expect([a._tag, b._tag].toSorted()).toEqual(["Failure", "Success"]);
      expect(h.log.filter((line) => line === "plan")).toHaveLength(1);
    }),
  );

  it.effect("a failure before the stages releases the claim", () =>
    Effect.gen(function* () {
      const h = harness({});
      let fail = true;
      const runner = makeAwayRunner({
        ...h.deps,
        plan: (input) =>
          fail
            ? Effect.fail(new AwayError({ code: "unreachable", message: "No answer." }))
            : h.deps.plan(input),
      });
      yield* runner.start({ targetEnvironmentId: TARGET }).pipe(Effect.flip);
      fail = false;
      const again = yield* runner.start({ targetEnvironmentId: TARGET });
      expect(again.alreadyRunning).toBeUndefined();
    }),
  );
});

describe("AwayRunner resume on start (#12)", () => {
  const base = sessionFromPlan({
    sessionId: "s1",
    plan: PLAN,
    trigger: "manual",
    coordinatorScope: "live",
    startedAt: "2026-11-09T22:00:00.000Z",
  });

  it.effect("carries on an unfinished leave, once", () =>
    Effect.gen(function* () {
      const h = harness({ saved: base });
      const runner = makeAwayRunner(h.deps);
      expect(yield* runner.resume).toBe(true);
      expect(h.saved()!.stage).toBe("done");
      h.log.length = 0;
      expect(yield* runner.resume).toBe(false);
      expect(h.log).toEqual([]);
    }),
  );

  it.effect("carries on a Bring back that did not finish", () =>
    Effect.gen(function* () {
      const h = harness({});
      const runner = makeAwayRunner(h.deps);
      yield* runner.start({ targetEnvironmentId: TARGET });
      const left = h.saved()!;
      const h2 = harness({ saved: { ...left, bringBackStartedAt: "2026-11-09T22:05:00.000Z" } });
      expect(yield* makeAwayRunner(h2.deps).resume).toBe(true);
      expect(h2.saved()!.broughtBackAt).not.toBeNull();
    }),
  );

  it.effect("leaves a lid close waiting for its wake alone", () =>
    Effect.gen(function* () {
      const h = harness({ saved: { ...base, trigger: "sleep", stage: "pending-intent" } });
      expect(yield* makeAwayRunner(h.deps).resume).toBe(false);
      expect(h.log).toEqual([]);
    }),
  );
});

describe("AwayRunner with a lid-close session (#4, #13)", () => {
  const sleeping: AwaySession = {
    sessionId: "s-sleep",
    targetEnvironmentId: TARGET,
    targetLabel: "Ministorm",
    trigger: "sleep",
    coordinatorScope: "live",
    startedAt: "2026-11-09T22:00:00.000Z",
    finishedAt: "2026-11-09T22:30:00.000Z",
    stage: "done",
    bringBackStartedAt: null,
    broughtBackAt: null,
    items: [
      {
        kind: "coordinator",
        id: "p1",
        projectId: "p1" as never,
        title: "P",
        outcome: "moved",
        detail: "Due.",
      },
      { kind: "thread", id: "t1", title: "T1", outcome: "pending", detail: "Checking." },
      { kind: "thread", id: "t2", title: "T2", outcome: "pending", detail: "Checking." },
      {
        kind: "routine",
        id: "r-bound",
        title: "R",
        outcome: "paused",
        via: "paused",
        wasEnabled: true,
        detail: "Paused while away on Ministorm.",
      },
    ],
  };

  it.effect("Bring back places threads from the handoff record, then asks for them", () =>
    Effect.gen(function* () {
      const h = harness({
        saved: sleeping,
        returnAnswer: (request) => ({
          results: request.threadIds.map((threadId) => ({
            threadId,
            outcome: "moved" as const,
            detail: "Continues here.",
            continuedThreadId: `${threadId}-back`,
          })),
          coordinators: (request.projectIds ?? []).map((projectId) => ({
            projectId,
            outcome: "skipped" as const,
            detail: "Not coordinating it.",
          })),
        }),
      });
      const runner = makeAwayRunner({
        ...h.deps,
        continuedOn: () => Effect.succeed(new Map([["t1", "t1-there"]])),
      });
      yield* runner.bringBack({});
      const back = h.saved()!;
      expect(h.log).toContain("askReturn:t1-there:-");
      expect(h.log).toContain("resume:r-bound");
      expect(item(back, "thread", "t1")).toMatchObject({ outcome: "moved", targetId: "t1-there" });
      expect(item(back, "thread", "t2").outcome).toBe("stayed");
      // No word of a takeover and the target does not coordinate it: it is here.
      expect(item(back, "coordinator", "p1").back?.outcome).toBe("returned");
      expect(back.broughtBackAt).not.toBeNull();
    }),
  );

  it.effect("refuses to leave while the wake check runs", () =>
    Effect.gen(function* () {
      const h = harness({ saved: { ...sleeping, stage: "pending-intent", finishedAt: null } });
      const refused = yield* makeAwayRunner(h.deps)
        .start({ targetEnvironmentId: TARGET })
        .pipe(Effect.flip);
      expect(refused.message).toContain("went to sleep");
    }),
  );
});

describe("AwayRunner in-doubt handovers (N1)", () => {
  const inDoubtHandOver =
    (calls: Array<AwayHandoverInput>, answers: Array<"in-doubt" | "handed-over" | "reverted">) =>
    (input: AwayHandoverInput) =>
      Effect.sync(() => {
        calls.push(input);
        const answer = answers.shift() ?? "handed-over";
        return answer === "in-doubt"
          ? {
              projectId: input.projectId,
              outcome: "in-doubt" as const,
              detail: "Ministorm did not confirm the handover.",
              operationId: "handover:p1:5",
            }
          : answer === "reverted"
            ? {
                projectId: input.projectId,
                outcome: "failed" as const,
                detail:
                  "Ministorm confirmed it never received the handover, so this machine coordinates this project again.",
                operationId: "handover:p1:5",
                reverted: true,
              }
            : {
                projectId: input.projectId,
                outcome: "handed-over" as const,
                detail: "Done.",
                epoch: 5,
                operationId: "handover:p1:5",
              };
      });

  /** A finished Leave whose only work away is the in-doubt coordinator p1. */
  const leftInDoubt = Effect.gen(function* () {
    const calls: Array<AwayHandoverInput> = [];
    const h = harness({ moveResults: [] });
    const plan: AwayPlan = {
      ...PLAN,
      items: PLAN.items.filter((entry) => entry.kind === "coordinator"),
    };
    const answers: Array<"in-doubt" | "handed-over" | "reverted"> = ["in-doubt"];
    const plans: Array<unknown> = [];
    const deps: AwayRunnerDeps = {
      ...h.deps,
      plan: (_input, options) => Effect.sync(() => (plans.push(options), plan)),
      handOver: inDoubtHandOver(calls, answers),
    };
    const runner = makeAwayRunner(deps);
    yield* runner.start({ targetEnvironmentId: TARGET });
    return { h, runner, calls, answers, plans, deps };
  });

  it.effect("records the coordinator as in-doubt, with its operation, and counts it as away", () =>
    Effect.gen(function* () {
      const { h } = yield* leftInDoubt;
      const session = h.saved()!;
      expect(item(session, "coordinator", "p1")).toMatchObject({
        outcome: "in-doubt",
        operationId: "handover:p1:5",
      });
      expect(hasWorkAway(session)).toBe(true);
    }),
  );

  it.effect("the next Leave finishes it under the same operation id via resumeOnly", () =>
    Effect.gen(function* () {
      const { h, runner, calls, plans } = yield* leftInDoubt;
      yield* runner.start({ targetEnvironmentId: TARGET });
      expect(plans.at(-1)).toEqual({ inDoubtProjectIds: ["p1"] });
      expect(calls.at(-1)).toMatchObject({
        projectId: "p1",
        operationId: "handover:p1:5",
        resumeOnly: true,
      });
      expect(item(h.saved()!, "coordinator", "p1").outcome).toBe("moved");
    }),
  );

  it.effect("a Leave to another machine is refused until it is finished", () =>
    Effect.gen(function* () {
      const { runner } = yield* leftInDoubt;
      const refused = yield* runner
        .start({ targetEnvironmentId: EnvironmentId.make("env-other") })
        .pipe(Effect.flip);
      expect(refused.message).toContain("has not confirmed the handover of 1 project");
    }),
  );

  it.effect("the retry takes it back here once the target confirms it never got it", () =>
    Effect.gen(function* () {
      const { h, runner, calls, answers } = yield* leftInDoubt;
      answers.push("reverted");
      expect(yield* runner.retryInDoubt).toBe(true);
      expect(calls.at(-1)).toMatchObject({ operationId: "handover:p1:5", resumeOnly: true });
      const session = h.saved()!;
      expect(item(session, "coordinator", "p1")).toMatchObject({
        outcome: "stayed",
        detail:
          "Ministorm confirmed it never received the handover, so this machine coordinates this project again.",
      });
      expect(hasWorkAway(session)).toBe(false);
      // Nothing left in doubt: the next retry does nothing.
      expect(yield* runner.retryInDoubt).toBe(false);
    }),
  );

  it.effect("Bring back finishes it first, then brings the coordinator back", () =>
    Effect.gen(function* () {
      const { h, runner } = yield* leftInDoubt;
      yield* runner.bringBack({});
      const session = h.saved()!;
      expect(item(session, "coordinator", "p1")).toMatchObject({
        outcome: "moved",
        back: { outcome: "returned" },
      });
      expect(session.broughtBackAt).not.toBeNull();
    }),
  );
});

describe("AwayRunner resume and the lid-close escape (N2, N3)", () => {
  it.effect("a Bring back cut off before leaving finished resumes as Bring back (N3)", () =>
    Effect.gen(function* () {
      const base = sessionFromPlan({
        sessionId: "s1",
        plan: PLAN,
        trigger: "manual",
        coordinatorScope: "live",
        startedAt: "2026-11-09T22:00:00.000Z",
      });
      const h = harness({
        saved: { ...base, bringBackStartedAt: "2026-11-09T22:05:00.000Z" },
      });
      expect(yield* makeAwayRunner(h.deps).resume).toBe(true);
      const session = h.saved()!;
      // Leaving finished first, then everything came back; no new plan was made.
      expect(h.log).not.toContain("plan");
      expect(h.log).toContain("askReturn:t1-on-target:-");
      expect(session.finishedAt).not.toBeNull();
      expect(session.broughtBackAt).not.toBeNull();
    }),
  );

  it.effect("Bring back on a lid close waiting for its wake runs the wake check first (N2)", () =>
    Effect.gen(function* () {
      const pending: AwaySession = {
        sessionId: "s-sleep",
        targetEnvironmentId: TARGET,
        targetLabel: "Ministorm",
        trigger: "sleep",
        coordinatorScope: "live",
        startedAt: "2026-11-09T22:00:00.000Z",
        finishedAt: null,
        stage: "pending-intent",
        bringBackStartedAt: null,
        broughtBackAt: null,
        items: [
          {
            kind: "coordinator",
            id: "p1",
            projectId: "p1" as never,
            title: "P",
            outcome: "pending",
            detail: "Due.",
          },
        ],
      };
      const h = harness({ saved: pending });
      let checks = 0;
      // The check finds nothing moved and closes the session.
      const runner = makeAwayRunner({
        ...h.deps,
        wakeCheck: Effect.gen(function* () {
          checks += 1;
          yield* h.deps.saveSession({
            ...pending,
            stage: "done",
            finishedAt: "2026-11-09T22:30:00.000Z",
            broughtBackAt: "2026-11-09T22:30:00.000Z",
            items: pending.items.map((entry) => ({ ...entry, outcome: "stayed" as const })),
          });
        }),
      });
      const answered = yield* runner.bringBack({});
      expect(checks).toBe(1);
      expect(answered.broughtBackAt).not.toBeNull();
      // Still silent: the check runs and the answer says what to do.
      const silent = harness({ saved: pending });
      const refused = yield* makeAwayRunner({ ...silent.deps, wakeCheck: Effect.void })
        .bringBack({})
        .pipe(Effect.flip);
      expect(refused.message).toContain("Run here anyway");
    }),
  );

  it.effect("Run here anyway needs ten silent minutes after a wake, then lifts the hold", () =>
    Effect.gen(function* () {
      const pending: AwaySession = {
        sessionId: "s-sleep",
        targetEnvironmentId: TARGET,
        targetLabel: "Ministorm",
        trigger: "sleep",
        coordinatorScope: "live",
        startedAt: "2026-11-09T21:00:00.000Z",
        finishedAt: null,
        stage: "pending-intent",
        bringBackStartedAt: null,
        broughtBackAt: null,
        items: [],
        sleep: {
          state: "pending-intent",
          targetEnvironmentId: TARGET,
          graceMinutes: 2,
          projectIds: [],
          threadIds: [],
          sentAt: "2026-11-09T21:00:00.000Z",
          dueAt: "2026-11-09T21:02:00.000Z",
          wokeAt: "2026-11-09T21:45:00.000Z",
          unreachableSince: "2026-11-09T21:45:00.000Z",
        },
      };
      let forced = 0;
      const early = harness({
        saved: {
          ...pending,
          sleep: { ...pending.sleep!, unreachableSince: "2026-11-09T21:58:00.000Z" },
        },
      });
      const tooSoon = yield* makeAwayRunner({
        ...early.deps,
        forceLocal: Effect.sync(() => ((forced += 1), null)),
      })
        .forceLocal({})
        .pipe(Effect.flip);
      expect(tooSoon.message).toContain("10 minutes");
      expect(forced).toBe(0);
      const h = harness({ saved: pending });
      yield* makeAwayRunner({
        ...h.deps,
        forceLocal: Effect.sync(() => ((forced += 1), null)),
      }).forceLocal({});
      expect(forced).toBe(1);
    }),
  );
});
