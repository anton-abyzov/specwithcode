import { describe, expect, it } from "vite-plus/test";

import { environmentHoldsBootstrap } from "./shellBootstrap";

const state = (phase: string, attempt = 1, desired = true) =>
  ({ phase, attempt, desired }) as Parameters<typeof environmentHoldsBootstrap>[0];

describe("environmentHoldsBootstrap", () => {
  it("never holds once the machine has reported", () => {
    expect(environmentHoldsBootstrap(state("connecting"), true)).toBe(false);
    expect(environmentHoldsBootstrap(state("backoff"), true)).toBe(false);
  });

  it("holds while the machine is connected and its chats are on the way", () => {
    expect(environmentHoldsBootstrap(state("connected"), false)).toBe(true);
  });

  it("holds through the first two tries, connecting or between them", () => {
    expect(environmentHoldsBootstrap(state("connecting", 1), false)).toBe(true);
    expect(environmentHoldsBootstrap(state("backoff", 1), false)).toBe(true);
    expect(environmentHoldsBootstrap(state("connecting", 2), false)).toBe(true);
    expect(environmentHoldsBootstrap(state("backoff", 2), false)).toBe(true);
  });

  it("lets go of a machine that keeps retrying, in either phase", () => {
    // The stuck Overview: the third and later tries used to hold while connecting.
    expect(environmentHoldsBootstrap(state("connecting", 3), false)).toBe(false);
    expect(environmentHoldsBootstrap(state("backoff", 3), false)).toBe(false);
    expect(environmentHoldsBootstrap(state("connecting", 40), false)).toBe(false);
  });

  it("does not hold for a machine that is not trying", () => {
    expect(environmentHoldsBootstrap(state("available", 0, false), false)).toBe(false);
    expect(environmentHoldsBootstrap(state("offline"), false)).toBe(false);
    expect(environmentHoldsBootstrap(state("blocked"), false)).toBe(false);
    expect(environmentHoldsBootstrap(state("backoff", 1, false), false)).toBe(false);
  });
});
