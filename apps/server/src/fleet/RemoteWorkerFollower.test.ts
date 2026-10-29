import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type { CoordinatorStandbyShadowWorker } from "../project/CoordinatorStandbyStore.ts";

import type { FakeToolHandler } from "./fakeStudioMcp.testkit.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerAdoption from "./RemoteWorkerAdoption.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import {
  allow,
  eventually,
  launchAnswer,
  launchInput,
  project,
  rows,
  setup,
} from "./remoteWorkers.testkit.ts";

const finished = (runId: string) => ({
  result: { threadId: "b-thread-1", runId, status: "completed", timedOut: false },
});
const stillRunning = (runId: string) => ({
  result: { threadId: "b-thread-1", runId, status: "running", timedOut: true },
});
const machineDown: FakeToolHandler = () => ({ raw: new Response("down", { status: 503 }) });

describe("RemoteWorkerFollower", () => {
  it.live("follows the run a message started while it was still following the first", () => {
    let releaseRun1: () => void = () => {};
    const run1Done = new Promise<void>((resolve) => {
      releaseRun1 = resolve;
    });
    let run1WaitStarted = false;
    const { world, layer } = setup({
      studio_thread_wait: async (args) => {
        if (args.runId === "b-run-1") {
          run1WaitStarted = true;
          await run1Done;
          return finished("b-run-1");
        }
        return finished("b-run-2");
      },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      yield* eventually(
        Effect.sync(() => run1WaitStarted),
        (started) => started,
      );
      // The coordinator queued a follow-up on the worker; the other machine answered run 2.
      yield* workers.noteRun({
        callerThreadId: ThreadId.make("coordinator"),
        machineId: "m1",
        remoteThreadId: "b-thread-1",
        runId: "b-run-2",
      });
      releaseRun1();
      const [row] = yield* eventually(
        rows,
        (current) => current[0]?.state === "idle" && current[0].deliveredRunIds.includes("b-run-2"),
      );
      expect(row?.deliveredRunIds).toEqual(["b-run-1", "b-run-2"]);
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-wake:rwt:command-1:b-run-1",
        "remote-worker-wake:rwt:command-1:b-run-2",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores a run noted or seen by a thread other than the one that launched it", () => {
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      const other = ThreadId.make("someone-else");
      yield* workers.noteFinished({
        callerThreadId: other,
        machineId: "m1",
        remoteThreadId: "b-thread-1",
        runId: "b-run-1",
        status: "completed",
      });
      yield* workers.noteRun({
        callerThreadId: other,
        machineId: "m1",
        remoteThreadId: "b-thread-1",
        runId: "b-run-9",
      });
      const [row] = yield* rows;
      expect(row).toMatchObject({ state: "following", followedRunId: "b-run-1" });
      release = true;
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(world.wakes).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("settles a launch cut off mid-call instead of leaving it launching", () => {
    // Latches, not timers: the launch reaches the other machine, is cut off
    // here, and only then finishes over there, before the stale sweep reads
    // the other machine's thread list.
    let launched = false;
    let received: () => void = () => {};
    const launchReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    let finishLaunch: () => void = () => {};
    const launchFinishes = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    let listed: () => void = () => {};
    const launchListed = new Promise<void>((resolve) => {
      listed = resolve;
    });
    const { world, layer } = setup(
      {
        studio_thread_launch: async () => {
          received();
          await launchFinishes;
          launched = true; // The other machine created and started the thread anyway.
          listed();
          return { result: launchAnswer };
        },
        studio_thread_list: async () => {
          // Asked only once the call was cut off: the other machine finishes the launch first.
          finishLaunch();
          await launchListed;
          return {
            result: {
              projectId: "remote-project",
              currentThreadId: null,
              threads: launched
                ? [
                    {
                      threadId: "b-thread-1",
                      title: "Fix the flaky test",
                      createdBy: "agent",
                      creationSource: "mcp",
                      status: "running",
                      latestRunId: "b-run-1",
                      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                    },
                  ]
                : [],
              nextCursor: null,
              total: launched ? 1 : 0,
            },
          };
        },
      },
      // No periodic sweep: the reconcile that settles it is the one the cut-off starts.
      { launchStaleMs: 50, authPollMs: 60_000 },
    );
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const launch = yield* Effect.forkChild(workers.launch(launchInput()));
      yield* Effect.promise(() => launchReceived);
      // The coordinator's MCP client cancels the call (tool timeout, user Stop).
      const [cutOff] = yield* rows;
      expect(cutOff?.state).toBe("launching");
      yield* Fiber.interrupt(launch);
      expect(Exit.hasInterrupts(yield* Fiber.await(launch))).toBe(true);
      const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(row?.remoteThreadId).toBe("b-thread-1");
      expect(world.wakes).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("a periodic sweep settles a launch nothing here is carrying out", () => {
    const { layer } = setup(
      {
        studio_thread_list: () => ({
          result: { projectId: "remote-project", currentThreadId: null, threads: [] },
        }),
      },
      { launchStaleMs: 10, authPollMs: 20 },
    );
    return Effect.gen(function* () {
      yield* allow();
      const records = yield* RemoteWorkerStore.RemoteWorkerStore;
      const startedAt = DateTime.formatIso(DateTime.nowUnsafe());
      yield* records.modify("rwt:orphan", () => ({
        id: "rwt:orphan",
        callerThreadId: "coordinator",
        projectId: "local-project",
        machineId: "m1",
        environmentId: "env-m1",
        remoteProjectId: "remote-project",
        remoteThreadId: null,
        title: "Fix the flaky test",
        launchStartedAt: startedAt,
        followedRunId: null,
        reportBack: true,
        state: "launching",
        lastStatus: null,
        deliveredRunIds: [],
        lostContactNotified: false,
        lastError: null,
        updatedAt: startedAt,
      }));
      yield* eventually(rows, (current) => current[0]?.state === "launch_unknown");
    }).pipe(Effect.provide(layer));
  });

  it.live("sends a recent wake again at boot, and never one the caller saw for itself", () => {
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      release = true;
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      release = false;
      yield* workers.launch(launchInput({ commandId: "command-2" }));
      yield* workers.noteFinished({
        callerThreadId: ThreadId.make("coordinator"),
        machineId: "m1",
        remoteThreadId: "b-thread-1",
        runId: "b-run-1",
        status: "completed",
      });
      expect(world.wakes).toHaveLength(1);
      // A restart after an update rolled the database back: the wake is sent
      // again under its own id, which the orchestrator replays if it has it.
      const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
      yield* follower.resume;
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-wake:rwt:command-1:b-run-1",
        "remote-worker-wake:rwt:command-1:b-run-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("tells the caller once per outage that its worker's machine is gone", () => {
    let down = true;
    const { world, layer } = setup(
      {
        studio_thread_wait: (args) =>
          down ? machineDown(args) : stillRunning(String(args.runId ?? "b-run-1")),
      },
      { lostContactMs: 30 },
    );
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      yield* eventually(
        Effect.sync(() => world.wakes.length),
        (count) => count === 1,
      );
      expect(world.notices[0]?.summary).toBe(
        "Lost contact with [Fix the flaky test](studio://thread/env-m1/b-thread-1) on M1.",
      );
      down = false;
      yield* eventually(rows, (current) => current[0]?.lostContactNotified === false);
      down = true;
      yield* eventually(
        Effect.sync(() => world.wakes.length),
        (count) => count === 2,
      );
      expect(new Set(world.wakes.map((wake) => wake.commandId)).size).toBe(2);
    }).pipe(Effect.provide(layer));
  });
});

describe("a remote worker waiting on the person", () => {
  const readAnswer = (pendingRequestCount: number) => ({
    result: {
      thread: { threadId: "b-thread-1", status: "running", pendingRequestCount },
      recentRuns: [],
      items: [],
      nextPosition: null,
      hasMore: false,
    },
  });

  it.live("shows it as waiting on you, tells the caller once, and goes back to working", () => {
    let pending = 1;
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
      studio_thread_read: () => readAnswer(pending),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      const [held] = yield* eventually(
        rows,
        (current) => current[0]?.lastStatus === RemoteWorkerFollower.REMOTE_WORKER_WAITING_ON_YOU,
      );
      expect(held?.state).toBe("following");
      // The page lists it as waiting on you, not as a run that is still working.
      const listed = yield* workers.workersForProject(launchInput().localProject.id);
      expect(listed[0]).toMatchObject({ state: "following", lastStatus: "waiting_on_you" });
      // Several passes while it stays held: the caller hears about it once.
      yield* Effect.sleep("150 millis");
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-waiting:rwt:command-1:b-run-1",
      ]);
      expect(world.notices).toEqual([
        {
          createdBy: "agent",
          summary:
            "[Fix the flaky test](studio://thread/env-m1/b-thread-1) on M1 is waiting on you.",
        },
      ]);
      // Answered over there: it reads as running again, then reports back as usual.
      pending = 0;
      yield* eventually(rows, (current) => current[0]?.lastStatus === "running");
      release = true;
      const [done] = yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(done?.lastStatus).toBe("completed");
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-waiting:rwt:command-1:b-run-1",
        "remote-worker-wake:rwt:command-1:b-run-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves a request answered before the next poll as working, with no wake", () => {
    // A Full access machine answers its own approval within moments.
    let reads = 0;
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
      studio_thread_read: () => readAnswer(++reads === 1 ? 1 : 0),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      yield* eventually(
        Effect.sync(() => reads),
        (count) => count >= 3,
      );
      const [row] = yield* rows;
      expect(row?.lastStatus).toBe("running");
      expect(world.wakes).toEqual([]);
      release = true;
      const [done] = yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(done?.lastStatus).toBe("completed");
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-wake:rwt:command-1:b-run-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps following as before when the other machine cannot say", () => {
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
      studio_thread_read: machineDown,
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      yield* eventually(rows, (current) => current[0]?.lastStatus === "running");
      release = true;
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(world.wakes.map((wake) => wake.commandId)).toEqual([
        "remote-worker-wake:rwt:command-1:b-run-1",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("RemoteStudioMcpClient sessions", () => {
  it.live("one call timing out does not break the others sharing the machine's session", () => {
    const slow: FakeToolHandler = async () => {
      await Effect.runPromise(Effect.sleep(600));
      return finished("b-run-1");
    };
    const { layer } = setup({ studio_thread_wait: slow, studio_thread_read: slow });
    return Effect.gen(function* () {
      yield* allow();
      const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
      yield* client.call({ machineId: "m1", tool: "orchestrator_capabilities", arguments: {} });
      const [following, other] = yield* Effect.all(
        [
          client
            .call({
              machineId: "m1",
              tool: "studio_thread_wait",
              arguments: { threadId: "b-thread-1" },
              timeoutMs: 5_000,
            })
            .pipe(Effect.result),
          client
            .call({
              machineId: "m1",
              tool: "studio_thread_read",
              arguments: { threadId: "x" },
              timeoutMs: 100,
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(other._tag).toBe("Failure");
      expect(following._tag).toBe("Success");
    }).pipe(Effect.provide(layer));
  });
});

/**
 * 1086 AC-08 and AC-09: after M1 took over from M4, the workers M4's
 * coordinator thread started on M3 (the fake machine "m1" here) report to M1.
 */
describe("adopting the replaced coordinator's workers", () => {
  const predecessor = {
    environmentId: EnvironmentId.make("env-m4-old"),
    projectId: ProjectId.make("m4-project"),
    coordinatorThreadId: ThreadId.make("project-coordinator:m4-project"),
  };
  const shadow = (
    id: string,
    overrides: Partial<CoordinatorStandbyShadowWorker> = {},
  ): CoordinatorStandbyShadowWorker => ({
    id,
    callerThreadId: predecessor.coordinatorThreadId,
    // M4's own name for the machine; this server names it "m1".
    machineId: "m3-as-m4-names-it",
    environmentId: "env-m1",
    remoteProjectId: "remote-project",
    remoteThreadId: `thread-${id}`,
    title: `Worker ${id}`,
    state: "following",
    followedRunId: `run-${id}`,
    deliveredRunIds: [],
    ...overrides,
  });
  const shadows = [
    shadow("a"),
    // M4 already told its coordinator about this run.
    shadow("b", { deliveredRunIds: ["older", "run-b"] }),
    // A run that finished while M4's wake could not be queued.
    shadow("c", { state: "wake_pending" }),
    // Started by another thread on M4, not its coordinator.
    shadow("d", { callerThreadId: "some-thread-on-m4" }),
    // M3 says another machine started it.
    shadow("e"),
    // Still launching: M4 settles it when it returns.
    shadow("f", { state: "launching", remoteThreadId: null }),
    shadow("g", { state: "idle" }),
  ];
  const input: RemoteWorkerAdoption.AdoptWorkersInput = {
    logicalProjectId: "logical:app",
    epoch: 5,
    projectId: "local-project",
    coordinatorThreadId: "coordinator",
    predecessor,
    shadowWorkers: shadows,
  };
  const claimAnswer = (accepted: boolean) => ({
    result: {
      logicalProjectId: "logical:app",
      accepted,
      epoch: 5,
      origins: [
        { threadId: "thread-a", coordinatorEnvironmentId: "env-m4-old" },
        { threadId: "thread-b", coordinatorEnvironmentId: "env-m4-old" },
        { threadId: "thread-c", coordinatorEnvironmentId: "env-m4-old" },
        { threadId: "thread-e", coordinatorEnvironmentId: "env-m3" },
      ],
    },
  });
  const finishedRun: FakeToolHandler = (args) => ({
    result: {
      threadId: args.threadId,
      runId: String(args.runId),
      status: "completed",
      timedOut: false,
    },
  });
  const withAdoption = <A, E, R>(layer: Layer.Layer<R, E>) =>
    Effect.provide(RemoteWorkerAdoption.layer.pipe(Layer.provideMerge(layer)));

  it.live("claims the epoch, follows only confirmed workers, and delivers each run once", () => {
    const { world, remote, layer } = setup({
      studio_coordinator_claim_epoch: () => claimAnswer(true),
      studio_thread_wait: finishedRun,
    });
    return Effect.gen(function* () {
      yield* allow();
      const adoption = yield* RemoteWorkerAdoption.RemoteWorkerAdoption;
      const result = yield* adoption.adopt(input);
      expect(result).toEqual({
        adopted: ["takeover:a", "takeover:b", "takeover:c"],
        readOnly: [],
        waitingForPredecessor: 1,
      });
      expect(
        remote.toolCalls.find((call) => call.name === "studio_coordinator_claim_epoch"),
      ).toEqual({
        name: "studio_coordinator_claim_epoch",
        args: {
          logicalProjectId: "logical:app",
          epoch: 5,
          threadIds: ["thread-a", "thread-b", "thread-c", "thread-e"],
        },
      });
      const settled = yield* eventually(
        rows,
        (current) => current.length === 3 && current.every((row) => row.state === "idle"),
      );
      // Mapped to this server's machine, project and coordinator thread.
      for (const row of settled)
        expect(row).toMatchObject({
          machineId: "m1",
          projectId: "local-project",
          callerThreadId: "coordinator",
          environmentId: "env-m1",
          readOnly: false,
          adoptedFrom: { environmentId: "env-m4-old", epoch: 5 },
        });
      // Run b was delivered on M4 already; a and c were not.
      expect(world.wakes.map((wake) => wake.commandId).sort()).toEqual([
        "remote-worker-wake:takeover:a:run-a",
        "remote-worker-wake:takeover:c:run-c",
      ]);
      // A retry adopts nothing twice and wakes no one again.
      const again = yield* adoption.adopt(input);
      expect(again.adopted).toEqual(["takeover:a", "takeover:b", "takeover:c"]);
      expect(world.wakes).toHaveLength(2);
      expect(yield* rows).toHaveLength(3);
    }).pipe(withAdoption(layer));
  });

  it.live("shows workers read-only while their machine refuses the claim or lacks it", () => {
    let answer: "refuse" | "accept" = "refuse";
    const { world, remote, layer } = setup({
      studio_coordinator_claim_epoch: () => claimAnswer(answer === "accept"),
      studio_thread_wait: finishedRun,
    });
    return Effect.gen(function* () {
      yield* allow();
      const adoption = yield* RemoteWorkerAdoption.RemoteWorkerAdoption;
      const refused = yield* adoption.adopt(input);
      expect(refused.adopted).toEqual([]);
      expect(refused.readOnly).toEqual(["takeover:a", "takeover:b", "takeover:c", "takeover:e"]);
      for (const row of yield* rows) {
        expect(row).toMatchObject({ state: "stopped", readOnly: true });
        expect(row.lastError).toBe("M1 did not let this Mac take over its workers.");
      }
      // An older SpecWithCode there has no claim at all.
      delete world.tools.studio_coordinator_claim_epoch;
      yield* adoption.adopt(input);
      expect((yield* rows)[0]?.lastError).toBe(
        "M1 needs an update before this Mac can take over its workers.",
      );
      // Read-only rows are never followed or delivered.
      expect(remote.toolCalls.some((call) => call.name === "studio_thread_wait")).toBe(false);
      expect(world.wakes).toEqual([]);
      // Once it accepts, the confirmed ones are taken on and followed.
      world.tools.studio_coordinator_claim_epoch = () => claimAnswer(true);
      answer = "accept";
      const accepted = yield* adoption.adopt(input);
      expect(accepted.adopted).toEqual(["takeover:a", "takeover:b", "takeover:c"]);
      yield* eventually(rows, (current) =>
        ["takeover:a", "takeover:b", "takeover:c"].every(
          (id) => current.find((row) => row.id === id)?.state === "idle",
        ),
      );
      // The one M3 said another machine started stays read-only.
      expect((yield* rows).find((row) => row.id === "takeover:e")).toMatchObject({
        state: "stopped",
        readOnly: true,
      });
      expect(world.wakes).toHaveLength(2);
    }).pipe(withAdoption(layer));
  });

  it.live("stops a worker on the old coordinator once its wake is refused as transferred", () => {
    let release = false;
    const { world, layer } = setup({
      studio_thread_wait: () => (release ? finished("b-run-1") : stillRunning("b-run-1")),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      // Meanwhile another machine took over and this copy gave way.
      world.local.current = project({
        workspaceSettings: {
          ...project().workspaceSettings!,
          coordinatorBinding: { epoch: 4, state: "transferred", operationId: "auto:x:5" },
        },
      });
      release = true;
      const [row] = yield* eventually(rows, (current) => current[0]?.state === "stopped");
      expect(row?.lastError).toBe(
        "Another machine took over as coordinator. It follows this worker now.",
      );
      expect(row?.lastStatus).toBe("completed");
      expect(world.wakes).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
