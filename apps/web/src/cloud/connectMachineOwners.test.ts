import { describe, expect, it } from "vite-plus/test";

import {
  CONNECT_MACHINE_OWNERS_KEY,
  SAVED_BY_UNKNOWN,
  SAVED_SIGNED_OUT,
  accountNoteBeforeLoad,
  connectMachineOwnersChanged,
  planConnectMachineOwners,
  readConnectMachineOwners,
  writeConnectMachineOwners,
  type ConnectMachineOwners,
} from "./connectMachineOwners";

// Synthetic accounts and machines only.
const A = "user_fixture_a";
const B = "user_fixture_b";
const NONE: ReadonlySet<string> = new Set();

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

describe("planConnectMachineOwners", () => {
  it("tags machines saved while signed in with that account, and keeps them", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, machines: {} },
      account: A,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A } });
  });

  it("a switch drops the previous account's machines and unknown ones, keeps signed-out and own", () => {
    const stored: ConnectMachineOwners = {
      lastAccount: A,
      machines: { m4: A, m5: SAVED_BY_UNKNOWN, lan: SAVED_SIGNED_OUT, mine: B },
    };
    const plan = planConnectMachineOwners({
      stored,
      account: B,
      savedMachines: ["m4", "m5", "lan", "mine"],
      accountMachines: new Set(["m5"]),
    });
    expect(plan.drop).toEqual(["m4", "m5"]);
    // Recorded as they were until the removals finish.
    expect(plan.next).toEqual({ lastAccount: A, machines: stored.machines });
    const after = planConnectMachineOwners({
      stored: plan.next,
      account: B,
      savedMachines: ["lan", "mine"],
      accountMachines: NONE,
    });
    expect(after.next).toEqual({ lastAccount: B, machines: { lan: SAVED_SIGNED_OUT, mine: B } });
  });

  it("a sign-out keeps every saved machine and remembers the account that left", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: null,
      savedMachines: ["m4", "new"],
      accountMachines: NONE,
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A, new: SAVED_SIGNED_OUT } });
  });

  it("signing out and then in as another account is still a switch", () => {
    const signedOut = planConnectMachineOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: null,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    const signedIn = planConnectMachineOwners({
      stored: signedOut.next,
      account: B,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    expect(signedIn.drop).toEqual(["m4"]);
  });

  it("signing back in as the same account drops nothing", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, machines: { m4: A, lan: SAVED_SIGNED_OUT } },
      account: A,
      savedMachines: ["m4", "lan"],
      accountMachines: NONE,
    });
    expect(plan.drop).toEqual([]);
  });

  it("first record: existing machines are unknown, adopted only when on the account", () => {
    const plan = planConnectMachineOwners({
      stored: null,
      account: A,
      savedMachines: ["own", "other"],
      accountMachines: new Set(["own"]),
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { own: A, other: SAVED_BY_UNKNOWN } });
  });

  it("without a recorded switch, a machine another account saved still leaves", () => {
    // The owners survived but the last account did not (storage edited or partly lost).
    const plan = planConnectMachineOwners({
      stored: { lastAccount: null, machines: { m4: A } },
      account: B,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    expect(plan.drop).toEqual(["m4"]);
  });

  it("forgets owners of machines no longer saved", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, machines: { gone: A, m4: A } },
      account: A,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    expect(plan.next.machines).toEqual({ m4: A });
  });
});

describe("pending removals and the first load", () => {
  it("a pending machine keeps its owner and the previous account stays recorded", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: B,
      savedMachines: ["m4", "bmac"],
      accountMachines: NONE,
      pending: new Set(["m4"]),
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A, bmac: B } });
  });

  it("notes the account before the first load only when none is recorded", () => {
    expect(accountNoteBeforeLoad(null, A)).toEqual({
      lastAccount: A,
      inventoried: false,
      machines: {},
    });
    expect(accountNoteBeforeLoad({ lastAccount: A, machines: {} }, B)).toBeNull();
    expect(accountNoteBeforeLoad(null, null)).toBeNull();
  });

  it("an account noted before load: machines found later are unknown and leave on a switch", () => {
    const plan = planConnectMachineOwners({
      stored: { lastAccount: A, inventoried: false, machines: {} },
      account: B,
      savedMachines: ["legacy"],
      accountMachines: NONE,
    });
    expect(plan.drop).toEqual(["legacy"]);
  });
});

describe("restart", () => {
  it("a cleanup cut short by a restart runs again from storage", () => {
    const store = memoryStorage();
    writeConnectMachineOwners({ lastAccount: A, machines: { m4: A } }, store);
    // The app quit after B signed in but before the drop was stored.
    const afterRestart = planConnectMachineOwners({
      stored: readConnectMachineOwners(store),
      account: B,
      savedMachines: ["m4"],
      accountMachines: NONE,
    });
    expect(afterRestart.drop).toEqual(["m4"]);
  });

  it("unreadable storage reads as no record", () => {
    const store = memoryStorage();
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, "{not json");
    expect(readConnectMachineOwners(store)).toBeNull();
    store.setItem(CONNECT_MACHINE_OWNERS_KEY, JSON.stringify({ lastAccount: 7, machines: {} }));
    expect(readConnectMachineOwners(store)).toBeNull();
  });

  it("reports when a plan changes nothing", () => {
    const owners = { lastAccount: A, machines: { m4: A } };
    expect(connectMachineOwnersChanged(owners, { lastAccount: A, machines: { m4: A } })).toBe(
      false,
    );
    expect(connectMachineOwnersChanged(owners, { lastAccount: B, machines: { m4: A } })).toBe(true);
    expect(connectMachineOwnersChanged(null, owners)).toBe(true);
  });
});
