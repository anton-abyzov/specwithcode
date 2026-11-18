import { describe, expect, it } from "vite-plus/test";

import {
  joinNames,
  sessionEndingBanner,
  signedOutBanner,
  type SignedOutBannerMachine,
} from "./signedOutBannerModel";

const machine = (
  name: string,
  facts: Partial<Omit<SignedOutBannerMachine, "name">> = {},
): SignedOutBannerMachine => ({
  name,
  needsSignIn: false,
  reachableFromMachine: false,
  connected: false,
  isThisMachine: false,
  ...facts,
});

const FLEET = [
  machine("m4", { connected: true, isThisMachine: true }),
  machine("M5", { needsSignIn: true, reachableFromMachine: true }),
  machine("m1", { connected: true, reachableFromMachine: true }),
  machine("m3", { connected: true }),
  machine("linux-mini", { connected: true }),
];

describe("signedOutBanner", () => {
  it("says a machine this machine's server reaches is running, and what is still connected", () => {
    expect(signedOutBanner({ signedOut: true, machines: FLEET })).toEqual({
      title: "Signed out of SpecWithCode Connect",
      body: "M5 is running, but this window can't reach it until you sign in. This machine is not affected. Still connected: m1, m3 and linux-mini.",
      cutOff: ["M5"],
    });
  });

  it("never says running for a machine nothing here has reached", () => {
    expect(
      signedOutBanner({
        signedOut: true,
        machines: [machine("M5", { needsSignIn: true }), machine("m3", { needsSignIn: true })],
      })?.body,
    ).toBe(
      "M5 and m3 can't be reached from this window until you sign in. This machine is not affected.",
    );
  });

  it("names several running machines in one sentence", () => {
    expect(
      signedOutBanner({
        signedOut: true,
        machines: [
          machine("M5", { needsSignIn: true, reachableFromMachine: true }),
          machine("m3", { needsSignIn: true, reachableFromMachine: true }),
          machine("m2", { needsSignIn: true }),
        ],
      })?.body,
    ).toBe(
      "M5 and m3 are running, but this window can't reach them until you sign in. m2 can't be reached from this window until you sign in. This machine is not affected.",
    );
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

  it("joins names in the window's language when given a joiner", () => {
    const list = new Intl.ListFormat("de", { style: "long", type: "conjunction" });
    expect(
      signedOutBanner(
        {
          signedOut: true,
          machines: [machine("M5", { needsSignIn: true }), machine("m3", { needsSignIn: true })],
        },
        undefined,
        (names) => list.format(names),
      )?.body,
    ).toContain("M5 und m3");
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

describe("sessionEndingBanner (1417, AC-11)", () => {
  it("says when the sign-in ends and which machines it keeps reaching", () => {
    expect(sessionEndingBanner({ endsAt: "2:43 PM", machines: ["Office Mac", "Mac mini"] })).toEqual({
      title: "Your Connect sign-in ends at 2:43 PM",
      body: "Sign in again to keep reaching Office Mac and Mac mini from this window.",
    });
  });

  it("shows nothing when no saved machine depends on the sign-in", () => {
    expect(sessionEndingBanner({ endsAt: "2:43 PM", machines: [] })).toBeNull();
  });
});
