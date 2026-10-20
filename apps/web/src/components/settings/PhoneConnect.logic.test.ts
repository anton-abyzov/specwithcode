import { describe, expect, it } from "vite-plus/test";

import {
  resolvePhoneConnectStep,
  shouldAutoTurnOn,
  shouldClearPending,
  type PhoneConnectInput,
} from "./PhoneConnect.logic";

const ready: PhoneConnectInput = {
  configured: true,
  isDesktop: true,
  authLoaded: true,
  signedIn: true,
  canManageRelay: true,
  linkStateKnown: true,
  managedTunnelActive: true,
};

describe("resolvePhoneConnectStep", () => {
  it("hides without hosted Connect or outside the desktop app", () => {
    expect(resolvePhoneConnectStep({ ...ready, configured: false })).toBe("hidden");
    expect(resolvePhoneConnectStep({ ...ready, isDesktop: false })).toBe("hidden");
  });

  it("asks to sign in before anything else", () => {
    expect(resolvePhoneConnectStep({ ...ready, authLoaded: false })).toBe("loading");
    expect(
      resolvePhoneConnectStep({
        ...ready,
        signedIn: false,
        canManageRelay: false,
        linkStateKnown: false,
      }),
    ).toBe("sign-in");
  });

  it("explains a window without relay permission", () => {
    expect(resolvePhoneConnectStep({ ...ready, canManageRelay: false })).toBe("no-permission");
  });

  it("offers to turn on until the tunnel is active", () => {
    expect(resolvePhoneConnectStep({ ...ready, linkStateKnown: false })).toBe("loading");
    expect(resolvePhoneConnectStep({ ...ready, managedTunnelActive: false })).toBe("turn-on");
    expect(resolvePhoneConnectStep(ready)).toBe("ready");
  });
});

describe("pending sign-in", () => {
  it("turns on by itself only after a sign-in started from the card", () => {
    expect(shouldAutoTurnOn("turn-on", true)).toBe(true);
    expect(shouldAutoTurnOn("turn-on", false)).toBe(false);
    expect(shouldAutoTurnOn("sign-in", true)).toBe(false);
  });

  it("keeps the flag while sign-in or loading is in progress", () => {
    expect(shouldClearPending("sign-in")).toBe(false);
    expect(shouldClearPending("loading")).toBe(false);
    expect(shouldClearPending("ready")).toBe(true);
    expect(shouldClearPending("no-permission")).toBe(true);
  });
});
