// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The hand off batch (1390 T-11) on two machines that talk through the peer
 * calls: one batch type for a manual and an automatic start, written through
 * the transfer record, with each thread's disposition, the project folder
 * work, and the context at a named revision. It moves no coordinator, no
 * routine and no project memory.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  HANDOFF_BATCH_CAPABILITY,
  HANDOFF_V2_CAPABILITY,
  HandoffBatchInput,
  type HandoffBatchRun,
  HandoffTransferDocument,
  ProjectId,
  ThreadId,
  WS_METHODS,
  WsAwayRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import {
  applyFolderWork,
  batchArrival,
  batchInputFromPlan,
  coordinatorStays,
  makeFolderWorkSender,
} from "./HandoffBatch.ts";
import {
  buildHandoffPlan,
  HANDOFF_PLAN_CAPABILITY,
  type HandoffPlanFacts,
  type HandoffThreadFact,
} from "./handoffPlan.ts";
import { makeRig, type Rig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import { HANDOFF_CAPABILITIES, TakeoverRequest } from "./handoffWire.ts";
import {
  PREVIOUS_RELEASE,
  PreviousTakeoverRequest,
  overTheWire,
} from "./previousRelease383.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const t1 = ThreadId.make("thread:one");
const t2 = ThreadId.make("thread:two");
const t3 = ThreadId.make("thread:three");
const AUTOMATIC = { kind: "automatic", key: "limit-handoff:thread:one:run-1" } as const;

const two = (rig: Rig) => rig.machines as [RigMachine, RigMachine];
const rowOf = (run: HandoffBatchRun, id: string) => run.rows.find((row) => row.id === id);
const takeovers = (rig: Rig) =>
  rig.callsOf("takeover").map((call) => call.request as TakeoverRequest);
const leaseOf = (machine: RigMachine, id: ThreadId) => machine.document.threads[id]?.lease ?? null;
const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});

