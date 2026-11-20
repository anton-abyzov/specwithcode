import { describe, expect, it } from "vite-plus/test";

import {
  SAVED_BY_UNKNOWN,
  SAVED_SIGNED_OUT,
  accountOwnersChanged,
  beginPendingSave,
  cancelPendingSave,
  finishPendingSave,
  ownerForNewSave,
  saveTakesMachine,
  settlePendingSaves,
  planAccountOwners,
  type AccountOwners,
} from "./accountOwners.ts";

// Synthetic accounts and machines only.
const A = "user_fixture_a";
const B = "user_fixture_b";

describe("planAccountOwners (1434)", () => {
  it("tags machines saved while signed in with that account, and keeps them", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: {} },
      account: A,
      savedMachines: ["m4"],
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A } });
  });

  it("a switch drops the previous account's machines and unknown ones, keeps signed-out and own", () => {
    const stored: AccountOwners = {
      lastAccount: A,
      machines: { m4: A, m5: SAVED_BY_UNKNOWN, lan: SAVED_SIGNED_OUT, mine: B },
    };
    const plan = planAccountOwners({
      stored,
      account: B,
      savedMachines: ["m4", "m5", "lan", "mine"],
    });
    expect(plan.drop).toEqual(["m4", "m5"]);
    // Recorded as they were until the removals finish.
    expect(plan.next).toEqual({ lastAccount: A, machines: stored.machines });
    const after = planAccountOwners({
      stored: plan.next,
      account: B,
      savedMachines: ["lan", "mine"],
    });
    expect(after.next).toEqual({ lastAccount: B, machines: { lan: SAVED_SIGNED_OUT, mine: B } });
  });

  it("a sign-out keeps every saved machine and remembers the account that left", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: null,
      savedMachines: ["m4", "new"],
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A, new: SAVED_SIGNED_OUT } });
  });

  it("signing out and then in as another account is still a switch", () => {
    const signedOut = planAccountOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: null,
      savedMachines: ["m4"],
    });
    const signedIn = planAccountOwners({
      stored: signedOut.next,
      account: B,
      savedMachines: ["m4"],
    });
    expect(signedIn.drop).toEqual(["m4"]);
  });

  it("signing back in as the same account drops nothing", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: { m4: A, lan: SAVED_SIGNED_OUT } },
      account: A,
      savedMachines: ["m4", "lan"],
    });
    expect(plan.drop).toEqual([]);
  });

  it("first record: machines already saved are unknown and stay until a switch", () => {
    const plan = planAccountOwners({ stored: null, account: A, savedMachines: ["m4"] });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: SAVED_BY_UNKNOWN } });
    expect(
      planAccountOwners({ stored: plan.next, account: B, savedMachines: ["m4"] }).drop,
    ).toEqual(["m4"]);
  });

  it("without a recorded switch, a machine another account saved still leaves", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: null, machines: { m4: A } },
      account: B,
      savedMachines: ["m4"],
    });
    expect(plan.drop).toEqual(["m4"]);
  });

  it("forgets owners of machines no longer saved", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: { gone: A, m4: A } },
      account: A,
      savedMachines: ["m4"],
    });
    expect(plan.next.machines).toEqual({ m4: A });
  });

  it("a removal that failed is not planned again, and the previous account stays recorded", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: { m4: A } },
      account: B,
      savedMachines: ["m4", "bmac"],
      pending: new Set(["m4"]),
    });
    expect(plan.drop).toEqual([]);
    expect(plan.next).toEqual({ lastAccount: A, machines: { m4: A, bmac: B } });
  });

  it("A to B with a removal owed, then back to A: B's machine leaves, A's stays", () => {
    const plan = planAccountOwners({
      stored: { lastAccount: A, machines: { m4: A, bmac: B } },
      account: A,
      savedMachines: ["m4", "bmac"],
    });
    expect(plan.drop).toEqual(["bmac"]);
    expect(plan.next.lastAccount).toBe(A);
  });
});

describe("ownerForNewSave and accountOwnersChanged", () => {
  it("records nothing before the account settles, and the marker when signed out", () => {
    expect(ownerForNewSave(undefined)).toBeUndefined();
    expect(ownerForNewSave(null)).toBe(SAVED_SIGNED_OUT);
    expect(ownerForNewSave(A)).toBe(A);
  });

  it("sees a changed owner, account or machine set", () => {
    const stored: AccountOwners = { lastAccount: A, machines: { m4: A } };
    expect(accountOwnersChanged(null, stored)).toBe(true);
    expect(accountOwnersChanged(stored, { lastAccount: A, machines: { m4: A } })).toBe(false);
    expect(accountOwnersChanged(stored, { lastAccount: B, machines: { m4: A } })).toBe(true);
    expect(accountOwnersChanged(stored, { lastAccount: A, machines: { m4: B } })).toBe(true);
    expect(accountOwnersChanged(stored, { lastAccount: A, machines: {} })).toBe(true);
  });
});

describe("pending saves (1434)", () => {
  const stored: AccountOwners = { lastAccount: A, machines: { m4: SAVED_SIGNED_OUT } };

  it("finishing records the owner; cancelling keeps the one it had", () => {
    const begun = beginPendingSave(stored, "m4", { owner: A, fingerprint: "f" });
    expect(finishPendingSave(begun, "m4")).toEqual({ lastAccount: A, machines: { m4: A } });
    expect(cancelPendingSave(begun, "m4")).toEqual(stored);
  });

  it("settles a save cut short by whether the catalog holds exactly what it wrote", () => {
    const begun = beginPendingSave(
      beginPendingSave(stored, "m4", { owner: A, fingerprint: "written" }),
      "new",
      { owner: A, fingerprint: "n" },
    );
    expect(
      settlePendingSaves(
        begun,
        new Map([
          ["m4", "written"],
          ["new", "n"],
        ]),
      ),
    ).toEqual({ lastAccount: A, machines: { m4: A, new: A } });
    // Neither landed: nobody's machine changes, and no owner is invented.
    expect(settlePendingSaves(begun, new Map([["m4", "before"]]))).toEqual(stored);
  });

  it("a save takes a machine only when it would leave with another account", () => {
    const stored = (owner: string, lastAccount: string | null = A): AccountOwners => ({
      lastAccount,
      machines: { m4: owner },
    });
    expect(saveTakesMachine(stored(A), "m4", B)).toBe(true);
    // An unknown machine across an account change goes; kept by the same account it stays.
    expect(saveTakesMachine(stored(SAVED_BY_UNKNOWN, A), "m4", B)).toBe(true);
    expect(saveTakesMachine(stored(SAVED_BY_UNKNOWN, B), "m4", B)).toBe(false);
    expect(saveTakesMachine(stored(SAVED_SIGNED_OUT), "m4", B)).toBe(false);
    expect(saveTakesMachine(stored(B, B), "m4", B)).toBe(false);
    expect(saveTakesMachine(stored(A), "other", B)).toBe(false);
    expect(saveTakesMachine(stored(A), "m4", null)).toBe(false);
    expect(saveTakesMachine(null, "m4", B)).toBe(false);
  });
});
