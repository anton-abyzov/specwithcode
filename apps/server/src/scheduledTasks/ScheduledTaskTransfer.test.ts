/**
 * Away's routine transfer (1267 AC-06): staged off there, off here, then on
 * there with the state read after the pause; a refusal turns it back on here,
 * no answer leaves it off on both; the target refuses without the routines
 * grant and touches only routines the caller moved.
 */
import {
  type CoordinatorRoutineCopy,
  EnvironmentId,
  type Project,
  type ScheduledTask,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AwayPeerError, type AwayPeerPost } from "../away/awayPeerCall.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  cappedRuntimeMode,
  makeTransferIn,
  makeTransferOut,
  ROUTINE_TRANSFER_PROTOCOL_VERSION,
  type RoutineTransferRequest,
  settledRunState,
  type TransferRunState,
} from "./ScheduledTaskTransfer.ts";

const TARGET = EnvironmentId.make("env-ministorm");
const M4 = EnvironmentId.make("env-m4");
const HOUR = 3_600_000;

const TASK = {
  id: ScheduledTaskId.make("routine-1"),
  title: "Instagram",
  prompt: "Post the day's photo.",
  enabled: true,
  schedule: { type: "interval", everyMs: HOUR },
  projectId: "p-m4",
  threadId: null,
  ownThread: false,
} as unknown as ScheduledTask;

const COPY = {
  id: TASK.id,
  title: TASK.title,
  prompt: TASK.prompt,
  enabled: true,
  schedule: TASK.schedule,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
} as unknown as CoordinatorRoutineCopy;

const STATE: TransferRunState & { running: boolean } = {
  nextRunAt: "2026-11-09T23:00:00.000Z",
  lastRunAt: "2026-11-09T22:00:00.000Z",
  runCount: 7,
  onceGeneration: 0,
  running: false,
};

function out(answers: Record<string, () => Effect.Effect<unknown, AwayPeerError>>) {
  const log: Array<string> = [];
  const post: AwayPeerPost = (_target, _path, body) => {
    const request = body as RoutineTransferRequest;
    log.push(`post:${request.op}`);
    return (answers[request.op] ?? (() => Effect.succeed({})))().pipe(
      Effect.map((json) => ({ status: 200, json })),
    );
  };
  const transfer = makeTransferOut({
    post,
    readState: () => Effect.succeed(STATE),
    setEnabled: (id, enabled) =>
      Effect.sync(() => (log.push(`here:${enabled ? "on" : "off"}`), true)),
    note: (_id, note) => Effect.sync(() => void log.push(`note:${note ?? "clear"}`)),
    writeState: (_task, state) => Effect.sync(() => void log.push(`state:${state.nextRunAt}`)),
    nowMs: Effect.succeed(Date.parse("2026-11-09T22:30:00.000Z")),
  });
  return { transfer, log };
}

const moveInput = {
  task: TASK,
  target: TARGET,
  targetLabel: "Ministorm",
  copy: COPY,
  boundThreadId: null,
};

describe("routine transfer, this machine's side", () => {
  it.effect("stages there, turns off here, then turns on there", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        stage: () => Effect.succeed({ routineId: TASK.id, projectId: "p-mini", enabled: false }),
        enable: () => Effect.succeed({ routineId: TASK.id, enabled: true }),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved.kind).toBe("moved");
      expect(log).toEqual([
        "post:stage",
        "here:off",
        "note:Paused while away on Ministorm.",
        "post:enable",
      ]);
    }),
  );

  it.effect("turns it back on here when the target refuses to turn it on", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        stage: () => Effect.succeed({ routineId: TASK.id, enabled: false }),
        enable: () =>
          Effect.fail(
            new AwayPeerError({ message: "Ministorm: no", refused: true, uncertain: false }),
          ),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log.slice(-2)).toEqual(["here:on", "note:clear"]);
    }),
  );

  it.effect("leaves it off on both when the target does not answer", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        stage: () => Effect.succeed({ routineId: TASK.id, enabled: false }),
        enable: () =>
          Effect.fail(new AwayPeerError({ message: "no answer", refused: false, uncertain: true })),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: true });
      expect(log).not.toContain("here:on");
    }),
  );

  it.effect("never turns it off here when staging fails", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        stage: () =>
          Effect.fail(new AwayPeerError({ message: "no grant", refused: true, uncertain: false })),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log).toEqual(["post:stage"]);
    }),
  );

  it.effect("brings it back: released there first, then on here with its state", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        release: () => Effect.succeed({ routineId: TASK.id, enabled: false, runState: STATE }),
      });
      const back = yield* transfer.bringBack({
        task: TASK,
        target: TARGET,
        targetLabel: "Ministorm",
        wasEnabled: true,
      });
      expect(back.kind).toBe("returned");
      expect(log).toEqual(["post:release", "note:clear", "here:on", `state:${STATE.nextRunAt}`]);
    }),
  );

  it.effect("keeps it off here when the target cannot release it", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        release: () =>
          Effect.fail(new AwayPeerError({ message: "no answer", refused: false, uncertain: true })),
      });
      const back = yield* transfer.bringBack({
        task: TASK,
        target: TARGET,
        targetLabel: "Ministorm",
        wasEnabled: true,
      });
      expect(back.kind).toBe("failed");
      expect(log).toEqual(["post:release"]);
    }),
  );
});