describe("each thread's disposition in a batch (AC-41)", () => {
  it.effect('a thread stopped on the limit reads "Resumed on {machine}"', () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      a.runEnding = "usage-limit";

      const run = yield* a.moves.handOffBatch({
        destinationEnvironmentId: b.environmentId,
        start: "automatic",
        trigger: AUTOMATIC,
        threads: [{ threadId: t1, disposition: "resume" }],
      });

      expect(rowOf(run, t1)).toMatchObject({ state: "resumed", disposition: "resume" });
      expect(rowOf(run, t1)?.detail?.startsWith("Resumed on B")).toBe(true);
      expect(run.finishedAt).not.toBeNull();
      expect(b.launches).toHaveLength(1);
      // The destination continues the run from the seed message.
      expect(b.launches[0]?.initialMessage).toBeDefined();
      expect(takeovers(rig)[0]?.batch).toMatchObject({
        batchId: run.batchId,
        disposition: "resume",
      });
      expect(takeovers(rig)[0]?.trigger).toEqual(AUTOMATIC);
    }),
  );

  it.effect(
    "a settled thread picked for its unsaved files arrives Ready, though its last run stopped on the limit",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        rig.addThread(a, t1);
        // The checkpoint alone would continue this run on arrival.
        a.runEnding = "usage-limit";

        const run = yield* a.moves.handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "manual",
          threads: [{ threadId: t1, disposition: "ready" }],
        });

        expect(rowOf(run, t1)).toMatchObject({ state: "ready", disposition: "ready" });
        expect(rowOf(run, t1)?.detail?.startsWith("Ready on B")).toBe(true);
        expect(takeovers(rig)[0]?.batch?.disposition).toBe("ready");
        // Installed idle: the thread exists there and no turn was started for it.
        expect(b.launches).toHaveLength(1);
        expect(b.launches[0]?.initialMessage).toBeUndefined();
        const record = Object.values(a.transfers.document.transfers)[0];
        expect(record).toMatchObject({ state: "ready", disposition: "ready" });
        expect(record?.receipt?.resumed).toBe(false);
      }),
  );

  const P1 = ProjectId.make("project-a");
  const thread = (overrides: Partial<HandoffThreadFact>): HandoffThreadFact => ({
    id: t1,
    title: "Fix the parser",
    projectId: P1,
    personal: false,
    activity: "waiting",
    unsaved: false,
    pending: null,
    runEnding: "completed",
    lastTurnEndedAt: null,
    reviewStay: null,
    worktreeSet: false,
    brokenFolder: null,
    check: {
      kind: "checked",
      failures: [],
      evidence: {
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never,
        providerName: "Claude",
        kind: "different-account",
        line: "Different Claude account · 60% left",
        percentLeft: 60,
        automatic: true,
        accountFingerprint: "pool-b",
        usedPercent: 40,
        resetsAt: "2026-11-19T18:00:00.000Z",
        observedAt: "2026-11-19T13:59:00.000Z",
      },
    },
    measure: { bytes: 2048, files: 3, over: null },
    usage: null,
    ...overrides,
  });
  const nowMs = Date.parse("2026-11-19T14:00:00.000Z");
  const atThreshold = { usedPercent: 99, windowKey: "w", movedInWindow: false };
  const automaticFacts = (
    a: RigMachine,
    b: RigMachine,
    thresholdPercent: number | null,
  ): HandoffPlanFacts => ({
    start: "automatic",
    self: { environmentId: a.environmentId, label: a.label },
    target: { environmentId: b.environmentId, label: b.label },
    rule: { action: "switch", hasTargets: true, thresholdPercent },
    folderWork: [],
    nowMs,
    threads: [
      thread({
        id: t1,
        runEnding: "usage-limit",
        lastTurnEndedAt: "2026-11-19T12:00:00.000Z",
        usage: { usedPercent: 100, windowKey: "w", movedInWindow: false },
      }),
      // Idle at 99%, nine minutes after its last turn.
      thread({ id: t2, lastTurnEndedAt: "2026-11-19T13:51:00.000Z", usage: atThreshold }),
      // Idle at 99%, eleven minutes after its last turn.
      thread({ id: t3, lastTurnEndedAt: "2026-11-19T13:49:00.000Z", usage: atThreshold }),
    ],
  });

  it.effect(
    "an automatic batch from the plan resumes the limit stop, installs the idle thread, and leaves one idle longer",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        for (const id of [t1, t2, t3]) rig.addThread(a, id);
        a.runEnding = "usage-limit";

        const input = batchInputFromPlan(buildHandoffPlan(automaticFacts(a, b, 99)), AUTOMATIC);
        expect(input.threads).toEqual([
          { threadId: t1, disposition: "resume" },
          { threadId: t2, disposition: "ready" },
        ]);
        const run = yield* a.moves.handOffBatch(input);

        expect(run.rows.map((row) => [row.id, row.detail?.split(".")[0]])).toEqual([
          [t1, "Resumed on B"],
          [t2, "Ready on B"],
        ]);
        expect(leaseOf(a, t3)).toMatchObject({ state: "active", epoch: 1 });
        expect(
          Object.values(a.transfers.document.transfers).map(
            (record) => record.lineage.sourceThreadId,
          ),
        ).toEqual([t1, t2]);
      }),
  );

  it.effect("with the threshold turned off only the limit stop moves", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      for (const id of [t1, t2, t3]) rig.addThread(a, id);
      a.runEnding = "usage-limit";

      const run = yield* a.moves.handOffBatch(
        batchInputFromPlan(buildHandoffPlan(automaticFacts(a, b, null)), AUTOMATIC),
      );

      expect(run.rows.map((row) => [row.id, row.state])).toEqual([[t1, "resumed"]]);
      expect(leaseOf(a, t2)).toMatchObject({ state: "active" });
      expect(b.launches).toHaveLength(1);
    }),
  );

  it.effect("an automatic start names its rule and carries no folder work", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);

      const unnamed = yield* a.moves
        .handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "automatic",
          threads: [{ threadId: t1, disposition: "resume" }],
        })
        .pipe(Effect.flip);
      expect(unnamed.code).toBe("invalid");
      const withFolder = yield* a.moves
        .handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "automatic",
          trigger: AUTOMATIC,
          threads: [],
          folderWork: [a.projectId],
        })
        .pipe(Effect.flip);
      expect(withFolder.code).toBe("invalid");
      expect(rig.callsOf("takeover")).toHaveLength(0);
      expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
    }),
  );
});

