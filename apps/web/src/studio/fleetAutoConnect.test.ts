import { describe, expect, it } from "vite-plus/test";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import {
  FLEET_RETRY_MS,
  fleetAttemptsAwaitingRetry,
  fleetMachinesAwaitingReach,
  fleetMachineSaved,
  fleetMachinesToAutoConnect,
  readSkippedFleetEnvironments,
  rejectedSavedEnvironments,
  savedRouteOrigins,
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

  it("waits for the tailnet before pairing a machine that has only a SpecWithCode Connect address", () => {
    const connectOnly: StudioFleetSnapshot = {
      ...snapshot,
      machines: snapshot.machines.map((entry) =>
        entry.id === "m1"
          ? { ...entry, url: "https://prod-0123456789abcdef.spec-weave.com" }
          : entry,
      ),
    };
    const input = {
      snapshot: connectOnly,
      currentEnvironmentId: m4,
      savedEnvironmentIds: none,
      skippedEnvironmentIds: none,
    };
    expect(ids(fleetMachinesToAutoConnect({ ...input, attemptedEnvironmentIds: none }))).toEqual([
      "m3",
    ]);
    expect(ids(fleetMachinesAwaitingReach(input))).toEqual(["m1"]);
  });

  it("pairs a machine the server last reached over Connect when it also has a tailnet address", () => {
    // The server prefers Connect, so `transport: "connect"` is the normal
    // case for a dual-address machine; its ts.net address still pairs here.
    const viaConnect: StudioFleetSnapshot = {
      ...snapshot,
      machines: snapshot.machines.map((entry) =>
        entry.id === "m1" ? { ...entry, transport: "connect" as const } : entry,
      ),
    };
    const input = {
      snapshot: viaConnect,
      currentEnvironmentId: m4,
      savedEnvironmentIds: none,
      skippedEnvironmentIds: none,
    };
    expect(ids(fleetMachinesToAutoConnect({ ...input, attemptedEnvironmentIds: none }))).toEqual([
      "m1",
      "m3",
    ]);
    expect(ids(fleetMachinesAwaitingReach(input))).toEqual([]);
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

  it("adds a machine's new address when its server lists it somewhere this browser never paired", () => {
    const moved: StudioFleetSnapshot = {
      ...snapshot,
      machines: [
        { ...machine("m1", m1, 443), url: "https://m1.tailnet.ts.net" },
        machine("m3", m3, 8444),
      ],
    };
    const saved = new Set<string>([m1, m3]);
    const origins = new Map<string, ReadonlySet<string>>([
      [m1, new Set(["https://fixture.tailnet.ts.net:8443"])],
      [m3, new Set(["https://fixture.tailnet.ts.net:8444"])],
    ]);
    expect(
      ids(
        fleetMachinesToAutoConnect({
          snapshot: moved,
          currentEnvironmentId: m4,
          savedEnvironmentIds: saved,
          savedRouteOrigins: origins,
          skippedEnvironmentIds: none,
          attemptedEnvironmentIds: none,
        }),
      ),
    ).toEqual(["m1"]);
    // Once the new address is saved too, nothing is left to do; without route
    // information a saved machine counts as reached, as before.
    expect(
      fleetMachineSaved(
        moved.machines[0]!,
        saved,
        new Map([
          [m1, new Set(["https://fixture.tailnet.ts.net:8443", "https://m1.tailnet.ts.net"])],
        ]),
      ),
    ).toBe(true);
    expect(fleetMachineSaved(moved.machines[0]!, saved)).toBe(true);
  });

  it("pairs a saved machine again when its server turned down this browser's credential", () => {
    const entry = (environmentId: EnvironmentId, httpBaseUrl: string) => ({
      target: new BearerConnectionTarget({
        environmentId,
        label: environmentId,
        connectionId: environmentId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: environmentId,
          environmentId,
          label: environmentId,
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        }),
      ),
      enabled: true,
    });
    const rejected = rejectedSavedEnvironments([
      { environmentId: m1, connection: { phase: "error", reapprovalRequired: true } },
      // Failing for another reason, such as a revoked session: left to the user.
      { environmentId: m3, connection: { phase: "error" } },
      { environmentId: m4, connection: { phase: "connected" } },
    ]);
    expect([...rejected]).toEqual([m1]);
    const origins = savedRouteOrigins(
      [
        entry(m1, "https://fixture.tailnet.ts.net:8443"),
        entry(m3, "https://fixture.tailnet.ts.net:8444"),
      ],
      rejected,
    );
    expect(
      ids(
        fleetMachinesToAutoConnect({
          snapshot,
          currentEnvironmentId: m4,
          savedEnvironmentIds: new Set<string>([m1, m3]),
          savedRouteOrigins: origins,
          skippedEnvironmentIds: none,
          attemptedEnvironmentIds: none,
        }),
      ),
    ).toEqual(["m1"]);
    // Without a rejection both stay saved at their addresses.
    expect([
      ...(savedRouteOrigins([entry(m1, "https://fixture.tailnet.ts.net:8443")]).get(m1) ?? []),
    ]).toEqual(["https://fixture.tailnet.ts.net:8443"]);
  });
});
