// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readConnectMachineOwners, writeConnectMachineOwners } from "./connectMachineOwners";
import { ConnectMachineOwnersSync } from "./ConnectMachineOwnersSync";

// Synthetic accounts and machines only: nothing reaches Connect or a real machine.
const A = "user_fixture_a";
const B = "user_fixture_b";

type Settled = { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly tag: string };

const state = vi.hoisted(() => ({
  catalog: {
    isReady: true,
    entries: new Map<string, { target: { _tag: string; connectionId?: string } }>(),
  },
  discovery: new Map<string, unknown>(),
  removals: [] as Array<string>,
  skipped: new Set<string>(),
  answer: (_id: string): Promise<Settled> => Promise.resolve({ _tag: "Success" }),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (result: { tag: string }) => ({ _tag: result.tag }),
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: {}, forget: {} },
}));
vi.mock("../state/environments", () => ({
  useRelayEnvironmentDiscovery: () => ({ environments: state.discovery }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (id: string) => {
    state.removals.push(id);
    const result = await state.answer(id);
    if (result._tag === "Success") state.catalog.entries.delete(id);
    return result;
  },
}));
vi.mock("../studio/fleetAutoConnect", () => ({
  setFleetEnvironmentSkipped: (id: string, skipped: boolean) => {
    if (skipped) state.skipped.add(id);
    else state.skipped.delete(id);
  },
}));
vi.mock("../studio/knownMachines", () => ({ noteMachineRemoved: () => {} }));
vi.mock("../connection/desktopLocal", () => ({
  isDesktopLocalConnectionTarget: (target: { _tag: string; connectionId?: string }) =>
    target._tag === "BearerConnectionTarget" && (target.connectionId ?? "").startsWith("local:"),
}));

function saved(...ids: Array<string>) {
  state.catalog = {
    isReady: true,
    entries: new Map([
      ["primary", { target: { _tag: "PrimaryConnectionTarget" } }],
      ...ids.map((id) => [id, { target: { _tag: "BearerConnectionTarget" } }] as const),
    ]),
  };
}

let renderer: ReactTestRenderer | null = null;
async function show(account: string | null | undefined) {
  await act(async () => {
    const element = <ConnectMachineOwnersSync account={account} />;
    if (renderer === null) renderer = create(element);
    else renderer.update(element);
  });
}
async function restart(account: string | null | undefined) {
  await act(async () => renderer?.unmount());
  renderer = null;
  await show(account);
}

beforeEach(() => {
  window.localStorage.clear();
  state.removals = [];
  state.skipped = new Set();
  state.discovery = new Map();
  state.answer = () => Promise.resolve({ _tag: "Success" });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("ConnectMachineOwnersSync (1434)", () => {
  it("switching accounts removes the previous account's machines and keeps the rest", async () => {
    saved("m4", "lan", "m5");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A, lan: "", m5: "?" } });

    await show(B);

    expect(state.removals.sort()).toEqual(["m4", "m5"]);
    expect([...state.skipped].sort()).toEqual(["m4", "m5"]);
    expect([...state.catalog.entries.keys()]).toEqual(["primary", "lan"]);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: B, machines: { lan: "" } });
  });

  it("never touches the window's own machine, and does nothing before Connect settles", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });

    await show(undefined);
    expect(state.removals).toEqual([]);

    await show(B);
    expect(state.removals).toEqual(["m4"]);
    expect(state.catalog.entries.has("primary")).toBe(true);
  });

  it("never plans a desktop-local backend (WSL) for removal", async () => {
    saved("m4");
    state.catalog.entries.set("wsl", {
      target: { _tag: "BearerConnectionTarget", connectionId: "local:wsl" },
    });
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A, wsl: A } });

    await show(B);

    expect(state.removals).toEqual(["m4"]);
    expect(state.skipped.has("wsl")).toBe(false);
  });

  it("a late removal answer is not run twice, and a machine saved meanwhile is B's", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });
    let release: (value: Settled) => void = () => {};
    state.answer = () => new Promise((resolve) => (release = resolve));

    await show(B);
    // While the removal is still out, the list changes: B saves a machine.
    state.catalog.entries.set("new", { target: { _tag: "BearerConnectionTarget" } });
    state.catalog = { ...state.catalog, entries: new Map(state.catalog.entries) };
    await show(B);
    expect(state.removals).toEqual(["m4"]);

    await act(async () => release({ _tag: "Success" }));
    await show(B);

    expect(state.removals).toEqual(["m4"]);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: B, machines: { new: B } });
  });

  it("a removal that fails is finished after a restart", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });
    state.answer = () => Promise.resolve({ _tag: "Failure", tag: "ConnectionTransientError" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await show(B);
    expect(readConnectMachineOwners()?.lastAccount).toBe(A);

    state.answer = () => Promise.resolve({ _tag: "Success" });
    await restart(B);

    expect(state.removals).toEqual(["m4", "m4"]);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: B, machines: {} });
    warn.mockRestore();
  });

  it("A to B with a failing removal, then back to A: B's new machine leaves, A's stays", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });
    state.answer = () => Promise.resolve({ _tag: "Failure", tag: "ConnectionTransientError" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await show(B);
    // B saves a machine while A's removal is still owed.
    state.catalog.entries.set("bmac", { target: { _tag: "BearerConnectionTarget" } });
    state.catalog = { ...state.catalog, entries: new Map(state.catalog.entries) };
    await show(B);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: A, machines: { m4: A, bmac: B } });

    state.answer = () => Promise.resolve({ _tag: "Success" });
    await show(A);

    expect(state.removals).toEqual(["m4", "bmac"]);
    expect([...state.catalog.entries.keys()]).toEqual(["primary", "m4"]);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: A, machines: { m4: A } });
    warn.mockRestore();
  });

  it("a run for B stops when the account changes again", async () => {
    saved("m4", "m5");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A, m5: A } });
    let release: (value: Settled) => void = () => {};
    state.answer = () => new Promise((resolve) => (release = resolve));

    await show(B);
    await show(A);
    await act(async () => release({ _tag: "Success" }));
    await show(A);

    // m4 was already being removed; m5 is never touched once A is back.
    expect(state.removals).toEqual(["m4"]);
    expect(state.catalog.entries.has("m5")).toBe(true);
  });

  it("a switch before the saved list loads is still a switch", async () => {
    state.catalog = { isReady: false, entries: new Map() };
    await show(A);
    expect(readConnectMachineOwners()).toEqual({
      lastAccount: A,
      inventoried: false,
      machines: {},
    });
    await show(B);

    saved("legacy");
    await show(B);

    expect(state.removals).toEqual(["legacy"]);
    expect(readConnectMachineOwners()).toEqual({ lastAccount: B, machines: {} });
  });

  it("a machine already gone counts as removed", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });
    state.answer = () => Promise.resolve({ _tag: "Failure", tag: "EnvironmentNotRegisteredError" });

    await show(B);

    expect(readConnectMachineOwners()?.lastAccount).toBe(B);
  });

  it("a sign-out keeps machines; signing in as another account afterwards removes them", async () => {
    saved("m4");
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } });

    await show(null);
    expect(state.removals).toEqual([]);

    await show(B);
    expect(state.removals).toEqual(["m4"]);
  });
});