describe("the batch is written through the transfer record", () => {
  it.effect(
    "has the batch and each thread's record on file before the first thread is held",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        rig.addThread(a, t1, { running: true });
        rig.addThread(a, t2);
        let atFirstHold: HandoffTransferDocument | null = null;
        a.onDocument = (document) =>
          Effect.sync(() => {
            const held = Object.values(document.threads).some(
              (record) => record.lease?.state === "handing-off",
            );
            if (held && atFirstHold === null) atFirstHold = a.transfers.document;
          });

        const run = yield* a.moves.handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "manual",
          threads: [
            { threadId: t1, disposition: "resume" },
            { threadId: t2, disposition: "ready" },
          ],
        });

        const seen = atFirstHold as HandoffTransferDocument | null;
        expect(seen).not.toBeNull();
        const batch = seen?.batches[run.batchId];
        expect(batch).toMatchObject({
          start: "manual",
          targetEnvironmentId: b.environmentId,
          targetLabel: "B",
        });
        expect(batch?.operationIds).toHaveLength(2);
        expect(batch?.rows?.map((row) => [row.id, row.operationId !== null])).toEqual([
          [t1, true],
          [t2, true],
        ]);
        const planned = Object.values(seen?.transfers ?? {});
        expect(
          planned.map((record) => [
            record.lineage.sourceThreadId,
            record.batchId,
            record.targetEnvironmentId,
            record.disposition,
          ]),
        ).toEqual([
          [t1, run.batchId, b.environmentId, "resume"],
          [t2, run.batchId, b.environmentId, "ready"],
        ]);
        // Read again later, the batch is the same rows from the same records.
        expect(yield* a.moves.readBatches({ batchId: run.batchId })).toEqual([run]);
      }),
  );

  it.effect("hands each thread over at the revision of its checkpoint, and names it", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);

      const run = yield* a.moves.handOffBatch({
        destinationEnvironmentId: b.environmentId,
        start: "manual",
        threads: [{ threadId: t1 }],
      });

      const checkpoint = a.document.threads[t1]?.checkpoint;
      const context = { sequence: checkpoint?.sequence, commit: checkpoint?.commit };
      expect(checkpoint).not.toBeNull();
      expect(rowOf(run, t1)?.context).toEqual(context);
      expect(takeovers(rig)[0]?.batch?.context).toEqual(context);
      expect(takeovers(rig)[0]?.sequence).toBe(checkpoint?.sequence);
    }),
  );

  it.effect("a destination that holds another revision refuses, and launches nothing", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      // The copy is on B at the checkpoint's revision.
      yield* a.moves.preflight({ destinationEnvironmentId: b.environmentId, threadIds: [t1] });
      const sequence = a.document.threads[t1]?.checkpoint?.sequence ?? 0;

      const refused = yield* b.receiver
        .takeover(caller(a), {
          sourceEnvironmentId: a.environmentId,
          sourceThreadId: t1,
          epoch: 2,
          sequence,
          reason: "machine-handoff",
          modelSelection: null,
          operationId: "0a1b2c3d-1111-4222-8333-444455556666",
          trigger: { kind: "manual" },
          batch: {
            batchId: "0a1b2c3d-1111-4222-8333-444455557777",
            disposition: "ready",
            context: { sequence, commit: "0".repeat(40) },
          },
        })
        .pipe(Effect.flip);

      expect(refused.uncertain).not.toBe(true);
      expect(refused.message).toContain("another revision");
      expect(b.launches).toHaveLength(0);
    }),
  );

  it("decides arrival from the batch, and from the checkpoint when there is none", () => {
    const checkpoint = { sequence: 3, commit: "a".repeat(40) };
    const batch = (disposition: "resume" | "ready", commit = checkpoint.commit) => ({
      batchId: "b",
      disposition,
      context: { sequence: 3, commit },
    });
    const arrive = (input: Partial<Parameters<typeof batchArrival>[0]>) =>
      batchArrival({ batch: undefined, sequence: 3, checkpoint, resumable: true, ...input });
    expect(arrive({})).toEqual({ kind: "take", resume: true });
    expect(arrive({ resumable: false })).toEqual({ kind: "take", resume: false });
    expect(arrive({ batch: batch("ready") })).toEqual({ kind: "take", resume: false });
    expect(arrive({ batch: batch("resume") })).toEqual({ kind: "take", resume: true });
    // A user Stop is never continued, whatever the batch asked.
    expect(arrive({ batch: batch("resume"), resumable: false })).toEqual({
      kind: "take",
      resume: false,
    });
    expect(arrive({ batch: batch("ready", "b".repeat(40)) })).toEqual({ kind: "refuse" });
    expect(arrive({ batch: batch("ready"), sequence: 4 })).toEqual({ kind: "refuse" });
  });
});

