/**
 * Routines that ride a planned handover run under the sender's work grant
 * here (1267 #6): stamped with that grant, never the copy's own claim; none
 * kept without the routines capability (the answer lists them); and an
 * owner's routine already here stays the owner's, unchanged.
 */
import {
  type CoordinatorRoutineCopy,
  EnvironmentId,
  ProjectId,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import type { PlannedHandoverRequest } from "../project/CoordinatorPlannedHandover.ts";
import {
  type LocalRoutine,
  ROUTINES_NOT_ALLOWED_REASON,
  stampHandoverRoutines,
} from "./awayHandoverRoute.ts";

const M4 = EnvironmentId.make("env-m4");
const HERE = ProjectId.make("p-mini");

const grant = (patch: Partial<EffectiveWorkGrant> = {}): EffectiveWorkGrant => ({
  coordinatorEnvironmentId: M4,
  projects: { kind: "all" },
  accounts: { kind: "listed", instanceIds: ["codex"] } as never,
  owner: "self",
  hopLimit: 1,
  revoked: false,
  routines: true,
  ...patch,
});

const caller = (patch: Partial<EffectiveWorkGrant> = {}): ReceiverCaller => ({
  sourceEnvironmentId: M4,
  grant: grant(patch),
  runtimeCeiling: "approval-required",
});

const copy = (id: string, patch: Partial<CoordinatorRoutineCopy> = {}) =>
  ({
    id,
    title: id,
    prompt: "Do it.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    ...patch,
  }) as unknown as CoordinatorRoutineCopy;

const request = (routines: ReadonlyArray<CoordinatorRoutineCopy>): PlannedHandoverRequest =>
  ({
    protocolVersion: 1,
    operationId: "op",
    reason: "away",
    logicalProjectId: "lp",
    projectId: HERE,
    predecessor: { environmentId: M4 },
    epoch: 3,
    shadowWorkers: [],
    routines,
    runStates: [],
  }) as unknown as PlannedHandoverRequest;

describe("stampHandoverRoutines (#6)", () => {
  it("stamps every routine with the caller's grant here, ignoring the copy's own", () => {
    const forged = copy("r1", {
      grantedBy: { coordinatorEnvironmentId: "env-other", runtimeCap: null },
    });
    const { request: kept, notCarried } = stampHandoverRoutines(
      caller(),
      request([forged, copy("r2")]),
      new Map(),
    );
    expect(notCarried).toEqual([]);
    for (const routine of kept.routines ?? [])
      expect(routine.grantedBy).toEqual({
        coordinatorEnvironmentId: M4,
        runtimeCap: "approval-required",
        accounts: grant().accounts,
      });
  });

  it("keeps no routine without the routines capability, lists them, and hands over anyway", () => {
    const { request: kept, notCarried } = stampHandoverRoutines(
      caller({ routines: false }),
      request([copy("r1")]),
      new Map(),
    );
    expect(kept.routines).toBeUndefined();
    expect(kept.runStates).toBeUndefined();
    expect(kept.epoch).toBe(3);
    expect(notCarried).toEqual([
      { routineId: "r1", title: "r1", reason: ROUTINES_NOT_ALLOWED_REASON },
    ]);
  });

  it("a legacy grant still carries routines, stamped", () => {
    const { request: kept } = stampHandoverRoutines(
      caller({ routines: false, legacy: true }),
      request([copy("r1")]),
      new Map(),
    );
    expect(kept.routines?.[0]?.grantedBy?.coordinatorEnvironmentId).toBe(M4);
  });

  it("an owner's routine already here stays the owner's, as it is", () => {
    const own = {
      id: "r1",
      title: "Mine",
      prompt: "Owner prompt.",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId: HERE,
      threadId: null,
      ownThread: true,
      nextRunAt: "2026-11-09T23:00:00.000Z",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
    } as unknown as ScheduledTask;
    const local = new Map<string, LocalRoutine>([["r1", { task: own, grantedBy: undefined }]]);
    const { request: kept } = stampHandoverRoutines(
      caller(),
      request([copy("r1", { prompt: "Changed elsewhere." })]),
      local,
    );
    expect(kept.routines?.[0]).toMatchObject({ prompt: "Owner prompt." });
    expect(kept.routines?.[0]?.grantedBy).toBeUndefined();
  });
});
