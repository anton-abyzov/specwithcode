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

  it("offers the Connect route to a discovered machine this window has no route for", () => {
    const m3 = { environmentId: "env-m3", label: "M3", onConnect: true, hasConnectRoute: false };
    const copy = connectReachCopy([m3, anna], true, new Set(["env-m3"]));
    expect(copy).toMatchObject({
      title: "M3 is on SpecWithCode Connect",
      signIn: false,
      addRoutes: [m3],
    });
    expect(copy?.description).toContain("Tailscale stays as a fallback");
    // An unlinked machine still gets its guidance alongside.
    expect(copy?.description).toContain("Anna isn't on SpecWithCode Connect yet");
  });

  it("stays quiet about a machine that already has its Connect route", () => {
    const m3 = { environmentId: "env-m3", label: "M3", onConnect: true, hasConnectRoute: true };
    expect(connectReachCopy([m3], true, new Set(["env-m3"]))).toBeNull();
  });

  it("never tells an old record of a machine that joined again to link", () => {
    const old = { environmentId: "env-m5-old", label: "m5", onConnect: false, replacedBy: "m5" };
    const copy = connectReachCopy([old], true, new Set(["env-m5-new"]));
    expect(copy?.title).toBe("An old record of m5 can't connect");
    expect(copy?.description).toContain("m5 joined SpecWithCode again as a new machine");
    expect(copy?.description).not.toContain("connect link");
    expect(copy?.signIn).toBe(false);
    // Signed out, it is not offered a sign-in either.
    expect(connectReachCopy([old], false, new Set())?.signIn).toBe(false);
  });

  it("keeps the real advice for other machines next to an old record", () => {
    const old = { environmentId: "env-m5-old", label: "m5", onConnect: false, replacedBy: "m5" };
    expect(connectReachCopy([old, anna], true, new Set())?.title).toBe(
      "Anna isn't on SpecWithCode Connect",
    );
  });
});