describe("a batch changes only which machine runs a thread (AC-46)", () => {
  it("has no field for a coordinator, a routine or project memory", () => {
    expect(Object.keys(HandoffBatchInput.fields).toSorted()).toEqual([
      "destinationEnvironmentId",
      "folderWork",
      "start",
      "threads",
      "trigger",
    ]);
    const decoded = Schema.decodeUnknownSync(HandoffBatchInput)({
      destinationEnvironmentId: "env-b",
      start: "manual",
      threads: [],
      coordinator: true,
      routines: ["routine-1"],
      memory: [{ name: "note.md", content: "x" }],
    });
    expect(Object.keys(decoded).toSorted()).toEqual([
      "destinationEnvironmentId",
      "start",
      "threads",
    ]);
  });

  it.effect(
    "moves the worker and leaves the coordinator conversation where it is, with its reason",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        const coordinator = ThreadId.make(`project-coordinator:${a.projectId}`);
        rig.addThread(a, coordinator, { running: true });
        rig.addThread(a, t1);

        const run = yield* a.moves.handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "manual",
          threads: [{ threadId: coordinator }, { threadId: t1 }],
        });

        expect(rowOf(run, coordinator)).toMatchObject({
          state: "stayed",
          detail: coordinatorStays("A"),
          operationId: null,
        });
        expect(rowOf(run, t1)?.state).toBe("resumed");
        expect(leaseOf(a, coordinator)).toMatchObject({ state: "active", epoch: 1 });
        expect(a.threads.get(coordinator)?.activeRunId).not.toBeNull();
        expect(takeovers(rig).map((request) => request.sourceThreadId)).toEqual([t1]);
        // Only a thread's own calls went out: nothing for a role, a routine or memory.
        expect([...new Set(rig.network.calls.map((call) => call.path))].toSorted()).toEqual([
          "negotiate",
          "preflight",
          "replicate",
          "takeover",
        ]);
        expect(b.launches.map((launch) => launch.threadId)).not.toContain(coordinator);
      }),
  );
});

describe("the source keeps the thread, and a lost answer is replayed (AC-23)", () => {
  it.effect("keeps every file and marks the thread as handed off, with its way back", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      rig.addThread(a, t1);
      NodeFS.writeFileSync(NodePath.join(a.root, "notes.txt"), "kept on the source\n");

      const run = yield* a.moves.handOffBatch({
        destinationEnvironmentId: b.environmentId,
        start: "manual",
        threads: [{ threadId: t1, disposition: "ready" }],
      });

      expect(NodeFS.readFileSync(NodePath.join(a.root, "notes.txt"), "utf8")).toBe(
        "kept on the source\n",
      );
      expect(a.threads.has(t1)).toBe(true);
      const continued = rowOf(run, t1)?.continuedThreadId;
      expect(continued).not.toBeNull();
      expect(a.document.threads[t1]?.continuedOn).toMatchObject({
        environmentId: b.environmentId,
        machineLabel: "B",
        threadId: continued,
      });
    }),
  );

  it.effect(
    "a takeover with no answer leaves the row waiting, starts nothing here, and is sent again under the same operation",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        rig.addThread(a, t1, { running: true });
        let lost = 0;
        rig.network.rule = (call) =>
          call.path === "takeover" && lost++ === 0 ? "lose-answer" : undefined;

        const run = yield* a.moves.handOffBatch({
          destinationEnvironmentId: b.environmentId,
          start: "manual",
          threads: [{ threadId: t1, disposition: "resume" }],
        });

        expect(rowOf(run, t1)?.state).toBe("unknown");
        expect(run.finishedAt).toBeNull();
        expect(leaseOf(a, t1)?.state).toBe("handing-off");
        expect(a.dispatched.filter((command) => command.type === "run.start")).toHaveLength(0);

        yield* a.moves.tick;

        const [again] = yield* a.moves.readBatches({ batchId: run.batchId });
        expect(rowOf(again!, t1)).toMatchObject({
          state: "resumed",
          operationId: rowOf(run, t1)?.operationId,
        });
        expect(again?.finishedAt).not.toBeNull();
        const sent = takeovers(rig);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.operationId).toBe(sent[0]?.operationId);
        expect(sent[1]?.batch).toEqual(sent[0]?.batch);
        // Accepted once: the repeat got the first receipt.
        expect(b.launches).toHaveLength(1);
      }),
  );
});

