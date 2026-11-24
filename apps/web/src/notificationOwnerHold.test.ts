import { describe, expect, it, vi } from "vite-plus/test";

const reads = vi.hoisted(() => ({ calls: [] as string[], next: undefined as unknown }));
vi.mock("./notificationTarget", () => ({
  readNotificationTarget: (environmentId: string) => {
    reads.calls.push(environmentId);
    return Promise.resolve(reads.next);
  },
}));

import { ownerHoldsAlert, readOwnerHold } from "./notificationOwnerHold";
import type { NotificationTargetRead } from "./notificationTarget";

const known = (ownerInUse?: boolean): NotificationTargetRead => ({
  status: "known",
  target: null,
  ownerAppConnected: true,
  ...(ownerInUse === undefined ? {} : { ownerInUse }),
});
const base = { ownEnvironmentId: "env-m4", ownerMachineId: "env-m5", ownerReachable: true };

describe("ownerHoldsAlert (1436 AC-11, AC-12)", () => {
  it("holds another machine's alert only while its owner says a person is there", () => {
    expect(ownerHoldsAlert({ ...base, ownerRead: known(true) })).toEqual({
      hold: true,
      why: "owner-in-use",
      ownerInUse: true,
    });
    expect(ownerHoldsAlert({ ...base, ownerRead: known(false) })).toEqual({
      hold: false,
      why: "owner-idle",
      ownerInUse: false,
    });
  });

  it("never holds this machine's own alert", () => {
    expect(
      ownerHoldsAlert({ ...base, ownEnvironmentId: "env-m5", ownerRead: known(true) }).hold,
    ).toBe(false);
  });

  it.each([
    [
      "the owner is unreachable",
      { ownerReachable: false, ownerRead: known(true) },
      "owner-unreachable",
    ],
    [
      "the read failed or timed out",
      { ownerRead: { status: "unknown", ownerAppConnected: false } },
      "read-failed",
    ],
    ["the server is older", { ownerRead: known() }, "no-field"],
    [
      "this app does not know its machine",
      { ownEnvironmentId: null, ownerRead: known(true) },
      "own-machine-unknown",
    ],
  ] as const)("shows the alert when %s", (_name, overrides, why) => {
    expect(
      ownerHoldsAlert({ ...base, ...overrides } as Parameters<typeof ownerHoldsAlert>[0]),
    ).toEqual({
      hold: false,
      why,
      ownerInUse: null,
    });
  });
});

describe("readOwnerHold", () => {
  it("reads the owner machine's server, and nothing for an own or unreachable owner", async () => {
    reads.calls = [];
    reads.next = known(true);
    expect((await readOwnerHold(base)).hold).toBe(true);
    expect(reads.calls).toEqual(["env-m5"]);
    await readOwnerHold({ ...base, ownEnvironmentId: "env-m5" });
    await readOwnerHold({ ...base, ownerReachable: false });
    expect(reads.calls).toEqual(["env-m5"]);
  });
});
