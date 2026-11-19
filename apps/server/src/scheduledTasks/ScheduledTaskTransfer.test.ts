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
import type { RoutineRunnerRecord } from "./ScheduledTaskRunner.ts";
import { ROUTINE_RUNNER_CAPABILITY } from "./ScheduledTaskRunnerWire.ts";
import {
  cappedRuntimeMode,
  makeTransferIn,
  makeTransferOut,
  needsUpdateDetail,
  ROUTINE_TRANSFER_PROTOCOL_VERSION,
  type RoutineTransferRequest,
  settledRunState,
  type TransferRunState,
} from "./ScheduledTaskTransfer.ts";

const TARGET = EnvironmentId.make("env-target");
const SOURCE = EnvironmentId.make("env-source");
const HOUR = 3_600_000;

const TASK = {
  id: ScheduledTaskId.make("routine-1"),
  title: "Instagram",
  prompt: "Post the day's photo.",
  enabled: true,
  schedule: { type: "interval", everyMs: HOUR },
  projectId: "p-source",
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

/** Runner records and receipts kept in memory, as the scheduler's table keeps them. */
function memoryRecords(initial: ReadonlyArray<RoutineRunnerRecord> = []) {
  const rows = new Map<string, RoutineRunnerRecord>(initial.map((row) => [row.taskId, row]));
  const receipts = new Map<string, unknown>();
  return {
    rows,
    receipts,
    records: {
      read: (id: string) => Effect.sync(() => rows.get(id) ?? null),
      write: (record: RoutineRunnerRecord) =>
        Effect.sync(() => void rows.set(record.taskId, record)),
      remove: (id: string) => Effect.sync(() => void rows.delete(id)),
      receipt: (key: string) => Effect.sync(() => receipts.get(key) ?? null),
      putReceipt: (key: string, _task: string, answer: unknown) =>
        Effect.sync(() => void (receipts.has(key) ? undefined : receipts.set(key, answer))),
    },
  };
}

const CAPABLE = { capabilities: [ROUTINE_RUNNER_CAPABILITY] };

function out(
  answers: Record<string, () => Effect.Effect<unknown, AwayPeerError>>,
  here: { readonly offWorks?: boolean; readonly readsEnabled?: boolean } = {},
) {
  const log: Array<string> = [];
  const memory = memoryRecords();
  const post: AwayPeerPost = (_target, _path, body) => {
    const request = body as { readonly op: string };
    log.push(`post:${request.op}`);
    return (answers[request.op] ?? (() => Effect.succeed(CAPABLE)))().pipe(
      Effect.map((json) => ({ status: 200, json })),
    );
  };
  const transfer = makeTransferOut({
    post,
    readState: () =>
      Effect.succeed(
        here.readsEnabled === undefined ? STATE : { ...STATE, enabled: here.readsEnabled },
      ),
    setEnabled: (_id, enabled) =>
      Effect.sync(
        () => (log.push(`here:${enabled ? "on" : "off"}`), enabled || here.offWorks !== false),
      ),
    note: (_id, note) => Effect.sync(() => void log.push(`note:${note ?? "clear"}`)),
    writeState: (_task, state) => Effect.sync(() => void log.push(`state:${state.nextRunAt}`)),
    nowMs: Effect.succeed(Date.parse("2026-11-09T22:30:00.000Z")),
    records: memory.records,
    covered: () => Effect.succeed(true),
    selfEnvironmentId: Effect.succeed(SOURCE),
    revisionOf: () => Effect.succeed(0),
    setRevision: () => Effect.void,
    newOperationId: Effect.succeed("routine-move:fixture-1"),
  });
  return { transfer, log, memory };
}

const moveInput = {
  task: TASK,
  target: TARGET,
  targetLabel: "Target",
  copy: COPY,
  boundThreadId: null,
};
const staged = () => Effect.succeed({ ...CAPABLE, projectId: "p-target", enabled: false });
const turnedOn = () => Effect.succeed({ ...CAPABLE, enabled: true, revision: 1 });
const refusal = (message: string, status = 409) =>
  Effect.fail(new AwayPeerError({ message, refused: true, uncertain: false, status }));
const silence = () =>
  Effect.fail(new AwayPeerError({ message: "no answer", refused: false, uncertain: true }));

describe("routine transfer, this machine's side", () => {
  it.effect("asks, stages there, turns off here, then turns on there once", () =>
    Effect.gen(function* () {
      const { transfer, log, memory } = out({
        "runner-stage": staged,
        "runner-enable": turnedOn,
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "moved", targetProjectId: "p-target" });
      expect(log).toEqual([
        "post:status",
        "post:runner-stage",
        "here:off",
        "note:Paused while away on Target.",
        "post:runner-enable",
      ]);
      // This copy names its runner and never fires again.
      expect(memory.rows.get(TASK.id)).toMatchObject({
        state: "disarmed",
        runnerEnvironmentId: TARGET,
        revision: 1,
      });
    }),
  );

  it.effect("sends nothing more to a machine that does not keep runner records", () =>
    Effect.gen(function* () {
      const { transfer, log, memory } = out({
        status: () => refusal("Target: The request does not match this version.", 400),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toEqual({
        kind: "failed",
        detail: needsUpdateDetail("Target"),
        offHere: false,
      });
      expect(log).toEqual(["post:status"]);
      expect(memory.rows.size).toBe(0);
    }),
  );

  it.effect("turns it back on here, with its due slot, when the target refuses to turn it on", () =>
    Effect.gen(function* () {
      const { transfer, log, memory } = out({
        "runner-stage": staged,
        "runner-enable": () => refusal("Target: no"),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log.slice(-4)).toEqual([
        "post:runner-abort",
        "here:on",
        `state:${STATE.nextRunAt}`,
        "note:clear",
      ]);
      expect(memory.rows.size).toBe(0);
    }),
  );

  it.effect("leaves it off on both when the target does not answer, and remembers the move", () =>
    Effect.gen(function* () {
      const { transfer, log, memory } = out({
        "runner-stage": staged,
        "runner-enable": silence,
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: true });
      expect(log).not.toContain("here:on");
      expect(log).not.toContain("post:runner-abort");
      expect(memory.rows.get(TASK.id)).toMatchObject({
        state: "moving",
        operationId: "routine-move:fixture-1",
        operation: { phase: "off", runState: STATE },
      });
    }),
  );

  it.effect("tried again, asks where the move stands and repeats the same enable", () =>
    Effect.gen(function* () {
      let enables = 0;
      const { transfer, log } = out({
        status: () => Effect.succeed({ ...CAPABLE, operation: "staged" }),
        "runner-stage": staged,
        "runner-enable": () => (enables++ === 0 ? silence() : turnedOn()),
      });
      yield* transfer.moveOut(moveInput);
      log.length = 0;
      const again = yield* transfer.moveOut(moveInput);
      expect(again.kind).toBe("moved");
      // No second stage, and this machine was not turned off twice.
      expect(log).toEqual(["post:status", "post:runner-enable"]);
    }),
  );

  it.effect("tried again after the target turned it on, ends without another enable", () =>
    Effect.gen(function* () {
      let asked = 0;
      const { transfer, log, memory } = out({
        status: () =>
          Effect.succeed(
            asked++ === 0
              ? CAPABLE
              : {
                  ...CAPABLE,
                  operation: "enabled",
                  routine: {
                    state: "settled",
                    runnerEnvironmentId: TARGET,
                    revision: 1,
                    enabled: true,
                  },
                },
          ),
        "runner-stage": staged,
        "runner-enable": silence,
      });
      yield* transfer.moveOut(moveInput);
      log.length = 0;
      expect((yield* transfer.moveOut(moveInput)).kind).toBe("moved");
      expect(log).toEqual(["post:status"]);
      expect(memory.rows.get(TASK.id)?.state).toBe("disarmed");
    }),
  );

  it.effect("tried again when the target has no trace of the move, calls it off there first", () =>
    Effect.gen(function* () {
      let aborts = 0;
      const { transfer, log, memory } = out({
        status: () => Effect.succeed({ ...CAPABLE, operation: "unknown" }),
        "runner-stage": staged,
        "runner-enable": silence,
        // The first call-off is lost too: the enable may still arrive, so nothing turns on here.
        "runner-abort": () =>
          aborts++ === 0 ? silence() : Effect.succeed({ ...CAPABLE, operation: "aborted" }),
      });
      yield* transfer.moveOut(moveInput);
      log.length = 0;
      const stillOff = yield* transfer.moveOut(moveInput);
      expect(stillOff).toMatchObject({ kind: "failed", offHere: true });
      expect(log).toEqual(["post:status", "post:runner-abort"]);
      expect(memory.rows.get(TASK.id)?.state).toBe("moving");
      log.length = 0;
      const back = yield* transfer.moveOut(moveInput);
      expect(back).toMatchObject({ kind: "failed", offHere: false });
      expect(log).toEqual([
        "post:status",
        "post:runner-abort",
        "here:on",
        `state:${STATE.nextRunAt}`,
        "note:clear",
      ]);
      expect(memory.rows.size).toBe(0);
    }),
  );

  it.effect("takes a failure of the target to read its own state as no answer, not as a no", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({
        "runner-stage": staged,
        "runner-enable": () => refusal("Target: could not read its routine runners.", 503),
      });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: true });
      expect(log).not.toContain("here:on");
    }),
  );

  it.effect("never turns it off here when staging fails", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({ "runner-stage": () => refusal("no grant", 403) });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log).toEqual(["post:status", "post:runner-stage"]);
    }),
  );

  it.effect("never turns it on there when turning it off here failed", () =>
    Effect.gen(function* () {
      const { transfer, log, memory } = out({ "runner-stage": staged }, { offWorks: false });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log).toEqual(["post:status", "post:runner-stage", "here:off", "post:runner-abort"]);
      expect(memory.rows.size).toBe(0);
    }),
  );

  it.effect("never turns it on there when its row here still reads on", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({ "runner-stage": staged }, { readsEnabled: true });
      const moved = yield* transfer.moveOut(moveInput);
      expect(moved).toMatchObject({ kind: "failed", offHere: false });
      expect(log).not.toContain("post:runner-enable");
      expect(log).toContain("post:runner-abort");
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
        targetLabel: "Target",
        wasEnabled: true,
      });
      expect(back.kind).toBe("returned");
      expect(log).toEqual(["post:release", "note:clear", "here:on", `state:${STATE.nextRunAt}`]);
    }),
  );

  it.effect("keeps it off here when the target cannot release it", () =>
    Effect.gen(function* () {
      const { transfer, log } = out({ release: silence });
      const back = yield* transfer.bringBack({
        task: TASK,
        target: TARGET,
        targetLabel: "Target",
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
    coordinatorEnvironmentId: SOURCE,
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    revoked: false,
    routines: true,
    ...overrides,
  });
  const caller = (overrides: Partial<EffectiveWorkGrant> = {}): ReceiverCaller => ({
    sourceEnvironmentId: SOURCE,
    grant: grant(overrides),
    runtimeCeiling: "auto-accept-edits",
  });
  const project = {
    id: "p-target",
    deletedAt: null,
    workspaceSettings: {
      logicalProject: { id: "lp", members: [{ environmentId: SOURCE, projectId: "p-source" }] },
    },
  } as unknown as Project;

  function into(held: { projectId: string; grantedBy: ScheduledTaskGrantedBy | undefined } | null) {
    const log: Array<string> = [];
    const memory = memoryRecords();
    let saved: { input: ScheduledTaskUpsertInput; grantedBy: ScheduledTaskGrantedBy } | null = null;
    const transfer = makeTransferIn({
      projects: Effect.succeed([project]),
      findTask: () => Effect.succeed(held),
      upsert: (input, grantedBy) => Effect.sync(() => void (saved = { input, grantedBy })),
      setEnabled: (_id, enabled) => Effect.sync(() => (log.push(enabled ? "on" : "off"), true)),
      remove: () => Effect.sync(() => void log.push("remove")),
      readState: () => Effect.sync(() => (log.push("read"), STATE)),
      writeState: () => Effect.sync(() => void log.push("state")),
      records: memory.records,
      selfEnvironmentId: Effect.succeed(TARGET),
      revisionOf: () => Effect.succeed(0),
      commitEnable: (input) =>
        Effect.sync(() => {
          log.push("commit");
          memory.rows.set(input.record.taskId, input.record);
          memory.receipts.set(input.receiptKey, input.answer);
        }),
    });
    return { transfer, log, saved: () => saved, memory };
  }
  const stage: RoutineTransferRequest = {
    protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
    op: "stage",
    sourceProjectId: "p-source",
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
      expect(answer).toMatchObject({ projectId: "p-target", enabled: false, capped: true });
      expect(h.saved()?.input).toMatchObject({
        enabled: false,
        projectId: "p-target",
        runtimeMode: "auto-accept-edits",
      });
      expect(h.saved()?.grantedBy.coordinatorEnvironmentId).toBe(SOURCE);
    }),
  );

  it.effect("turns on and releases only routines the caller moved", () =>
    Effect.gen(function* () {
      const other = into({ projectId: "p-target", grantedBy: undefined });
      const refused = yield* other.transfer
        .receive(caller(), {
          protocolVersion: ROUTINE_TRANSFER_PROTOCOL_VERSION,
          op: "enable",
          routineId: TASK.id,
          runState: STATE,
        })
        .pipe(Effect.flip);
      expect(refused.status).toBe(403);

      const own = into({ projectId: "p-target", grantedBy: { coordinatorEnvironmentId: SOURCE } });
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

describe("a runner move, the target's side", () => {
  const caller: ReceiverCaller = {
    sourceEnvironmentId: SOURCE,
    grant: {
      coordinatorEnvironmentId: SOURCE,
      projects: { kind: "all" },
      accounts: { kind: "all" },
      owner: "self",
      hopLimit: 2,
      revoked: false,
      routines: true,
    },
    runtimeCeiling: "full-access",
  };
  const project = {
    id: "p-target",
    deletedAt: null,
    workspaceSettings: {
      logicalProject: { id: "lp", members: [{ environmentId: SOURCE, projectId: "p-source" }] },
    },
  } as unknown as Project;
  function target() {
    const log: Array<string> = [];
    const memory = memoryRecords();
    let held: { projectId: string; grantedBy: ScheduledTaskGrantedBy | undefined } | null = null;
    const transfer = makeTransferIn({
      projects: Effect.succeed([project]),
      findTask: () => Effect.sync(() => held),
      upsert: (input, grantedBy) =>
        Effect.sync(() => {
          log.push("save");
          held = { projectId: input.projectId, grantedBy };
        }),
      setEnabled: (_id, enabled) => Effect.sync(() => (log.push(enabled ? "on" : "off"), true)),
      remove: () =>
        Effect.sync(() => {
          log.push("remove");
          held = null;
        }),
      readState: () => Effect.succeed(STATE),
      writeState: () => Effect.sync(() => void log.push("state")),
      records: memory.records,
      selfEnvironmentId: Effect.succeed(TARGET),
      revisionOf: () => Effect.succeed(0),
      commitEnable: (input) =>
        Effect.sync(() => {
          log.push(`commit:${input.runState.nextRunAt}`);
          memory.rows.set(input.record.taskId, input.record);
          memory.receipts.set(input.receiptKey, input.answer);
        }),
    });
    return { transfer, log, memory };
  }
  const OPERATION = "routine-move:fixture-1";
  const stage = {
    op: "runner-stage",
    operationId: OPERATION,
    sourceProjectId: "p-source",
    routine: COPY,
    ownThread: false,
    boundThreadId: null,
  } as const;
  const enable = {
    op: "runner-enable",
    operationId: OPERATION,
    routineId: TASK.id,
    runState: STATE,
    revision: 3,
    acked: [SOURCE],
  } as const;

  it.effect("turns it on once, and answers a repeat without writing again", () =>
    Effect.gen(function* () {
      const h = target();
      yield* h.transfer.receiveMove(caller, stage);
      expect(h.memory.rows.get(TASK.id)?.state).toBe("staged");
      const first = yield* h.transfer.receiveMove(caller, enable);
      expect(first).toMatchObject({ enabled: true, revision: 4, operation: "enabled" });
      expect(h.log).toEqual(["save", "on", `commit:${STATE.nextRunAt}`]);
      expect(h.memory.rows.get(TASK.id)).toMatchObject({
        state: "settled",
        runnerEnvironmentId: TARGET,
        revision: 4,
        acked: [SOURCE],
      });
      // The acknowledgement was lost; the source sends the enable again, later, with an older state.
      const again = yield* h.transfer.receiveMove(caller, {
        ...enable,
        runState: { ...STATE, nextRunAt: "2026-11-09T21:00:00.000Z" },
      });
      expect(again).toEqual(first);
      expect(h.log).toEqual(["save", "on", `commit:${STATE.nextRunAt}`]);
    }),
  );

  it.effect("refuses an enable that arrives after the move was called off", () =>
    Effect.gen(function* () {
      const h = target();
      yield* h.transfer.receiveMove(caller, stage);
      const aborted = yield* h.transfer.receiveMove(caller, {
        op: "runner-abort",
        operationId: OPERATION,
        routineId: TASK.id,
      });
      expect(aborted).toMatchObject({ operation: "aborted", enabled: false });
      expect(h.memory.rows.size).toBe(0);
      const late = yield* h.transfer.receiveMove(caller, enable).pipe(Effect.flip);
      expect(late.status).toBe(409);
      expect(h.log).toEqual(["save", "off", "remove"]);
    }),
  );

  it.effect("refuses an enable for a move it never staged, and one under another id", () =>
    Effect.gen(function* () {
      const h = target();
      expect((yield* h.transfer.receiveMove(caller, enable).pipe(Effect.flip)).status).toBe(409);
      yield* h.transfer.receiveMove(caller, stage);
      const other = yield* h.transfer
        .receiveMove(caller, { ...enable, operationId: "routine-move:fixture-2" })
        .pipe(Effect.flip);
      expect(other.status).toBe(409);
      expect(h.log).toEqual(["save"]);
    }),
  );

  it.effect("refuses to stage over a routine this machine runs itself", () =>
    Effect.gen(function* () {
      const h = target();
      h.memory.rows.set(TASK.id, {
        taskId: TASK.id,
        state: "settled",
        runnerEnvironmentId: TARGET,
        runnerLabel: null,
        revision: 2,
        acked: [SOURCE],
        operationId: null,
        operation: null,
      });
      const refused = yield* h.transfer.receiveMove(caller, stage).pipe(Effect.flip);
      expect(refused.status).toBe(409);
      expect(h.log).toEqual([]);
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