describe("the batch's own capability, with machines on other builds (EC2-04, EC2-09)", () => {
  const BEFORE_BATCHES = [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY];
  const three = [
    { name: "a" },
    { name: "b" },
    { name: "old", previous: true },
    { name: "mid", capabilities: BEFORE_BATCHES },
  ];

  it("names its own capability, beside the transfer record's and the plan's", () => {
    expect(HANDOFF_BATCH_CAPABILITY).toBe("handoff.batch");
    expect(HANDOFF_CAPABILITIES).toEqual([...BEFORE_BATCHES, HANDOFF_BATCH_CAPABILITY]);
  });

  it(`${PREVIOUS_RELEASE} reads a batch's takeover and drops what it does not know`, () => {
    const takeover = Schema.encodeSync(TakeoverRequest)({
      sourceEnvironmentId: EnvironmentId.make("env-a"),
      sourceThreadId: t1,
      epoch: 2,
      sequence: 1,
      reason: "machine-handoff",
      modelSelection: null,
      operationId: "0a1b2c3d-1111-4222-8333-444455556666",
      trigger: { kind: "manual" },
      batch: {
        batchId: "0a1b2c3d-1111-4222-8333-444455557777",
        disposition: "ready",
        context: { sequence: 1, commit: "a".repeat(40) },
      },
    });
    const read = Schema.decodeUnknownOption(PreviousTakeoverRequest)(overTheWire(takeover));
    expect(Option.isSome(read)).toBe(true);
    expect(Option.getOrThrow(read)).not.toHaveProperty("batch");
  });

  for (const peer of ["old", "mid"] as const) {
    it.effect(
      `as the source, to a machine ${peer === "old" ? `on ${PREVIOUS_RELEASE}` : "with transfer records and plans but no batches"}: every row reads "Needs update" and nothing is held`,
      () =>
        Effect.gen(function* () {
          const rig = yield* makeRig(temporary, three);
          const [a, , old, mid] = rig.machines as [RigMachine, RigMachine, RigMachine, RigMachine];
          const target = peer === "old" ? old : mid;
          rig.addThread(a, t1, { running: true });
          rig.addThread(a, t2);

          const run = yield* a.moves.handOffBatch({
            destinationEnvironmentId: target.environmentId,
            start: "manual",
            threads: [
              { threadId: t1, disposition: "resume" },
              { threadId: t2, disposition: "ready" },
            ],
            folderWork: [a.projectId],
          });

          expect(run.rows.map((row) => row.state)).toEqual(["stayed", "stayed", "stayed"]);
          for (const row of run.rows) {
            expect(row.detail?.startsWith("Needs update: ")).toBe(true);
            expect(row.detail).toContain(target.label);
          }
          if (peer === "mid") expect(run.rows[0]?.detail).toContain("before hand off batches");
          expect(run.finishedAt).not.toBeNull();
          // Refused before the hold: no turn stopped, nothing sent, nothing launched.
          expect(rig.callsOf("takeover")).toHaveLength(0);
          expect(rig.callsOf("replicate")).toHaveLength(0);
          expect(rig.callsOf("folder-work")).toHaveLength(0);
          expect(target.launches).toHaveLength(0);
          expect(leaseOf(a, t1)).toMatchObject({ state: "active", epoch: 1 });
          expect(a.threads.get(t1)?.activeRunId).not.toBeNull();
          expect(a.dispatched.filter((command) => command.type === "run.interrupt")).toHaveLength(
            0,
          );
        }),
    );
  }

  it.effect(
    "as the destination, a move from a build without batches is decided by its checkpoint, as before",
    () =>
      Effect.gen(function* () {
        const rig = yield* makeRig(temporary);
        const [a, b] = two(rig);
        rig.addThread(a, t1);
        a.runEnding = "usage-limit";

        // A single move sends no batch fields, as a build from before batches does.
        yield* a.moves.handOff({ threadId: t1, destinationEnvironmentId: b.environmentId });

        expect(takeovers(rig)[0]).not.toHaveProperty("batch");
        expect(b.launches[0]?.initialMessage).toBeDefined();
        expect(Object.values(a.transfers.document.transfers)[0]?.state).toBe("resumed");
      }),
  );

  it.effect("as the destination, the current build takes a batch from the current build", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary, three);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      rig.addThread(a, t1);

      const run = yield* a.moves.handOffBatch({
        destinationEnvironmentId: b.environmentId,
        start: "manual",
        threads: [{ threadId: t1, disposition: "ready" }],
      });

      expect(rowOf(run, t1)?.state).toBe("ready");
      expect(takeovers(rig)[0]?.batch?.batchId).toBe(run.batchId);
    }),
  );

  it("reads records written before batches, and writes fields they did not have", () => {
    const before = {
      version: 1,
      transfers: {
        op: {
          operationId: "op",
          batchId: "batch",
          lineage: { sourceEnvironmentId: "env-a", sourceThreadId: "thread:one", epoch: 2 },
          projectId: "project-a",
          targetEnvironmentId: "env-b",
          sequence: 1,
          disposition: "resume",
          state: "sent",
          legacy: false,
          candidates: [],
          trigger: { kind: "manual" },
          reason: "machine-handoff",
          modelSelection: null,
          receipt: null,
          detail: null,
          createdAt: "2026-11-19T14:00:00.000Z",
          updatedAt: "2026-11-19T14:00:00.000Z",
          sentAt: "2026-11-19T14:00:00.000Z",
        },
      },
      batches: {
        batch: {
          batchId: "batch",
          targetEnvironmentId: "env-b",
          trigger: { kind: "manual" },
          operationIds: ["op"],
          createdAt: "2026-11-19T14:00:00.000Z",
        },
      },
      acceptances: {},
    };
    const decode = Schema.decodeUnknownOption(HandoffTransferDocument);
    expect(Option.isSome(decode(before))).toBe(true);
    const after = structuredClone(before) as Record<string, any>;
    after.transfers.op.context = { sequence: 1, commit: "a".repeat(40) };
    Object.assign(after.batches.batch, {
      start: "manual",
      targetLabel: "B",
      finishedAt: null,
      rows: [
        {
          kind: "thread",
          id: "thread:one",
          title: "One",
          projectId: "project-a",
          operationId: "op",
          disposition: "resume",
          state: "pending",
          detail: null,
        },
      ],
    });
    const read = decode(after);
    expect(Option.isSome(read)).toBe(true);
    expect(Option.getOrThrow(read).transfers.op?.context?.sequence).toBe(1);
  });
});

