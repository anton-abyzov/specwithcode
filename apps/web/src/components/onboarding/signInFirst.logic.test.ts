import { expect, it } from "vite-plus/test";

import {
  canTurnOnFromSignInFirst,
  machinesStillToAllow,
  signInFirstLink,
  type SignInFirstLinkInput,
} from "./signInFirst.logic";

const ready: SignInFirstLinkInput = {
  account: "user_1",
  sessionKnown: true,
  canManageLink: true,
  rulesKnown: true,
  rulesLockConnect: false,
  linkState: { linked: false },
  linkStatePending: false,
  linkStateFailed: false,
  turnedOffAccounts: [],
  turnedOffUnreadable: false,
  applying: false,
  failure: null,
  triedByItself: false,
};
const link = (change: Partial<SignInFirstLinkInput>) => signInFirstLink({ ...ready, ...change });

it("waits for a sign-in before anything else", () => {
  expect(link({ account: null })).toEqual({ link: { kind: "waiting" }, turnOnNow: false });
});

it("links a signed-in machine that was never linked, by itself", () => {
  expect(link({})).toEqual({ link: { kind: "linking" }, turnOnNow: true });
});

it("does not start a second request while one runs", () => {
  expect(link({ applying: true })).toEqual({ link: { kind: "linking" }, turnOnNow: false });
});

it("shows a linked machine as linked", () => {
  expect(link({ linkState: { linked: true } }).link.kind).toBe("linked");
  expect(link({ linkState: { linked: true, managedTunnelActive: true } }).link.kind).toBe("linked");
});

it("offers the button when the link only publishes activity", () => {
  const result = link({ linkState: { linked: true, managedTunnelActive: false } });
  expect(result).toEqual({ link: { kind: "off" }, turnOnNow: false });
});

it("keeps checking until permissions, Team rules and the link are read", () => {
  for (const change of [
    { sessionKnown: false },
    { rulesKnown: false },
    { linkState: null },
    { linkStatePending: true },
  ] satisfies Array<Partial<SignInFirstLinkInput>>) {
    expect(link(change), JSON.stringify(change)).toEqual({
      link: { kind: "checking" },
      turnOnNow: false,
    });
  }
});

it("never turns Connect on against the owner's choice or Team rules", () => {
  expect(link({ turnedOffAccounts: ["user_1"] })).toEqual({
    link: { kind: "off" },
    turnOnNow: false,
  });
  expect(link({ turnedOffUnreadable: true })).toEqual({ link: { kind: "off" }, turnOnNow: false });
  expect(link({ rulesLockConnect: true })).toEqual({ link: { kind: "locked" }, turnOnNow: false });
  expect(link({ canManageLink: false })).toEqual({
    link: { kind: "no-permission" },
    turnOnNow: false,
  });
});

it("shows a failed request once and does not repeat it by itself", () => {
  expect(link({ failure: { message: "No route" } })).toEqual({
    link: { kind: "failed", message: "No route" },
    turnOnNow: false,
  });
  expect(link({ linkStateFailed: true })).toEqual({
    link: { kind: "failed", message: null },
    turnOnNow: false,
  });
});

it("shows the link once a retry worked, whatever failed before", () => {
  expect(link({ failure: { message: "No route" }, linkState: { linked: true } }).link.kind).toBe(
    "linked",
  );
});

it("asks for the link once, then leaves it to the owner", () => {
  // The request went through and the machine still reads as not linked.
  expect(link({ triedByItself: true })).toEqual({ link: { kind: "off" }, turnOnNow: false });
  expect(link({ triedByItself: true, linkStatePending: true }).link.kind).toBe("checking");
});

it("offers Turn on only where the owner can act", () => {
  expect(canTurnOnFromSignInFirst({ kind: "off" })).toBe(true);
  expect(canTurnOnFromSignInFirst({ kind: "failed", message: null })).toBe(true);
  for (const kind of [
    "waiting",
    "checking",
    "linking",
    "linked",
    "locked",
    "no-permission",
  ] as const)
    expect(canTurnOnFromSignInFirst({ kind }), kind).toBe(false);
});

it("counts the other machines that may not start work here yet", () => {
  expect(machinesStillToAllow({ here: "a", known: ["a", "b", "b", "c"], allowed: ["c"] })).toBe(1);
  expect(machinesStillToAllow({ here: "a", known: ["a"], allowed: [] })).toBe(0);
  expect(machinesStillToAllow({ here: "a", known: ["a", "b"], allowed: ["b"] })).toBe(0);
});
