import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CoordinatorRoutineCopy } from "./scheduledTask.ts";
import { StudioWorkGrant } from "./studioFleet.ts";

const decodeGrant = Schema.decodeUnknownSync(StudioWorkGrant);
const decodeCopy = Schema.decodeUnknownSync(CoordinatorRoutineCopy);

const grant = {
  coordinatorEnvironmentId: "env-m4",
  machineLabel: "M4MAX",
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  runtimeCap: null,
  expiresAt: null,
  status: "active",
  revokedAt: null,
  interruptAt: null,
  runningThreads: 0,
  legacy: false,
};

describe("work grant routines on the wire", () => {
  it("reads a grant from a server older than routines as routines off", () => {
    expect(decodeGrant(grant).routines).toBe(false);
  });

  it("keeps the routines a newer server sends", () => {
    expect(decodeGrant({ ...grant, routines: true }).routines).toBe(true);
  });

  it("carries a routine copy's grant, and reads a copy without one", () => {
    const copy = {
      id: "routine",
      title: "Check",
      prompt: "Check",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "auto",
      interactionMode: "default",
      createdBy: "agent",
    };
    expect(decodeCopy(copy).grantedBy).toBeUndefined();
    const grantedBy = {
      coordinatorEnvironmentId: "env-m4",
      runtimeCap: "auto",
      accounts: { kind: "listed", instanceIds: ["codex"] },
    };
    expect(decodeCopy({ ...copy, grantedBy }).grantedBy).toEqual(grantedBy);
  });
});