describe("project folder work (AC-20)", () => {
  /** A source with uncommitted work, and its snapshot landed on the destination as a branch. */
  const folders = () => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-folder-work-")),
    );
    temporary.push(base);
    const source = NodePath.join(base, "source");
    const destination = NodePath.join(base, "destination");
    NodeFS.mkdirSync(source);
    git(source, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 1;\n");
    NodeFS.writeFileSync(NodePath.join(source, "gone.ts"), "export const gone = 1;\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "base");
    git(base, "clone", "-q", source, destination);
    // The work that only the source has.
    NodeFS.writeFileSync(NodePath.join(source, "app.ts"), "export const a = 2;\n");
    NodeFS.writeFileSync(NodePath.join(source, "new.ts"), "export const fresh = 1;\n");
    NodeFS.rmSync(NodePath.join(source, "gone.ts"));
    git(source, "checkout", "-q", "-b", "snapshot");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "snapshot");
    const branch = "swc/from-a/uncommitted-20261119-140000-abc123";
    git(destination, "fetch", "-q", source, `snapshot:${branch}`);
    return { destination, branch };
  };
  const statusOf = (root: string) =>
    git(root, "status", "--porcelain=v1", "--untracked-files=all").split("\n").toSorted();

  it("puts the files into a folder at the parent commit with no changes of its own, as uncommitted files", async () => {
    const { destination, branch } = folders();
    const head = git(destination, "rev-parse", "HEAD");

    const done = await applyFolderWork({ root: destination, branch, operationId: "batch-1" });

    expect(done).toEqual({ applied: true, reason: null });
    expect(git(destination, "rev-parse", "HEAD")).toBe(head);
    expect(git(destination, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(statusOf(destination)).toEqual([" D gone.ts", " M app.ts", "?? new.ts"]);
    expect(NodeFS.readFileSync(NodePath.join(destination, "app.ts"), "utf8")).toBe(
      "export const a = 2;\n",
    );
    // The same operation again changes nothing and gives the same answer.
    NodeFS.writeFileSync(NodePath.join(destination, "later.ts"), "export const later = 1;\n");
    expect(await applyFolderWork({ root: destination, branch, operationId: "batch-1" })).toEqual({
      applied: true,
      reason: null,
    });
    expect(NodeFS.existsSync(NodePath.join(destination, "later.ts"))).toBe(true);
  });

  it("leaves a folder with changes of its own alone: the files stay a branch, with the reason", async () => {
    const { destination, branch } = folders();
    NodeFS.writeFileSync(NodePath.join(destination, "mine.ts"), "export const mine = 1;\n");

    const done = await applyFolderWork({ root: destination, branch, operationId: "batch-1" });

    expect(done.applied).toBe(false);
    expect(done.reason).toContain("changes of its own");
    expect(statusOf(destination)).toEqual(["?? mine.ts"]);
    expect(git(destination, "rev-parse", "--verify", `refs/heads/${branch}`)).toHaveLength(40);
  });

  it("leaves a folder at another commit alone", async () => {
    const { destination, branch } = folders();
    NodeFS.writeFileSync(NodePath.join(destination, "ahead.ts"), "export const ahead = 1;\n");
    git(destination, "add", "-A");
    git(destination, "commit", "-q", "-m", "ahead");

    const done = await applyFolderWork({ root: destination, branch, operationId: "batch-1" });

    expect(done.applied).toBe(false);
    expect(done.reason).toContain("another commit");
    expect(statusOf(destination)).toEqual([""]);
  });

  const extra = (change: Record<string, unknown>) => ({
    kind: "branch",
    path: "",
    branch: null,
    status: "sent",
    arrivedAs: null,
    landed: "created",
    stays: null,
    detail: null,
    bytes: 10,
    includedCommits: 0,
    includedBranch: null,
    leftOut: [],
    leftOutNotListed: 0,
    ...change,
  });
  const sender = (applied: boolean, calls: Array<unknown>) =>
    makeFolderWorkSender({
      selfEnvironmentId: EnvironmentId.make("env-a"),
      selfLabel: "A",
      inventory: () =>
        Effect.succeed({
          scanLimited: false,
          repositories: [
            {
              path: "",
              notPushed: [],
              onlyHere: [{ branch: "feature", head: "a".repeat(40), commits: 2 }],
              branchesNotListed: 0,
              changedFiles: 2,
              untrackedFiles: 1,
              stashes: 0,
              leftOut: [],
              leftOutNotListed: 0,
            },
          ],
        }),
      sendExtras: (input: { readonly items: ReadonlyArray<unknown> }) =>
        Effect.sync(() => {
          calls.push({ sendExtras: input });
          return {
            items: [
              extra({ branch: "feature", arrivedAs: "swc/from-a/feature" }),
              extra({ kind: "uncommitted", arrivedAs: "swc/from-a/uncommitted-1" }),
            ],
          };
        }),
      apply: (_destination: unknown, request: unknown) =>
        Effect.sync(() => {
          calls.push({ apply: request });
          return {
            machineLabel: "B",
            applied,
            reason: applied ? null : "the folder has changes of its own",
          };
        }),
    } as never);
  const sendTo = {
    projectId: ProjectId.make("project-a"),
    destination: EnvironmentId.make("env-b"),
    destinationLabel: "B",
    operationId: "0a1b2c3d-1111-4222-8333-444455557777",
  } as never;

  it.effect(
    "sends the branches as branches and the uncommitted files as a snapshot the destination applies",
    () =>
      Effect.gen(function* () {
        const calls: Array<any> = [];
        const outcome = yield* sender(true, calls)(sendTo);

        expect(calls[0].sendExtras).toMatchObject({
          targetEnvironmentId: "env-b",
          operationId: "0a1b2c3d-1111-4222-8333-444455557777",
          items: [
            { kind: "branch", path: "", branch: "feature" },
            { kind: "uncommitted", path: "", sendAnyway: [] },
          ],
        });
        expect(calls[1].apply).toMatchObject({
          sourceEnvironmentId: "env-a",
          sourceProjectId: "project-a",
          branch: "swc/from-a/uncommitted-1",
          operationId: "0a1b2c3d-1111-4222-8333-444455557777",
        });
        expect(outcome.state).toBe("ready");
        expect(outcome.detail).toContain(
          "On B as branch swc/from-a/feature. To use it there, check it out or merge it.",
        );
        expect(outcome.detail).toContain("The uncommitted files are in B's working folder.");
      }),
  );

  it.effect(
    "says why files stayed a branch, and names the next step",
    () =>
      Effect.gen(function* () {
        const outcome = yield* sender(false, [])(sendTo);

        expect(outcome.state).toBe("ready");
        expect(outcome.detail).toContain(
          "On B as branch swc/from-a/uncommitted-1. Not put into the working folder: the folder has changes of its own. To use it there, check it out or merge it.",
        );
      }),
  );

  it.effect("the destination checks the work grant when the files would be written", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = two(rig);
      const request = {
        sourceEnvironmentId: a.environmentId,
        sourceLabel: "A",
        sourceProjectId: a.projectId,
        repositoryPath: "",
        operationId: "0a1b2c3d-1111-4222-8333-444455557777",
        branch: "swc/from-a/uncommitted-1",
      };

      const refused = yield* b
        .folderWork({ sourceEnvironmentId: a.environmentId, grant: null }, request)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ status: 403, code: "needs_grant", check: "grant" });
      const other = yield* b
        .folderWork(caller(a), { ...request, sourceEnvironmentId: b.environmentId })
        .pipe(Effect.flip);
      expect(other.status).toBe(403);

      // With the grant, the answer is about the folder: that branch never arrived.
      const answered = yield* b.folderWork(caller(a), request);
      expect(answered).toMatchObject({ machineLabel: "B", applied: false });
      expect(answered.reason).toContain("is not here");
    }),
  );
});

