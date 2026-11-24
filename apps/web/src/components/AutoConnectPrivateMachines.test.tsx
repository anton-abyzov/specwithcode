// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AutoConnectPrivateMachines } from "./AutoConnectPrivateMachines";

// Synthetic machines and accounts only: nothing reaches a real server or Connect.
const B = "user_fixture_b";
const REMOTE = "environment-fixture-remote";

const state = vi.hoisted(() => {
  const connects: Array<Record<string, unknown>> = [];
  let releasePairing: (() => void) | null = null;
  const skipped = new Set<string>();
  return {
    snapshot: { observedAt: "fixture" },
    connects,
    skipped,
    release: () => releasePairing?.(),
    pair: () =>
      new Promise<{ host: string; pairingCode: string; environmentId: string }>((resolve) => {
        releasePairing = () =>
          resolve({ host: "https://remote.example.test", pairingCode: "code", environmentId: REMOTE });
      }),
    connect: (input: Record<string, unknown>) => {
      connects.push(input);
      return Promise.resolve({ _tag: "Success", value: REMOTE });
    },
  };
});

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { autoConnectPrivateMachines: boolean }) => unknown) =>
    select({ autoConnectPrivateMachines: true }),
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "environment-fixture-local",
  useEnvironments: () => ({ isReady: true, environments: [] }),
}));
vi.mock("../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { accountScopeValueAtom: {} } }));
vi.mock("../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => B } }));
vi.mock("../studio/machineChecking", () => ({ markFleetAutoConnectSettled: () => undefined }));
vi.mock("../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: state.snapshot, loading: false, refresh: () => undefined }),
  pairStudioFleet: () => state.pair(),
}));
vi.mock("../studio/fleetAutoConnect", () => ({
  fleetAttemptsAwaitingRetry: () => [],
  fleetMachinesAwaitingReach: () => [],
  fleetMachinesToAutoConnect: () => [{ id: "machine-fixture", environmentId: REMOTE }],
  readSkippedFleetEnvironments: () => new Set(state.skipped),
  rejectedSavedEnvironments: () => new Set<string>(),
  savedRouteOrigins: () => new Map<string, string>(),
}));

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  state.connects.length = 0;
  state.skipped.clear();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("AutoConnectPrivateMachines (1434, AC-05)", () => {
  it("saves a fleet pairing as automatic, so the registry checks the skip under the lease", async () => {
    await act(async () => {
      renderer = create(<AutoConnectPrivateMachines />);
    });
    // The pairing is out; it passed the skip check before any cleanup ran.
    expect(state.connects).toEqual([]);
    await act(async () => state.release());

    expect(state.connects).toHaveLength(1);
    expect(state.connects[0]).toMatchObject({
      expectedEnvironmentId: REMOTE,
      forAccount: B,
      automatic: true,
    });
  });

  it("drops the answer of a machine skipped while the pairing was out", async () => {
    await act(async () => {
      renderer = create(<AutoConnectPrivateMachines />);
    });
    state.skipped.add(REMOTE);
    await act(async () => state.release());
    expect(state.connects).toEqual([]);
  });
});
