import { describe, expect, it } from "vite-plus/test";

import { joinNames, signedOutBanner, type SignedOutBannerMachine } from "./signedOutBannerModel";

const machine = (
  name: string,
  facts: Partial<Omit<SignedOutBannerMachine, "name">> = {},
): SignedOutBannerMachine => ({
  name,
  needsSignIn: false,
  connected: false,
  isThisMachine: false,
  ...facts,
});

const FLEET = [
  machine("m4", { connected: true, isThisMachine: true }),
  machine("M5", { needsSignIn: true }),
  machine("m1", { connected: true }),
  machine("m3", { connected: true }),
  machine("linux-mini", { connected: true }),
];

describe("signedOutBanner", () => {
  it("names the machines a sign-out cuts off and those still working", () => {
    expect(signedOutBanner({ signedOut: true, machines: FLEET })).toEqual({
      title: "Signed out of SpecWithCode Connect",
      body: "M5 can't be opened from this window until you sign in. This machine and m1, m3 and linux-mini are not affected.",
      cutOff: ["M5"],
    });
  });

  it("shows nothing while signed in, or while no machine needs the sign-in", () => {
    expect(signedOutBanner({ signedOut: false, machines: FLEET })).toBeNull();
    expect(
      signedOutBanner({
        signedOut: true,
        machines: FLEET.map((entry) => ({ ...entry, needsSignIn: false })),
      }),
    ).toBeNull();
  });

  it("never lists this machine as cut off", () => {
    expect(
      signedOutBanner({
        signedOut: true,
        machines: [machine("m4", { needsSignIn: true, isThisMachine: true })],
      }),
    ).toBeNull();
  });

  it("says only this machine is unaffected when no other machine is connected", () => {
    expect(
      signedOutBanner({
        signedOut: true,
        machines: [machine("M5", { needsSignIn: true }), machine("m3", { needsSignIn: true })],
      })?.body,
    ).toBe(
      "M5 and m3 can't be opened from this window until you sign in. This machine is not affected.",
    );
  });
});

describe("joinNames", () => {
  it("joins names the way a sentence does", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["M5"])).toBe("M5");
    expect(joinNames(["M5", "m3"])).toBe("M5 and m3");
    expect(joinNames(["M5", "m3", "m1"])).toBe("M5, m3 and m1");
  });
});
