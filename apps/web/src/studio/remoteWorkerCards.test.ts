import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";

import {
  placeRemoteWorkers,
  remoteWorkerCardStatus,
  remoteWorkerNeedsPlace,
  remoteWorkerReachableHere,
  visibleRemoteWorkers,
} from "./remoteWorkerCards";

const worker: StudioFleetRemoteWorker = {
  id: "rwt:1",
  machineId: "m1",
  machineLabel: "M1",
  environmentId: EnvironmentId.make("env-m1"),
  callerThreadId: ThreadId.make("coordinator"),
  remoteThreadId: ThreadId.make("b-thread"),
  threadRef: "studio://thread/env-m1/b-thread",
  title: "Fix CI",
  state: "following",
  lastStatus: "running",
  reachable: true,
  updatedAt: "2026-10-12T00:00:00.000Z",
};

describe("remote worker cards", () => {
  it("says where a worker stands with the machine named when it matters", () => {
    expect(remoteWorkerCardStatus({ ...worker, state: "launching", remoteThreadId: null })).toEqual(
      { tone: "working", label: "Starting on M1" },
    );
    expect(remoteWorkerCardStatus(worker)).toEqual({ tone: "working", label: "Working" });
    expect(remoteWorkerCardStatus({ ...worker, reachable: false }).label).toContain(
      "M1 unreachable",
    );
    expect(remoteWorkerCardStatus({ ...worker, state: "idle", lastStatus: "completed" })).toEqual({
      tone: "done",
      label: "Done",
    });
    expect(remoteWorkerCardStatus({ ...worker, state: "idle", lastStatus: "failed" }).tone).toBe(
      "failed",
    );
    expect(remoteWorkerCardStatus({ ...worker, state: "paused_auth" }).label).toContain(
      "Allow workers on M1",
    );
  });

  it("shows a worker held on a question over there as needing you", () => {
    const held = { ...worker, lastStatus: "waiting_on_you" };
    expect(remoteWorkerCardStatus(held)).toEqual({
      tone: "waiting",
      label: "Last observed: needs you on M1",
    });
    // Out of touch, its last word is stale: it says the machine is unreachable instead.
    expect(remoteWorkerCardStatus({ ...held, reachable: false }).label).toContain("unreachable");
  });

  it("drops closed rows and keeps the server order", () => {
    const later = { ...worker, id: "rwt:2", updatedAt: "2026-10-11T00:00:00.000Z" };
    expect(
      visibleRemoteWorkers([worker, { ...worker, id: "rwt:3", state: "disposed" }, later]).map(
        (row) => row.id,
      ),
    ).toEqual(["rwt:1", "rwt:2"]);
  });
});

it("deduplicates only equivalent loaded aliases, retaining caller-side auth actions", () => {
  const loaded = [{ environmentId: worker.environmentId, id: worker.remoteThreadId! }];
  expect(visibleRemoteWorkers([worker], loaded)).toEqual([]);
  expect(visibleRemoteWorkers([{ ...worker, state: "paused_auth" }], loaded)).toHaveLength(1);
  expect(
    visibleRemoteWorkers([worker], [{ environmentId: "another-host", id: worker.remoteThreadId! }]),
  ).toHaveLength(1);
});

it("follows the Threads pane machine filter", () => {
  const onM4 = { ...worker, id: "rwt:m4", environmentId: EnvironmentId.make("env-m4") };
  expect(visibleRemoteWorkers([worker, onM4], [], null).map((row) => row.id)).toEqual([
    "rwt:1",
    "rwt:m4",
  ]);
  expect(visibleRemoteWorkers([worker, onM4], [], "env-m4").map((row) => row.id)).toEqual([
    "rwt:m4",
  ]);
  // Filtered to this machine, no worker elsewhere shows.
  expect(visibleRemoteWorkers([worker, onM4], [], "env-linux-box")).toEqual([]);
});

it("opens a finished worker's archived thread while its machine is connected", () => {
  // The live list leaves out archived threads; another thread from that machine proves the link.
  const m1Threads = [{ environmentId: "env-m1" }];
  expect(remoteWorkerReachableHere(worker, m1Threads)).toBe(true);
  expect(remoteWorkerReachableHere(worker, [{ environmentId: "env-other" }])).toBe(false);
  expect(remoteWorkerReachableHere(worker, [])).toBe(false);
  expect(remoteWorkerReachableHere({ ...worker, remoteThreadId: null }, m1Threads)).toBe(false);
});

