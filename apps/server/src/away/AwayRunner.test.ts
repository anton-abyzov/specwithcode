/**
 * The Away runner (1267 AC-04, AC-06, AC-07, AC-08): coordinators, then
 * routines, then threads, then routines bound to moved threads; a resumed
 * session redoes nothing already settled; Bring back returns threads, then
 * routines, then coordinators, and re-arms the standby.
 */
import {
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
