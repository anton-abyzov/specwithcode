import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  requests: [] as string[],
}));

// The real fleet atoms with a deterministic reader; only transport and the runtime are replaced.
// Reading an atom runs its gate; the request mocks record which requests it started.
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  type Evaluated = { evaluate: (get: (key: unknown) => unknown) => unknown };
  const fleet = { machines: [{ id: "minis", workers: { status: "off" } }] };
  const read = (atom: Evaluated) => {
    atom.evaluate(get);
    return AsyncResult.success(fleet);
  };
  function get(key: unknown): unknown {
    if (typeof key === "object" && key !== null && "evaluate" in key) return read(key as Evaluated);
    if (typeof key === "object" && key !== null && "read" in key)
      return (key as { read: (get: unknown) => unknown }).read(get);
    // A reactive read of the whole presentation restarts the request on every rebuild.
    if (key === "presentation") throw new Error("read the connected atom instead");
    return state.values[key as string];
  }
  return { useAtomValue: read };
});
vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: {
    atom: (evaluate: unknown) => ({
      evaluate,
      pipe() {
        return this;
      },
    }),
  },
}));
vi.mock("./connected", () => ({ environmentConnectedAtom: () => "connected" }));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => "presentation" },
}));
vi.mock("../state/session", () => ({
  environmentSession: {
    sessionStateAtom: () => "session",
    preparedConnectionValueAtom: () => "prepared",
  },
  readEnvironmentScope: () => false,
  readPreparedConnection: () => null,
}));
vi.mock("../state/entities", () => ({ useServerConfigs: () => [] }));
vi.mock("../environments/primary", () => ({ revokeServerClientSession: vi.fn() }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null, refresh: vi.fn() } }));
vi.mock("./fleetRequest", async () => {
  const Effect = await import("effect/Effect");
  const request = (name: string) => () => {
    state.requests.push(name);
    return Effect.never;
  };
  return {
    requestFleet: request("fleet"),
    requestWorkGrants: request("work-grants"),
    requestRemoteWorkers: request("remote-workers"),
  };
});

import { useMachineWorkGrants, useProjectRemoteWorkers, useStudioFleet } from "./fleet";
const environmentId = EnvironmentId.make("env-m4");
beforeEach(() => {
  state.requests = [];
  state.values = {
    connected: true,
    session: AsyncResult.success({
      authenticated: true,
      permissions: ["orchestration:read", "access:read"],
    }),
    prepared: Option.some({ environmentId, httpBaseUrl: "https://private.example.test" }),
  };
});

describe("fleet request atoms", () => {
  it("gate on the connected atom, not the whole presentation", () => {
    useStudioFleet(environmentId);
    useMachineWorkGrants(environmentId);
    useProjectRemoteWorkers(environmentId, ProjectId.make("project-1"));
    expect(state.requests).toEqual(["fleet", "work-grants", "fleet", "remote-workers", "fleet"]);
  });
  it("do not request while the connection is not connected", () => {
    state.values.connected = false;
    useStudioFleet(environmentId);
    useMachineWorkGrants(environmentId);
    useProjectRemoteWorkers(environmentId, ProjectId.make("project-1"));
    expect(state.requests).toEqual([]);
  });
});
