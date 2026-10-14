import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { FakeToolHandler } from "./fakeStudioMcp.testkit.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import {
  allow,
  eventually,
  launchAnswer,
  launchInput,
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
    let launched = false;
    const { world, layer } = setup(
      {
        studio_thread_launch: async () => {
          await Effect.runPromise(Effect.sleep(300));
          launched = true; // The other machine created and started the thread anyway.
          return { result: launchAnswer };
        },
        studio_thread_list: () => ({
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
        }),
      },
      // Settled once the other machine has had time to finish the launch.
      { launchStaleMs: 600 },
    );
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      // The coordinator's MCP client cancels the call (tool timeout, user Stop).
      const outcome = yield* workers
        .launch(launchInput())
        .pipe(Effect.timeout("150 millis"), Effect.result);
      expect(outcome._tag).toBe("Failure");
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
