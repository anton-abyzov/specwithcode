import { describe, expect, it } from "vite-plus/test";

import { connectReachCopy } from "./ConnectReachBanner";

const m1 = { environmentId: "env-m1", label: "M1", onConnect: true };
const ministorm = { environmentId: "env-ministorm", label: "Ministorm", onConnect: true };
const anna = { environmentId: "env-anna", label: "Anna", onConnect: false };

describe("connectReachCopy", () => {
  it("tells a signed-out window that fleet work does not need its sign-in", () => {
    const copy = connectReachCopy([m1, ministorm], false, new Set());
    expect(copy).toMatchObject({
      title: "M1 and Ministorm are on SpecWithCode Connect",
      signIn: true,
    });
    expect(copy?.description).toContain("Work this machine sends there does not need this sign-in");
  });

  it("keeps the warning for a machine with no Connect address", () => {
    const copy = connectReachCopy([m1, anna], false, new Set());
    expect(copy?.title).toBe("Can't reach 2 machines");
  });

  it("names only unlinked machines once signed in", () => {
    const copy = connectReachCopy([m1, anna], true, new Set());
    expect(copy?.title).toBe("Anna isn't on SpecWithCode Connect");
    expect(copy?.signIn).toBe(false);
  });
});
