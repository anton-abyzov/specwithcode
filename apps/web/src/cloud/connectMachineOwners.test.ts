import { describe, expect, it } from "vite-plus/test";

import {
  CONNECT_MACHINE_OWNERS_KEY,
  readConnectMachineOwners,
  writeConnectMachineOwners,
} from "./connectMachineOwners";

// Synthetic accounts and machines only.
const A = "user_fixture_a";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("connect machine owner storage (1434)", () => {
  it("reads back what it wrote, so a restart finds the previous account", () => {
    const store = memoryStorage();
    const owners = { lastAccount: A, machines: { m4: A, lan: "", old: "?" } };
    writeConnectMachineOwners(owners, store);
    expect(readConnectMachineOwners(store)).toEqual(owners);
  });

  it("unreadable storage reads as no record", () => {
    const store = memoryStorage();
    expect(readConnectMachineOwners(store)).toBeNull();
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, "{not json");
    expect(readConnectMachineOwners(store)).toBeNull();
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, JSON.stringify({ lastAccount: 7, machines: {} }));
    expect(readConnectMachineOwners(store)).toBeNull();
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, JSON.stringify({ lastAccount: "", machines: {} }));
    expect(readConnectMachineOwners(store)).toBeNull();
  });

  it("drops owners that are not text", () => {
    const store = memoryStorage();
    store.setItem(
      CONNECT_MACHINE_OWNERS_KEY,
      JSON.stringify({ lastAccount: null, machines: { m4: A, bad: 3 } }),
    );
    expect(readConnectMachineOwners(store)).toEqual({ lastAccount: null, machines: { m4: A } });
  });

  it("keeps saves in progress, and reports a full storage", () => {
    const store = memoryStorage();
    const owners = {
      lastAccount: A,
      machines: {},
      saving: { m4: { owner: A, routeId: "relay", routeWasSaved: false } },
    };
    expect(writeConnectMachineOwners(owners, store)).toBe(true);
    expect(readConnectMachineOwners(store)).toEqual(owners);
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException("Fixture: storage is full", "QuotaExceededError");
      },
    } as Storage;
    expect(writeConnectMachineOwners(owners, full)).toBe(false);
    expect(writeConnectMachineOwners(owners, null)).toBe(false);
  });
});
