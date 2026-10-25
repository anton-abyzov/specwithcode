import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";

import { remoteWorkerCardStatus, visibleRemoteWorkers } from "./remoteWorkerCards";

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

  it("shows a worker held on a question over there as waiting on you", () => {
    const held = { ...worker, lastStatus: "waiting_on_you" };
    expect(remoteWorkerCardStatus(held)).toEqual({
      tone: "waiting",
      label: "Last observed: waiting on you on M1",
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
