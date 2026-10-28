import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectReachCopy } from "../components/settings/ConnectReachBanner";
import type {
  ConnectionCatalogEntry,
  EnvironmentConnectionPhase,
} from "@specweave-studio/client-runtime/connection";
import {
  type ConnectRoutePlanMachine,
  beginConnectRouteRemoval,
  connectFirstRouteOrder,
  endConnectRouteRemoval,
  isConnectRouteRemoving,
  machinesMissingConnectRoute,
  readDeclinedConnectRoutes,
  setConnectRouteDeclined,
  unreachableMachines,
} from "./connectRoutePlan";

const bearer = (url: string) => ({
  _tag: "BearerConnectionTarget" as const,
  environmentId: "env",
  connectionId: url,
  label: "M",
});
const relay = { _tag: "RelayConnectionTarget" as const, environmentId: "env", label: "M" };

interface TestMachine extends ConnectRoutePlanMachine {
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
}

function machine(
  environmentId: string,
  targets: ReadonlyArray<{ _tag: string }>,
  phase: EnvironmentConnectionPhase = "error",
  enabled = true,
): TestMachine {
  const [target, ...rest] = targets;
  return {
    environmentId,
    label: environmentId,
    connection: { phase },
    entry: {
      enabled,
      target,
      profile: Option.none(),
      alternateRoutes: rest.map((alternate) => ({ target: alternate, profile: Option.none() })),
    } as unknown as ConnectionCatalogEntry,
  };
}

describe("machinesMissingConnectRoute", () => {
  it("picks discovered machines without a Connect route, once", () => {
    const m1 = machine("m1", [bearer("https://m1.ts.net")]);
    const m3 = machine("m3", [bearer("https://m3.ts.net"), relay]);
    const anna = machine("anna", [bearer("https://anna.ts.net")]);
    const primary = machine("m4", [{ _tag: "PrimaryConnectionTarget" }]);
    const discovered = new Set(["m1", "m3", "m4"]);
    const ids = (list: ReadonlyArray<{ environmentId: string }>) =>
      list.map((entry) => entry.environmentId);
    expect(
      ids(machinesMissingConnectRoute([m1, m3, anna, primary], discovered, new Set())),
    ).toEqual(["m1"]);
    expect(machinesMissingConnectRoute([m1], discovered, new Set(["m1"]))).toEqual([]);
  });
});

describe("connectFirstRouteOrder", () => {
  it("moves Connect ahead of Tailscale and keeps the rest in order", () => {
    const entry = machine("m1", [bearer("https://a.ts.net"), bearer("https://b.ts.net"), relay]);
    const order = connectFirstRouteOrder(entry.entry);
    expect(order[0]).toBe("relay");
    expect(order).toHaveLength(3);
  });
});

describe("unreachableMachines", () => {
  it("lists switched-on machines that are failing", () => {
    const list = [
      machine("a", [relay], "error"),
      machine("b", [relay], "connected"),
      machine("c", [relay], "error", false),
      machine("d", [relay], "reconnecting"),
    ];
    expect(unreachableMachines(list).map((entry) => entry.environmentId)).toEqual(["a", "d"]);
  });
});

describe("connectReachCopy", () => {
  const machines = [
    { environmentId: "m1", label: "M1", onConnect: true },
    { environmentId: "m3", label: "M3", onConnect: true },
    { environmentId: "anna", label: "Anna's Macbook Air", onConnect: false },
  ];

  it("asks for the Connect sign-in when signed out", () => {
    const copy = connectReachCopy(machines, false, new Set());
    expect(copy?.signIn).toBe(true);
    expect(copy?.title).toBe("Can't reach 3 machines");
    expect(copy?.description).toContain("M1, M3 and Anna's Macbook Air");
  });

  it("names only machines not linked to Connect once signed in", () => {
    const copy = connectReachCopy(machines, true, new Set(["m1", "m3"]));
    expect(copy?.signIn).toBe(false);
    expect(copy?.title).toBe("Anna's Macbook Air isn't on SpecWithCode Connect");
  });

  it("shows nothing when every machine is reachable or on Connect", () => {
    expect(connectReachCopy([], false, new Set())).toBeNull();
    expect(connectReachCopy(machines.slice(0, 2), true, new Set())).toBeNull();
  });
});

describe("declined Connect routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps only machines the user removed Connect from, until it is added back", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    setConnectRouteDeclined("m1", true);
    expect([...readDeclinedConnectRoutes()]).toEqual(["m1"]);
    const m1 = machine("m1", [bearer("https://m1.ts.net")]);
    const m3 = machine("m3", [bearer("https://m3.ts.net")]);
    const missing = machinesMissingConnectRoute(
      [m1, m3],
      new Set(["m1", "m3"]),
      readDeclinedConnectRoutes(),
    );
    expect(missing.map((entry) => entry.environmentId)).toEqual(["m3"]);
    setConnectRouteDeclined("m1", false);
    expect(readDeclinedConnectRoutes().size).toBe(0);
  });

  it("keeps a removal for the session when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    setConnectRouteDeclined("m4", true);
    expect(readDeclinedConnectRoutes().has("m4")).toBe(true);
    setConnectRouteDeclined("m4", false);
    expect(readDeclinedConnectRoutes().has("m4")).toBe(false);
  });

  it("records a removal before it runs and lifts it when the removal fails", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    beginConnectRouteRemoval("m5");
    expect(isConnectRouteRemoving("m5")).toBe(true);
    expect(readDeclinedConnectRoutes().has("m5")).toBe(true);
    endConnectRouteRemoval("m5", false);
    expect(isConnectRouteRemoving("m5")).toBe(false);
    expect(readDeclinedConnectRoutes().has("m5")).toBe(false);
    beginConnectRouteRemoval("m5");
    endConnectRouteRemoval("m5", true);
    expect(readDeclinedConnectRoutes().has("m5")).toBe(true);
  });
});