describe("settledRunState", () => {
  const now = Date.parse("2026-11-09T22:30:00.000Z");
  it("keeps the first read when nothing ran in between", () => {
    expect(settledRunState(TASK, STATE, { ...STATE, nextRunAt: null }, now)).toEqual(STATE);
  });
  it("moves the next run on from a run that slipped in before the pause", () => {
    const after = { ...STATE, lastRunAt: "2026-11-09T22:29:00.000Z", runCount: 8 };
    expect(settledRunState(TASK, STATE, after, now)).toMatchObject({
      runCount: 8,
      nextRunAt: "2026-11-09T23:29:00.000Z",
    });
  });
});

describe("routine transfer, the target's side", () => {
  const grant = (overrides: Partial<EffectiveWorkGrant> = {}): EffectiveWorkGrant => ({
    coordinatorEnvironmentId: M4,
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    revoked: false,
    routines: true,
    ...overrides,
  });
  const caller = (overrides: Partial<EffectiveWorkGrant> = {}): ReceiverCaller => ({
    sourceEnvironmentId: M4,
    grant: grant(overrides),
    runtimeCeiling: "auto-accept-edits",
  });
  const project = {
    id: "p-mini",
    deletedAt: null,
    workspaceSettings: {
      logicalProject: { id: "lp", members: [{ environmentId: M4, projectId: "p-m4" }] },
    },
  } as unknown as Project;

  function into(held: { projectId: string; grantedBy: ScheduledTaskGrantedBy | undefined } | null) {
    const log: Array<string> = [];
    let saved: { input: ScheduledTaskUpsertInput; grantedBy: ScheduledTaskGrantedBy } | null = null;
    const transfer = makeTransferIn({
      projects: Effect.succeed([project]),
      findTask: () => Effect.succeed(held),
      upsert: (input, grantedBy) => Effect.sync(() => void (saved = { input, grantedBy })),
      setEnabled: (_id, enabled) => Effect.sync(() => (log.push(enabled ? "on" : "off"), true)),
      remove: () => Effect.sync(() => void log.push("remove")),
      readState: () => Effect.sync(() => (log.push("read"), STATE)),
      writeState: () => Effect.sync(() => void log.push("state")),
    });
    return { transfer, log, saved: () => saved };
  }
  const stage: RoutineTransferRequest = {
    protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
    op: "stage",
    sourceProjectId: "p-m4",
    routine: COPY,
    ownThread: false,
    boundThreadId: null,
  };

  it.effect("refuses without the routines grant", () =>
    Effect.gen(function* () {
      const refusal = yield* into(null)
        .transfer.receive(caller({ routines: false }), stage)
        .pipe(Effect.flip);
      expect(refusal.status).toBe(403);
      expect(refusal.message).toContain("Routines");
    }),
  );

  it.effect("stages it off in its linked copy, under the caller's grant and cap", () =>
    Effect.gen(function* () {
      const h = into(null);
      const answer = yield* h.transfer.receive(caller(), stage);
      expect(answer).toMatchObject({ projectId: "p-mini", enabled: false, capped: true });
      expect(h.saved()?.input).toMatchObject({
        enabled: false,
        projectId: "p-mini",
        runtimeMode: "auto-accept-edits",
      });
      expect(h.saved()?.grantedBy.coordinatorEnvironmentId).toBe(M4);
    }),
  );

  it.effect("turns on and releases only routines the caller moved", () =>
    Effect.gen(function* () {
      const other = into({ projectId: "p-mini", grantedBy: undefined });
      const refused = yield* other.transfer
        .receive(caller(), {
          protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
          op: "enable",
          routineId: TASK.id,
          runState: STATE,
        })
        .pipe(Effect.flip);
      expect(refused.status).toBe(403);

      const own = into({ projectId: "p-mini", grantedBy: { coordinatorEnvironmentId: M4 } });
      yield* own.transfer.receive(caller(), {
        protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
        op: "enable",
        routineId: TASK.id,
        runState: STATE,
      });
      const released = yield* own.transfer.receive(caller(), {
        protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
        op: "release",
        routineId: TASK.id,
      });
      // The state is read before turning it off, which clears its next run.
      expect(own.log).toEqual(["on", "state", "read", "off", "remove"]);
      expect(released.runState?.nextRunAt).toBe(STATE.nextRunAt);
    }),
  );
});

describe("cappedRuntimeMode", () => {
  it("caps the mode at the caller's ceiling", () => {
    expect(cappedRuntimeMode("full-access", "auto-accept-edits")).toEqual({
      mode: "auto-accept-edits",
      capped: true,
    });
    expect(cappedRuntimeMode("approval-required", "full-access").capped).toBe(false);
    expect(cappedRuntimeMode("full-access", null).capped).toBe(false);
  });
});