describe("the batch's window calls (AC-33)", () => {
  const tested = [WS_METHODS.handoffBatchStart, WS_METHODS.handoffBatchRead] as const;
  const group = WsAwayRpcGroup.omit(
    ...[...WsAwayRpcGroup.requests.keys()].filter(
      (tag) => !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const startInput = {
    destinationEnvironmentId: EnvironmentId.make("env-b"),
    start: "manual" as const,
    threads: [],
  };
  const clientWith = (scopes: ReadonlyArray<string>, handled: Array<string>) =>
    RpcTest.makeClient(group as never).pipe(
      Effect.provide(
        Layer.mergeAll(
          (group as any).toLayerHandler(WS_METHODS.handoffBatchStart, () =>
            Effect.sync(() => handled.push("start")).pipe(Effect.andThen(Effect.never)),
          ),
          (group as any).toLayerHandler(WS_METHODS.handoffBatchRead, () =>
            Effect.sync(() => {
              handled.push("read");
              return [];
            }),
          ),
          RpcAuthorization.layer(scopes as never),
        ) as never,
      ),
    ) as Effect.Effect<Record<string, (input: unknown) => Effect.Effect<unknown, unknown>>>;

  it("gives each call one scope from the existing set", () => {
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.handoffBatchStart)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.handoffBatchRead)).toBe(
      AuthFilesystemReadScope,
    );
  });

  it.effect("the server refuses to start a batch for a window that can only read", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith([AuthOrchestrationReadScope, AuthFilesystemReadScope], handled);

      expect(yield* client[WS_METHODS.handoffBatchRead]!({})).toEqual([]);
      expect(
        yield* client[WS_METHODS.handoffBatchStart]!(startInput).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual(["read"]);
    }).pipe(Effect.scoped),
  );

  it.effect("the server refuses to read a batch without filesystem:read", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* clientWith([AuthOrchestrationOperateScope], handled);

      expect(yield* client[WS_METHODS.handoffBatchRead]!({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthFilesystemReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
