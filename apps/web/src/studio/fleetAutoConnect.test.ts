import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import {
  FLEET_RETRY_MS,
  fleetAttemptsAwaitingRetry,
  fleetMachinesAwaitingReach,
  fleetMachinesToAutoConnect,
  readSkippedFleetEnvironments,
  setFleetEnvironmentSkipped,
} from "./fleetAutoConnect";

const m4 = EnvironmentId.make("env-m4"),
  m1 = EnvironmentId.make("env-m1"),
  m3 = EnvironmentId.make("env-m3");
const machine = (id: string, environmentId: EnvironmentId, port: number) => ({
  id,
  label: id.toUpperCase(),
  environmentId,
  url: `https://fixture.tailnet.ts.net:${port}`,
  status: "reachable" as const,
  pairingConfigured: true,
});
const snapshot: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-10-10T04:00:00Z",
  listener: "loopback",
  machines: [
    { ...machine("m4", m4, 443), pairingConfigured: false },
    machine("m1", m1, 8443),
    machine("m3", m3, 8444),
  ],
};
const none = new Set<string>();
const ids = (machines: ReadonlyArray<{ readonly id: string }>) => machines.map((m) => m.id);
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("automatic private machine connection", () => {
  it("connects every reachable worker a cleared browser has lost after a restart", () => {
    expect(
      ids(
        fleetMachinesToAutoConnect({
          snapshot,
          currentEnvironmentId: m4,
          savedEnvironmentIds: none,
          skippedEnvironmentIds: none,
          attemptedEnvironmentIds: none,
        }),
      ),
    ).toEqual(["m1", "m3"]);
  });

  it("leaves saved, removed, already tried, offline and unconfigured machines alone", () => {
    const pick = (overrides: Partial<Parameters<typeof fleetMachinesToAutoConnect>[0]>) =>
      ids(
        fleetMachinesToAutoConnect({
          snapshot,
          currentEnvironmentId: m4,
          savedEnvironmentIds: none,
          skippedEnvironmentIds: none,
          attemptedEnvironmentIds: none,
          ...overrides,
        }),
      );
    expect(pick({ savedEnvironmentIds: new Set([m1]) })).toEqual(["m3"]);
    expect(pick({ skippedEnvironmentIds: new Set([m3]) })).toEqual(["m1"]);
    expect(pick({ attemptedEnvironmentIds: new Set([m1, m3]) })).toEqual([]);
    for (const status of ["unreachable", "identity-mismatch"] as const) {
      expect(
        pick({
          snapshot: {
            ...snapshot,
            machines: snapshot.machines.map((m) => ({ ...m, status })),
          },
        }),
      ).toEqual([]);
    }
    expect(
      pick({
        snapshot: {
          ...snapshot,
          machines: snapshot.machines.map((m) => ({ ...m, pairingConfigured: false })),
        },
      }),
    ).toEqual([]);
    expect(pick({ snapshot: null })).toEqual([]);
  });

  it("tries a machine again a minute after a failed pairing instead of waiting for a reload", () => {
    const attempts = new Map([
      [m1, 1_000],
      [m3, 1_000 + FLEET_RETRY_MS / 2],
    ]);
    expect([...fleetAttemptsAwaitingRetry(attempts, 1_000 + FLEET_RETRY_MS - 1)]).toEqual([m1, m3]);
    const waiting = fleetAttemptsAwaitingRetry(attempts, 1_000 + FLEET_RETRY_MS);
    expect([...waiting]).toEqual([m3]);
    expect(
      ids(
        fleetMachinesToAutoConnect({
          snapshot,
          currentEnvironmentId: m4,
          savedEnvironmentIds: none,
          skippedEnvironmentIds: none,
          attemptedEnvironmentIds: waiting,
        }),
      ),
    ).toEqual(["m1"]);
  });

  it("keeps checking only for an unsaved worker that is still booting", () => {
    const offline = {
      ...snapshot,
      machines: snapshot.machines.map((m) =>
        m.id === "m3" ? { ...m, status: "unreachable" as const } : m,
      ),
    };
    const awaiting = (saved: ReadonlySet<string>, skipped: ReadonlySet<string>) =>
      ids(
        fleetMachinesAwaitingReach({
          snapshot: offline,
          currentEnvironmentId: m4,
          savedEnvironmentIds: saved,
          skippedEnvironmentIds: skipped,
        }),
      );
    expect(awaiting(none, none)).toEqual(["m3"]);
    expect(awaiting(new Set([m3]), none)).toEqual([]);
    expect(awaiting(none, new Set([m3]))).toEqual([]);
  });

  it("remembers a removed machine until it is connected by hand", () => {
    const storage = memoryStorage();
    setFleetEnvironmentSkipped(m1, true, storage);
    setFleetEnvironmentSkipped(m3, true, storage);
    expect([...readSkippedFleetEnvironments(storage)]).toEqual([m1, m3]);
    setFleetEnvironmentSkipped(m1, false, storage);
    expect([...readSkippedFleetEnvironments(storage)]).toEqual([m3]);
  });

  it("treats unreadable or blocked storage as nothing skipped", () => {
    const corrupt = memoryStorage();
    corrupt.setItem("studio:fleet-auto-connect:skipped", "{not json");
    expect(readSkippedFleetEnvironments(corrupt).size).toBe(0);
    expect(readSkippedFleetEnvironments(null).size).toBe(0);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => setFleetEnvironmentSkipped(m1, true, blocked)).not.toThrow();
  });
});
