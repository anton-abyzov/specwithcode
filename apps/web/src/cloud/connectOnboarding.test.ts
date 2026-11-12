import { describe, expect, it } from "vite-plus/test";

import {
  type ConnectAtSignInInput,
  EMPTY_CONNECT_TURNED_OFF_STATE,
  connectAtSignIn,
  withConnectChoice,
} from "./connectOnboarding";

const fresh: ConnectAtSignInInput = {
  account: "user_a",
  desktopApp: true,
  sessionKnown: true,
  canManageLink: true,
  rulesKnown: true,
  rulesLockConnect: false,
  linkState: { linked: false },
  linkStatePending: false,
  linkStateFailed: false,
  turnedOffAccounts: [],
  wizardOptOutAccounts: [],
  phoneCardPending: false,
};

describe("SpecWithCode Connect at sign-in", () => {
  it("turns Connect on for a machine that is not linked yet", () => {
    expect(connectAtSignIn(fresh)).toBe("turn-on");
  });
  it("waits until the session, Team rules and link state have been read", () => {
    expect(connectAtSignIn({ ...fresh, sessionKnown: false })).toBe("wait");
    expect(connectAtSignIn({ ...fresh, rulesKnown: false })).toBe("wait");
    expect(connectAtSignIn({ ...fresh, linkState: null })).toBe("wait");
    expect(connectAtSignIn({ ...fresh, linkStatePending: true })).toBe("wait");
  });
  it("leaves a link the owner already has as it is, tunnel on or off", () => {
    expect(connectAtSignIn({ ...fresh, linkState: { linked: true } })).toBe("skip");
  });
  it("does not turn it back on for an account whose owner turned it off here", () => {
    expect(connectAtSignIn({ ...fresh, turnedOffAccounts: ["user_a"] })).toBe("skip");
    // Another account's choice is not this account's.
    expect(connectAtSignIn({ ...fresh, turnedOffAccounts: ["user_b"] })).toBe("turn-on");
  });
  it("leaves alone an account that chose not to see the wizard again", () => {
    expect(connectAtSignIn({ ...fresh, wizardOptOutAccounts: ["user_a"] })).toBe("skip");
  });
  it("never turns it on against Team rules, or before they are read", () => {
    expect(connectAtSignIn({ ...fresh, rulesLockConnect: true })).toBe("skip");
    expect(connectAtSignIn({ ...fresh, rulesLockConnect: true, rulesKnown: false })).toBe("wait");
  });
  it("acts only from the desktop app with a session that can manage the link", () => {
    expect(connectAtSignIn({ ...fresh, desktopApp: false })).toBe("skip");
    expect(connectAtSignIn({ ...fresh, canManageLink: false })).toBe("skip");
  });
  it("leaves it to the phone card when that card is about to turn it on", () => {
    expect(connectAtSignIn({ ...fresh, phoneCardPending: true })).toBe("skip");
  });
  it("does not guess when the link state could not be read", () => {
    expect(connectAtSignIn({ ...fresh, linkState: null, linkStateFailed: true })).toBe("skip");
  });
});

describe("the owner's choice to turn Connect off", () => {
  it("remembers off per account and forgets it when turned on again", () => {
    const off = withConnectChoice(EMPTY_CONNECT_TURNED_OFF_STATE, "user_a", false);
    expect(off.accounts).toEqual(["user_a"]);
    expect(withConnectChoice(off, "user_a", false)).toBe(off);
    expect(withConnectChoice(off, "user_b", true)).toBe(off);
    expect(withConnectChoice(off, "user_a", true).accounts).toEqual([]);
    expect(withConnectChoice(EMPTY_CONNECT_TURNED_OFF_STATE, "user_a", true)).toBe(
      EMPTY_CONNECT_TURNED_OFF_STATE,
    );
  });
  it("holds a later sign-in back after a deliberate off", () => {
    const off = withConnectChoice(EMPTY_CONNECT_TURNED_OFF_STATE, "user_a", false);
    expect(connectAtSignIn({ ...fresh, turnedOffAccounts: off.accounts })).toBe("skip");
    const onAgain = withConnectChoice(off, "user_a", true);
    expect(connectAtSignIn({ ...fresh, turnedOffAccounts: onAgain.accounts })).toBe("turn-on");
  });
});
