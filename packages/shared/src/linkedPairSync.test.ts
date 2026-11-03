import type {
  EnvironmentId,
  LinkedServerSyncPair,
  ProjectCoordinatorBinding,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  drivesPair,
  isReplicaTarget,
  LINKED_PAIR_BACKOFF_MAX_MS,
  type PairSide,
  pairBackoffMs,
  pendingSupersede,
  replicaStep,
  SERVER_SYNC_FRESH_MS,
  serverSyncCovers,
} from "./linkedPairSync.ts";

const env = (name: string) => `env-${name}` as EnvironmentId;
const project = (name: string) => `project-${name}` as ProjectId;
const ref = (name: string) => ({
  environmentId: env(name),
  projectId: project(name),
  coordinatorThreadId: `coordinator:${name}` as never,
});
const side = (
  name: string,
  binding: ProjectCoordinatorBinding | undefined,
  extra: Partial<PairSide> = {},
): PairSide => ({
  environmentId: env(name),
  projectId: project(name),
  logicalProjectId: "logical:1",
  binding,
  coordinatorDigest: `digest-${name}`,
  replica: null,
  ...extra,
});
const active = (epoch: number, extra: Partial<ProjectCoordinatorBinding> = {}) =>
  ({ epoch, state: "active", ...extra }) as ProjectCoordinatorBinding;
const transferred = (epoch: number) =>
  ({ epoch, state: "transferred" }) as ProjectCoordinatorBinding;

describe("drivesPair", () => {
  it("lets exactly one side of a pair drive it: the lower environment ID", () => {
    expect(drivesPair(env("a"), env("b"))).toBe(true);
    expect(drivesPair(env("b"), env("a"))).toBe(false);
    expect(drivesPair(env("a"), env("a"))).toBe(false);
  });
});

describe("pendingSupersede", () => {
  const successor = side(
    "b",
    active(2, { predecessor: ref("a"), takenOverAt: "2026-11-01T00:00:00Z" }),
  );
  it("asks a returning coordinator at a lower epoch to give way", () => {
    expect(pendingSupersede(successor, side("a", active(1)))).toBe(true);
  });
  it("leaves a copy that already gave way, another project, or a copy it did not replace", () => {
    expect(pendingSupersede(successor, side("a", transferred(2)))).toBe(false);
    expect(pendingSupersede(successor, side("a", active(1), { logicalProjectId: "other" }))).toBe(
      false,
    );
    expect(pendingSupersede(successor, side("c", active(1)))).toBe(false);
    expect(pendingSupersede(side("b", active(2)), side("a", active(1)))).toBe(false);
  });
});

describe("replicaStep", () => {
  it("pushes from the driving coordinator and pulls into the driving member", () => {
    expect(replicaStep(side("a", active(0)), side("b", transferred(0)))).toBe("push");
    expect(replicaStep(side("a", transferred(0)), side("b", active(0)))).toBe("pull");
  });
  it("moves nothing when the member already holds this content, or between two members", () => {
    const held = { from: ref("a"), digest: "digest-a", fromEpoch: 0 };
    expect(replicaStep(side("a", active(0)), side("b", transferred(0), { replica: held }))).toBe(
      null,
    );
    expect(replicaStep(side("a", transferred(0)), side("b", transferred(0)))).toBe(null);
    expect(
      replicaStep(side("a", active(0)), side("b", transferred(0), { logicalProjectId: "other" })),
    ).toBe(null);
  });
  it("never replaces a replica of a newer coordinator with an older one's", () => {
    const newer = { from: ref("c"), digest: "digest-c", fromEpoch: 3 };
    expect(replicaStep(side("a", active(1)), side("b", transferred(1), { replica: newer }))).toBe(
      null,
    );
    const older = { from: ref("c"), digest: "digest-c", fromEpoch: 0 };
    expect(replicaStep(side("a", active(1)), side("b", transferred(1), { replica: older }))).toBe(
      "push",
    );
  });
});

describe("pairBackoffMs", () => {
  it("doubles after each failure from one pass interval, up to the cap", () => {
    expect(pairBackoffMs(0)).toBe(0);
    expect(pairBackoffMs(1)).toBe(60_000);
    expect(pairBackoffMs(2)).toBe(120_000);
    expect(pairBackoffMs(3)).toBe(240_000);
    expect(pairBackoffMs(10)).toBe(LINKED_PAIR_BACKOFF_MAX_MS);
  });
});

describe("serverSyncCovers", () => {
  const now = Date.parse("2026-11-03T12:00:00.000Z");
  const pair = (patch: Partial<LinkedServerSyncPair> = {}): LinkedServerSyncPair => ({
    peerEnvironmentId: env("b"),
    peerProjectId: project("b"),
    kind: "memory",
    lastSuccessAt: "2026-11-03T11:59:00.000Z",
    lastAttemptAt: "2026-11-03T11:59:00.000Z",
    lastError: null,
    ...patch,
  });
  const peer = { environmentId: env("b"), projectId: project("b") };
  it("covers a pair whose last pass succeeded within three minutes", () => {
    expect(serverSyncCovers([pair()], peer, "memory", now)).toBe(true);
  });
  it("does not cover a stale, failing, other-kind or other-copy pair", () => {
    // One millisecond past `SERVER_SYNC_FRESH_MS` (three minutes).
    const stale = "2026-11-03T11:56:59.999Z";
    expect(now - Date.parse(stale)).toBe(SERVER_SYNC_FRESH_MS + 1);
    expect(serverSyncCovers([pair({ lastSuccessAt: stale })], peer, "memory", now)).toBe(false);
    expect(serverSyncCovers([pair({ lastError: "needs_grant" })], peer, "memory", now)).toBe(false);
    expect(serverSyncCovers([pair({ lastSuccessAt: null })], peer, "memory", now)).toBe(false);
    expect(serverSyncCovers([pair()], peer, "plan", now)).toBe(false);
    expect(serverSyncCovers([pair()], { ...peer, projectId: project("c") }, "memory", now)).toBe(
      false,
    );
  });
});

describe("isReplicaTarget", () => {
  it("is a member of the same project on another machine that gave its coordinator away", () => {
    expect(isReplicaTarget(side("a", active(0)), side("b", transferred(0)))).toBe(true);
    expect(isReplicaTarget(side("a", active(0)), side("a", transferred(0)))).toBe(false);
    expect(isReplicaTarget(side("a", active(0)), side("b", active(0)))).toBe(false);
  });
});
