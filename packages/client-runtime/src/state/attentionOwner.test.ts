import { describe, expect, it } from "vite-plus/test";

import { attentionOwnerMachine, raisesAttention, remoteWorkerLaunchers } from "./attentionOwner.ts";

describe("attentionOwnerMachine", () => {
  it("gives a local thread to the machine that serves it", () => {
    expect(attentionOwnerMachine({ environmentId: "desk", id: "t1" })).toBe("desk");
  });

  it("keeps a handed-off thread with the machine it lives on", () => {
    expect(
      attentionOwnerMachine({ environmentId: "always-on", id: "t1", ownerMachineId: "desk" }),
    ).toBe("desk");
  });

  it("gives a remote worker to the machine of the coordinator that launched it", () => {
    const launchers = remoteWorkerLaunchers([
      {
        environmentId: "desk",
        remoteWorkers: [
          { environmentId: "worker", remoteThreadId: "w1" },
          { environmentId: "worker", remoteThreadId: null },
        ],
      },
    ]);
    expect(attentionOwnerMachine({ environmentId: "worker", id: "w1" }, launchers)).toBe("desk");
    expect(attentionOwnerMachine({ environmentId: "worker", id: "w2" }, launchers)).toBe("worker");
    // The coordinator outranks the thread's own owner record.
    expect(
      attentionOwnerMachine(
        { environmentId: "worker", id: "w1", ownerMachineId: "worker" },
        launchers,
      ),
    ).toBe("desk");
  });
});

describe("raisesAttention", () => {
  const base = { ownEnvironmentId: "laptop", ownerMachineId: "desk", ownerReachable: true };

  it("raises on the owner machine's app whoever the target is", () => {
    expect(raisesAttention({ ...base, ownEnvironmentId: "desk", isTarget: false })).toBe(true);
  });

  it("raises on the target app", () => {
    expect(raisesAttention({ ...base, isTarget: true })).toBe(true);
  });

  it("leaves it to the others on an app that is neither", () => {
    expect(raisesAttention({ ...base, isTarget: false })).toBe(false);
  });

  it("raises on doubt: no target, an older server or a failed read", () => {
    expect(raisesAttention({ ...base, isTarget: null })).toBe(true);
  });

  it("raises when the owner machine cannot be reached from here", () => {
    expect(raisesAttention({ ...base, isTarget: false, ownerReachable: false })).toBe(true);
  });
});