it("keeps only live or waiting workers above the Threads pane groups", () => {
  const done = { ...worker, id: "rwt:done", state: "idle" as const, lastStatus: "completed" };
  const failed = { ...done, id: "rwt:failed", lastStatus: "failed" };
  const finished = { ...done, id: "rwt:wake", state: "wake_pending" as const };
  const stopped = { ...worker, id: "rwt:stopped", state: "stopped" as const };
  const asking = { ...worker, id: "rwt:ask", lastStatus: "waiting_on_you" };
  const lost = { ...worker, id: "rwt:lost", reachable: false };
  const auth = { ...worker, id: "rwt:auth", state: "paused_auth" as const };
  const unconfirmed = { ...worker, id: "rwt:start", state: "launch_unknown" as const };
  const launching = { ...worker, id: "rwt:launch", state: "launching" as const };
  for (const row of [done, failed, finished, stopped])
    expect(remoteWorkerNeedsPlace(row), row.id).toBe(false);
  for (const row of [worker, asking, lost, auth, unconfirmed, launching])
    expect(remoteWorkerNeedsPlace(row), row.id).toBe(true);
  // The screenshot: five Done m4 workers and nothing else leave no card at all.
  expect(visibleRemoteWorkers([done, failed, finished, stopped])).toEqual([]);
  expect(visibleRemoteWorkers([done, asking, worker]).map((row) => row.id)).toEqual([
    "rwt:ask",
    "rwt:1",
  ]);
});

describe("remote worker card placement", () => {
  const messages = [
    { id: "u1", role: "user", createdAt: "2026-10-30T00:30:00.000Z" },
    { id: "a1", role: "assistant", createdAt: "2026-10-30T00:38:00.000Z" },
    { id: "a1b", role: "assistant", createdAt: "2026-10-30T00:41:00.000Z" },
    { id: "u2", role: "user", createdAt: "2026-10-31T02:38:00.000Z" },
    { id: "a2", role: "assistant", createdAt: "2026-10-31T02:40:00.000Z" },
  ];
  const done = { ...worker, state: "idle" as const, lastStatus: "completed" };

  it("places a finished worker under its launch turn's last reply, not at the end", () => {
    const placed = placeRemoteWorkers(
      [{ ...done, launchedAt: "2026-10-30T00:39:00.000Z", updatedAt: "2026-10-31T02:41:00.000Z" }],
      messages,
      "coordinator",
    );
    expect([...placed.byMessage.keys()]).toEqual(["a1b"]);
    expect(placed.live).toEqual([]);
  });

  it("keeps launch order among workers of one turn", () => {
    const placed = placeRemoteWorkers(
      [
        { ...done, id: "second", launchedAt: "2026-10-30T00:40:00.000Z" },
        { ...done, id: "first", launchedAt: "2026-10-30T00:39:00.000Z" },
      ],
      messages,
      "coordinator",
    );
    expect(placed.byMessage.get("a1b")?.map((w) => w.id)).toEqual(["first", "second"]);
  });

  it("shows a worker of a turn with no reply yet in the live strip", () => {
    const placed = placeRemoteWorkers(
      [{ ...worker, launchedAt: "2026-10-31T02:39:00.000Z" }],
      messages.slice(0, 4),
      "coordinator",
    );
    expect(placed.byMessage.size).toBe(0);
    expect(placed.live.map((w) => w.id)).toEqual(["rwt:1"]);
  });

  it("never places a worker another thread started", () => {
    const placed = placeRemoteWorkers(
      [{ ...worker, launchedAt: "2026-10-30T00:39:00.000Z" }],
      messages,
      "another-coordinator",
    );
    expect(placed.byMessage.size).toBe(0);
    expect(placed.live.map((w) => w.id)).toEqual(["rwt:1"]);
  });

  it("shows only active workers that have no loaded turn or start time", () => {
    const placed = placeRemoteWorkers(
      [
        { ...worker, id: "active-old", launchedAt: "2026-10-29T00:00:00.000Z" },
        { ...done, id: "done-old", launchedAt: "2026-10-29T00:00:00.000Z" },
        { ...done, id: "done-old-server" },
        { ...worker, id: "active-old-server" },
      ],
      messages,
      "coordinator",
    );
    expect(placed.byMessage.size).toBe(0);
    expect(placed.live.map((w) => w.id).toSorted()).toEqual(["active-old", "active-old-server"]);
  });
});
