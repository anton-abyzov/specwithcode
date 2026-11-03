import type { EnvironmentId, LinkedServerSyncPair, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { drivenPairs, serverCoverage, type SyncedCopy } from "./serverLinkedSync";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const copy = (name: string): SyncedCopy => ({
  environmentId: `env-${name}` as EnvironmentId,
  projectId: `project-${name}` as ProjectId,
});
const [a, b, c] = [copy("a"), copy("b"), copy("c")];
const synced = (peer: SyncedCopy, patch: Partial<LinkedServerSyncPair> = {}) =>
  ({
    peerEnvironmentId: peer.environmentId,
    peerProjectId: peer.projectId,
    kind: "memory",
    lastSuccessAt: new Date(now - 30_000).toISOString(),
    lastAttemptAt: new Date(now - 30_000).toISOString(),
    lastError: null,
    ...patch,
  }) as LinkedServerSyncPair;

describe("drivenPairs", () => {
  it("names the copy on the lower environment ID as each pair's driver", () => {
    expect(drivenPairs([[c, a, b]], "plan")).toEqual([
      { kind: "plan", driver: a, peer: c },
      { kind: "plan", driver: b, peer: c },
      { kind: "plan", driver: a, peer: b },
    ]);
  });
});

describe("serverCoverage", () => {
  it("leaves a pair to the servers only when both can and the driver reports a recent pass", async () => {
    const fetchStatus = vi.fn(async (driver: SyncedCopy) =>
      driver === a ? [synced(b), synced(c, { lastError: "needs_grant" })] : [],
    );
    const covered = await serverCoverage(drivenPairs([[a, b, c]], "memory"), {
      capable: () => true,
      fetchStatus,
      now,
    });
    expect(covered("memory", a, b)).toBe(true);
    expect(covered("memory", b, a)).toBe(true);
    // No grant there: the app keeps driving it.
    expect(covered("memory", a, c)).toBe(false);
    expect(covered("memory", b, c)).toBe(false);
    expect(covered("plan", a, b)).toBe(false);
    // One status read per driving copy.
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps driving pairs with an older machine without asking for status", async () => {
    const fetchStatus = vi.fn(async () => [synced(b)]);
    const covered = await serverCoverage(drivenPairs([[a, b]], "memory"), {
      capable: (environmentId) => environmentId === a.environmentId,
      fetchStatus,
      now,
    });
    expect(covered("memory", a, b)).toBe(false);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("keeps driving when the status is old or cannot be read", async () => {
    const stale = await serverCoverage(drivenPairs([[a, b]], "memory"), {
      capable: () => true,
      fetchStatus: async () => [
        synced(b, { lastSuccessAt: new Date(now - 4 * 60_000).toISOString() }),
      ],
      now,
    });
    expect(stale("memory", a, b)).toBe(false);
    const unreadable = await serverCoverage(drivenPairs([[a, b]], "memory"), {
      capable: () => true,
      fetchStatus: async () => {
        throw new Error("offline");
      },
      now,
    });
    expect(unreadable("memory", a, b)).toBe(false);
  });

  it("asks the successor about giving way, whichever ID is lower", async () => {
    const covered = await serverCoverage([{ kind: "supersede", driver: b, peer: a }], {
      capable: () => true,
      fetchStatus: async (driver) => (driver === b ? [synced(a, { kind: "supersede" })] : []),
      now,
    });
    expect(covered("supersede", b, a)).toBe(true);
  });
});
