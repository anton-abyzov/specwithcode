/**
 * Silence never starts a handoff (1390 AC-36, T-23). No heartbeat names a
 * machine to continue on its own, and a named machine continues nothing. A
 * machine an earlier release armed is drained: it keeps its protective fence
 * until it answers a heartbeat that names no delay. The pure rules first,
 * then the source and the armed machine through HandoffMoves with stub peers
 * and a stub receiver, then both directions against the previous release
 * (`previousRelease.test.fixture.ts`).
 */
import { describe, expect, it } from "@effect/vitest";
import {
  AwaySession,
  type AwaySleepSession,
  EnvironmentId,
  type HandoffCheckpoint,
  type HandoffIncomingReplica,
  HandoffModeError,
  type HandoffRunEnding,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  settleSleepMoved,
  settleSleepNothingMoved,
  sleepSessionOf,
} from "../away/awaySleepSession.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  AUTO_CONTINUE_FENCE_MARGIN_MS,
  noteAnswered,
  peerPastFence,
  planSourceFence,
} from "./HandoffAutoContinue.ts";
import { HandoffMode } from "./HandoffMode.ts";
import * as HandoffMoves from "./HandoffMoves.ts";
import { HandoffPeerError, HandoffPeers } from "./handoffPeers.ts";
import { HandoffReceiver } from "./HandoffReceiver.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  HandoffDocument,
  type HandoffIncomingDetail,
  emptyThreadRecord,
  heartbeatContinued,
  incomingKey,
  markContinued,
  pendingDisarm,
} from "./handoffState.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";
import {
  HANDOFF_PROTOCOL_VERSION,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type TakeoverRequest,
} from "./handoffWire.ts";
import {
  PREVIOUS_RELEASE,
  previousAutoContinueCandidates,
  previousAutoContinueMinutes,
  previousHeartbeatContinued,
} from "./previousRelease.test.fixture.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const m4 = EnvironmentId.make("env-m4");
const m1 = EnvironmentId.make("env-m1");
const m3 = EnvironmentId.make("env-m3");
const project = ProjectId.make("project-m4");
const m1Project = ProjectId.make("project-m1");
const thread = ThreadId.make("thread:fix-build");

const checkpoint = (sequence: number, runEnding: HandoffRunEnding): HandoffCheckpoint =>
  ({
    sequence,
    commit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    branch: null,
    ref: `refs/specwithcode/handoff/${thread}`,
    createdAt: iso(T0),
    reason: "interval",
    skipped: [],
    excludedSecretCount: 0,
    transcriptMessageCount: 1,
    note: null,
    pushedToOrigin: false,
    epoch: 1,
    latestRunId: null,
    turnKey: null,
    runEnding,
    sideEffects: [],
    sourceRoot: {
      environmentId: m4,
      machineLabel: "M4",
      projectId: project,
      threadId: thread,
      workspaceRoot: "/repo",
      branch: null,
    },
  }) as HandoffCheckpoint;

const lease = (epoch = 1) => ({
  holderEnvironmentId: m4,
  holderLabel: "M4",
  holderThreadId: thread,
  epoch,
  renewedAt: iso(T0),
  state: "active" as const,
});

const replicaStatus = (environmentId: EnvironmentId, sequence: number | null) => ({
  environmentId,
  machineLabel: environmentId === m1 ? "M1" : "M3",
  state: "current" as const,
  sequence,
  detail: null,
  updatedAt: iso(T0),
});

/** The source's document: one handoff-mode thread it holds, replicated to M1 and M3. */
const sourceDocument = (
  overrides: { runEnding?: HandoffRunEnding; acknowledged?: number | null } = {},
): HandoffDocument => ({
  ...EMPTY_HANDOFF_DOCUMENT,
  config: { ...EMPTY_HANDOFF_DOCUMENT.config, sleepTarget: m1, autoTakeoverMinutes: 5 },
  threads: {
    [thread]: {
      ...emptyThreadRecord(project),
      mode: "on",
      lease: lease(),
      checkpoint: checkpoint(3, overrides.runEnding ?? "active"),
      replicas: [
        replicaStatus(m1, overrides.acknowledged === undefined ? 3 : overrides.acknowledged),
        replicaStatus(m3, 3),
      ],
    },
  },
});

const other = ThreadId.make("thread:other");

/** As an earlier release left a thread when the lid closed: handed to M1, no answer yet. */
const sleepPending = (
  record: HandoffDocument["threads"][string],
  epoch = 2,
): HandoffDocument["threads"][string] => ({
  ...record,
  lease: { ...record.lease!, state: "handing-off" },
  pendingTakeover: {
    destinationEnvironmentId: m1,
    request: {
      sourceEnvironmentId: m4,
      sourceThreadId: thread,
      epoch,
      sequence: 3,
      reason: "sleep",
      modelSelection: null,
    },
  },
});

/** The designated machine's document: one copy of the source's thread. */
const destinationDocument = (input: {
  autoContinueMinutes: number | null;
  lastSeenMs: number;
  sourceThreadId?: ThreadId;
  runEnding?: HandoffRunEnding;
}): HandoffDocument => {
  const sourceThreadId = input.sourceThreadId ?? thread;
  const replica: HandoffIncomingReplica = {
    sourceEnvironmentId: m4,
    sourceLabel: "M4",
    sourceThreadId,
    projectId: m1Project,
    title: "Fix the build",
    checkpoint: checkpoint(3, input.runEnding ?? "active"),
    lease: { ...lease(), holderThreadId: sourceThreadId, renewedAt: iso(input.lastSeenMs) },
    sourceLastSeenAt: iso(input.lastSeenMs),
    sourceUnreachable: false,
    receivedAt: iso(T0),
    continuedThreadId: null,
  };
  const detail = {
    sourceProjectId: project,
    repositoryPath: "/repo",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    transcript: [],
    execution: null,
    takeoverEpoch: null,
    takeover: null,
    sourceProtocolVersion: HANDOFF_PROTOCOL_VERSION,
    autoContinueMinutes: input.autoContinueMinutes,
  } as unknown as HandoffIncomingDetail;
  return {
    ...EMPTY_HANDOFF_DOCUMENT,
    incoming: [replica],
    incomingDetails: { [incomingKey(m4, sourceThreadId)]: detail },
  };
};

const noProject = () => null;

/** What a restart reads back: the document saved as JSON and decoded again. */
const reloaded = (document: HandoffDocument): HandoffDocument =>
  Schema.decodeUnknownSync(HandoffDocument)(
    JSON.parse(JSON.stringify(Schema.encodeSync(HandoffDocument)(document))),
  );

describe("silence rules", () => {
  it("a heartbeat that names a delay arms nothing here", () => {
    const document = destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 });
    const named: HeartbeatRequest = {
      sourceEnvironmentId: m4,
      sourceLabel: "M4",
      leases: [{ sourceThreadId: thread, epoch: 1, autoContinueMinutes: 15 }],
    };
    const [, heard] = heartbeatContinued(document, named, iso(T0 + MINUTE));
    expect(heard.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
    // A designation an earlier release saved here is dropped by the next heartbeat,
    // whether or not that heartbeat still names the delay.
    const saved = destinationDocument({ autoContinueMinutes: 15, lastSeenMs: T0 });
    for (const leases of [named.leases, [{ sourceThreadId: thread, epoch: 1 }], []]) {
      const [, dropped] = heartbeatContinued(saved, { ...named, leases }, iso(T0 + 2 * MINUTE));
      expect(dropped.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
    }
  });

  it("an armed machine fences from its last answer until it answers a heartbeat with no delay", () => {
    const peers = { [m1]: { minutes: 5, baselineAt: iso(T0) } };
    // Five minutes less the margin: 170 seconds.
    expect(5 * MINUTE - AUTO_CONTINUE_FENCE_MARGIN_MS).toBe(170_000);
    expect(peerPastFence(peers[m1], T0 + 169_999)).toBe(false);
    expect(peerPastFence(peers[m1], T0 + 170_000)).toBe(true);
    expect(noteAnswered(peers, m1)[m1]).toBeUndefined();
    expect(noteAnswered(peers, m3)).toEqual(peers);
  });

  it("lists the machines still to confirm, by the name their copy carries", () => {
    expect(pendingDisarm(sourceDocument())).toEqual([]);
    expect(
      pendingDisarm({
        ...sourceDocument(),
        autoContinuePeers: {
          [m1]: { minutes: 5, baselineAt: iso(T0) },
          "env-gone": { minutes: 15, baselineAt: iso(T0 + MINUTE) },
        },
      }),
    ).toEqual([
      { environmentId: m1, machineLabel: "M1", since: iso(T0) },
      { environmentId: "env-gone", machineLabel: "env-gone", since: iso(T0 + MINUTE) },
    ]);
    // Also a machine a thread here is still fenced for, and the destination of an
    // unanswered takeover a sleep started: either may still move a thread.
    const record = sourceDocument().threads[thread]!;
    expect(
      pendingDisarm({
        ...sourceDocument(),
        threads: {
          [thread]: {
            ...record,
            autoFence: { environmentId: m3, machineLabel: "M3", at: iso(T0 + 2 * MINUTE) },
          },
          [other]: sleepPending(record),
        },
      }),
    ).toEqual([
      { environmentId: m3, machineLabel: "M3", since: iso(T0 + 2 * MINUTE) },
      { environmentId: m1, machineLabel: "M1", since: iso(T0) },
    ]);
    // A takeover someone asked for is no hold from sleep or silence.
    const manual = sleepPending(record);
    expect(
      pendingDisarm({
        ...sourceDocument(),
        threads: {
          [other]: {
            ...manual,
            pendingTakeover: {
              ...manual.pendingTakeover!,
              request: { ...manual.pendingTakeover!.request, reason: "machine-handoff" },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("fences only threads the quiet machine could continue, and lifts once it answers", () => {
    const quiet = { [m1]: { minutes: 5, baselineAt: iso(T0) } };
    const now = T0 + 3 * MINUTE;
    const running = { ...sourceDocument(), autoContinuePeers: quiet };
    expect(planSourceFence(running, m4, now)).toEqual({
      fence: [{ threadId: thread, peer: m1 }],
      lift: [],
    });
    expect(planSourceFence(running, m4, T0 + 2 * MINUTE).fence).toEqual([]);
    // M1 acknowledged the newest checkpoint and it shows a finished run: nothing to continue.
    const finished = {
      ...sourceDocument({ runEnding: "completed" }),
      autoContinuePeers: quiet,
    };
    expect(planSourceFence(finished, m4, now).fence).toEqual([]);
    // A finished run M1 has not acknowledged yet still fences: its older copy may be running.
    const unacknowledged = {
      ...sourceDocument({ runEnding: "completed", acknowledged: 2 }),
      autoContinuePeers: quiet,
    };
    expect(planSourceFence(unacknowledged, m4, now).fence).toHaveLength(1);
    const fenced: HandoffDocument = {
      ...running,
      threads: {
        [thread]: {
          ...running.threads[thread]!,
          autoFence: { environmentId: m1, machineLabel: "M1", at: iso(now) },
        },
      },
    };
    expect(planSourceFence(fenced, m4, now)).toEqual({ fence: [], lift: [] });
    expect(planSourceFence({ ...fenced, autoContinuePeers: {} }, m4, now)).toEqual({
      fence: [],
      lift: [thread],
    });
  });

  it("keeps a fence when the quiet machine then acknowledges a finished checkpoint", () => {
    const quiet = { [m1]: { minutes: 5, baselineAt: iso(T0) } };
    const finished = sourceDocument({ runEnding: "completed" });
    const fenced: HandoffDocument = {
      ...finished,
      autoContinuePeers: quiet,
      threads: {
        [thread]: {
          ...finished.threads[thread]!,
          autoFence: { environmentId: m1, machineLabel: "M1", at: iso(T0) },
        },
      },
    };
    // M1 may have started on an older copy before it took this one: still fenced.
    expect(planSourceFence(fenced, m4, T0 + 3 * MINUTE)).toEqual({ fence: [], lift: [] });
    // Once M1's own answer disarms it, the fence lifts.
    expect(planSourceFence({ ...fenced, autoContinuePeers: {} }, m4, T0 + 3 * MINUTE)).toEqual({
      fence: [],
      lift: [thread],
    });
  });

  it("refuses turns on a fenced copy, and the fence survives a restart", () => {
    const document: HandoffDocument = {
      ...sourceDocument(),
      autoContinuePeers: { [m1]: { minutes: 5, baselineAt: iso(T0) } },
      threads: {
        [thread]: {
          ...sourceDocument().threads[thread]!,
          autoFence: { environmentId: m1, machineLabel: "M1", at: iso(T0) },
        },
      },
    };
    const reread = reloaded(document);
    expect(reread.threads[thread]?.autoFence?.environmentId).toBe(m1);
    expect(reread.autoContinuePeers).toEqual(document.autoContinuePeers);
    expect(turnRefusal(reread, thread, m4)).toBe(
      "M1 is not answering and may continue this thread. It starts no turn here until M1 answers.",
    );
    // A file from before the feature reads with no fence.
    const { autoContinuePeers: _peers, ...older } = Schema.encodeSync(HandoffDocument)(
      sourceDocument(),
    ) as Record<string, unknown>;
    const decoded = Schema.decodeUnknownSync(HandoffDocument)(older);
    expect(decoded.autoContinuePeers).toEqual({});
    expect(decoded.threads[thread]?.autoFence).toBeNull();
    expect(turnRefusal(decoded, thread, m4)).toBeNull();
  });
});

// Through HandoffMoves

interface Rig {
  document: HandoffDocument;
  readonly heartbeats: Array<{ peer: EnvironmentId; request: HeartbeatRequest }>;
  readonly takeovers: Array<TakeoverRequest>;
  /** Takeovers this machine sent another one. */
  readonly sent: Array<{ peer: EnvironmentId; request: TakeoverRequest }>;
  /**
   * How a machine answers a heartbeat. By default as this release does when nothing
   * started there: every operation asked about is not started.
   */
  answer: (peer: EnvironmentId, request: HeartbeatRequest) => HeartbeatResponse;
  readonly dispatched: Array<{ readonly type: string }>;
  readonly down: Set<EnvironmentId>;
  activeRunId: string | null;
  /** How each next read of the thread store goes; once empty, reads succeed. */
  readonly shellReads: Array<"ok" | "fail" | "die">;
  /** Writes the handoff file refuses, by the document they would save. */
  refuse: ((next: HandoffDocument) => boolean) | null;
  /** Every document a write saved, in order. */
  readonly history: Array<HandoffDocument>;
  /** Reading the project breaks. */
  projectDies: boolean;
}

const rig = (document: HandoffDocument, self: EnvironmentId) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const state: Rig = {
      document,
      heartbeats: [],
      takeovers: [],
      sent: [],
      answer: (peer, request) => ({
        machineLabel: peer === m1 ? "M1" : "M3",
        continued: [],
        notStarted: request.settle ?? [],
      }),
      dispatched: [],
      down: new Set(),
      activeRunId: "run-1",
      shellReads: [],
      refuse: null,
      history: [],
      projectDies: false,
    };
    const handoff = {
      environmentId: self,
      machineLabel: self === m4 ? "M4" : "M1",
      document: Effect.sync(() => state.document),
      updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
        Effect.suspend((): Effect.Effect<A, HandoffModeError> => {
          const [result, next] = change(state.document);
          if (state.refuse?.(next) === true) {
            return Effect.fail(
              new HandoffModeError({ code: "failed", message: "The handoff file did not save." }),
            );
          }
          state.document = next;
          state.history.push(next);
          return Effect.succeed(result);
        }),
    } as unknown as HandoffMode["Service"];
    const labels: Record<string, string> = { [m1]: "M1", [m3]: "M3", [m4]: "M4" };
    const peers = HandoffPeers.of({
      target: (environmentId: EnvironmentId) =>
        Effect.succeed({ machineId: environmentId, environmentId, label: labels[environmentId]! }),
      targets: Effect.succeed([]),
      heartbeat: (peer: EnvironmentId, request: HeartbeatRequest) => {
        state.heartbeats.push({ peer, request });
        return state.down.has(peer)
          ? Effect.fail(
              new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: true }),
            )
          : Effect.sync(() => state.answer(peer, request));
      },
      takeover: (peer: EnvironmentId, request: TakeoverRequest) =>
        Effect.sync(() => {
          state.sent.push({ peer, request });
          return {
            threadId: ThreadId.make("thread:continued"),
            machineLabel: labels[peer]!,
            modelSelection: null,
            resumed: true,
            notice: null,
          };
        }),
      // Continuing asks the source directly first: any answer means it still runs.
      negotiate: (peer: EnvironmentId) =>
        state.down.has(peer)
          ? Effect.fail(
              new HandoffPeerError({ code: "unreachable", message: "No answer.", uncertain: true }),
            )
          : Effect.succeed({ known: [] }),
    } as unknown as HandoffPeers["Service"]);
    const receiver = HandoffReceiver.of({
      takeover: (_caller: unknown, request: TakeoverRequest) =>
        Effect.sync(() => {
          state.takeovers.push(request);
          return {
            threadId: ThreadId.make("thread:continued"),
            machineLabel: "M1",
            modelSelection: null,
            resumed: true,
            notice: null,
          };
        }),
      attachPull: () => Effect.void,
    } as unknown as HandoffReceiver["Service"]);
    const shell = () => ({
      id: thread,
      projectId: project,
      title: "Fix the build",
      worktreePath: null,
      activeRunId: state.activeRunId,
      latestRunId: null,
      deletedAt: null,
    });
    const services = Layer.mergeAll(
      Layer.succeed(HandoffMode, handoff),
      Layer.succeed(HandoffPeers, peers),
      Layer.succeed(HandoffReceiver, receiver),
      // No project here, so a fence never runs Git in a folder of this test.
      Layer.succeed(ProjectService.ProjectService, {
        getById: () =>
          Effect.suspend((): Effect.Effect<Option.Option<never>> =>
            state.projectDies
              ? Effect.die("the project store broke")
              : Effect.succeed(Option.none()),
          ),
      } as never),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: (command: { type: string }) =>
          Effect.sync(() => {
            state.dispatched.push(command);
            if (command.type === "run.interrupt") state.activeRunId = null;
            return {};
          }),
      } as never),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getThreadShell: (id: ThreadId) =>
          Effect.suspend((): Effect.Effect<ReturnType<typeof shell> | null, HandoffModeError> => {
            const read = state.shellReads.shift() ?? "ok";
            if (read === "fail")
              return Effect.fail(
                new HandoffModeError({ code: "failed", message: "The thread store did not read." }),
              );
            if (read === "die") return Effect.die("the thread store broke");
            return Effect.succeed(id === thread ? shell() : null);
          }),
        getThread: () => Effect.succeed({ execution: null }),
      } as never),
    );
    const moves = yield* HandoffMoves.make.pipe(Effect.provide(services));
    /** Time this machine was awake for. */
    const awake = (ms: number) => TestClock.adjust(`${ms} millis`);
    return { state, moves, awake };
  });

const delays = (state: Rig) =>
  state.heartbeats.flatMap((entry) =>
    entry.request.leases.map((lease) => lease.autoContinueMinutes ?? null),
  );

/** The source's document as an earlier release left it: M1 armed, last heard at T0. */
const armedSourceDocument = (): HandoffDocument => ({
  ...sourceDocument(),
  autoContinuePeers: { [m1]: { minutes: 5, baselineAt: iso(T0) } },
});

describe("silence never starts a handoff (AC-36)", () => {
  it.effect("names no machine in heartbeats, whatever the saved settings say", () =>
    Effect.gen(function* () {
      // Saved by an earlier release: a sleep target and a five-minute automatic takeover.
      const { state, moves } = yield* rig(sourceDocument(), m4);
      expect(state.document.config).toMatchObject({ sleepTarget: m1, autoTakeoverMinutes: 5 });
      yield* moves.heartbeat;
      expect(state.heartbeats.map((entry) => entry.peer).sort()).toEqual([m1, m3]);
      expect(delays(state)).toEqual([null, null]);
      expect(state.document.autoContinuePeers).toEqual({});
      expect(pendingDisarm(state.document)).toEqual([]);
    }),
  );

  it.effect("drains a machine an earlier release armed once it answers", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(armedSourceDocument(), m4);
      yield* awake(30_000);
      yield* moves.heartbeat;
      // The heartbeat names no delay, so M1 dropped its designation before it answered.
      expect(delays(state)).toEqual([null, null]);
      expect(state.document.autoContinuePeers).toEqual({});
      expect(state.document.threads[thread]?.autoFence ?? null).toBeNull();
      expect(state.dispatched).toEqual([]);
    }),
  );

  it.effect("keeps the protective fence while an armed machine is unreachable", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(armedSourceDocument(), m4);
      state.down.add(m1);
      // M3 still answers, so the older all-replicas-silent fence never fires here.
      for (let elapsed = 30_000; elapsed < 170_000; elapsed += 30_000) {
        yield* awake(30_000);
        yield* moves.heartbeat;
      }
      expect(delays(state).every((delay) => delay === null)).toBe(true);
      expect(state.document.threads[thread]?.autoFence ?? null).toBeNull();
      expect(state.dispatched).toEqual([]);
      yield* awake(20_000);
      yield* moves.heartbeat;
      // M1 may still act on what it was told earlier: this copy stops, and the wait is shown.
      expect(state.document.threads[thread]?.autoFence).toMatchObject({
        environmentId: m1,
        machineLabel: "M1",
      });
      expect(state.dispatched).toEqual([
        expect.objectContaining({ type: "run.interrupt", threadId: thread, runId: "run-1" }),
      ]);
      expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
      expect(pendingDisarm(state.document)).toEqual([
        { environmentId: m1, machineLabel: "M1", since: iso(T0) },
      ]);
      // M1 answers the heartbeat that names no delay: disarmed, and turns start here again.
      state.down.delete(m1);
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.document.autoContinuePeers).toEqual({});
      expect(state.document.threads[thread]?.autoFence).toBeNull();
      expect(turnRefusal(state.document, thread, m4)).toBeNull();
      expect(pendingDisarm(state.document)).toEqual([]);
    }),
  );

  it.effect("keeps the fence across a restart with the armed machine still quiet", () =>
    Effect.gen(function* () {
      const first = yield* rig(armedSourceDocument(), m4);
      first.state.down.add(m1);
      yield* first.awake(3 * MINUTE);
      yield* first.moves.heartbeat;
      expect(first.state.document.threads[thread]?.autoFence).not.toBeNull();
      // A new process reads the saved document; nothing it has heard lifts the fence.
      const saved = reloaded(first.state.document);
      const second = yield* rig(saved, m4);
      second.state.down.add(m1);
      yield* TestClock.setTime(T0 + 3 * MINUTE + 30_000);
      yield* second.moves.heartbeat;
      expect(second.state.document.threads[thread]?.autoFence).not.toBeNull();
      expect(turnRefusal(second.state.document, thread, m4)).toContain("M1 is not answering");
      expect(pendingDisarm(second.state.document)).toHaveLength(1);
    }),
  );

  it.effect("an armed machine with no copy left to watch still hears it is disarmed", () =>
    Effect.gen(function* () {
      // The thread it was armed for is gone from here; nothing else would heartbeat M1.
      const { state, moves } = yield* rig({ ...armedSourceDocument(), threads: {} }, m4);
      yield* moves.heartbeat;
      expect(state.heartbeats).toEqual([
        { peer: m1, request: { sourceEnvironmentId: m4, sourceLabel: "M4", leases: [] } },
      ]);
      expect(state.document.autoContinuePeers).toEqual({});
    }),
  );

  it.effect("a copy named by an earlier heartbeat is never continued on silence", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 }),
        m1,
      );
      state.down.add(m4);
      for (let minute = 0; minute < 60; minute += 5) {
        yield* awake(5 * MINUTE);
        yield* moves.replicate;
      }
      expect(state.takeovers).toEqual([]);
    }),
  );
});

const continuedHere = {
  threadId: ThreadId.make("thread:continued"),
  machineLabel: "M1",
  modelSelection: null,
  resumed: true,
  notice: null,
};

/** M1 on the previous release answering from `remote()`, as its receiver does. */
const previousReceiver =
  (remote: () => HandoffDocument, keep: (next: HandoffDocument) => void) =>
  (peer: EnvironmentId, request: HeartbeatRequest): HeartbeatResponse => {
    if (peer !== m1) return { machineLabel: "M3", continued: [], notStarted: [] };
    // An earlier release decodes no `settle` and answers no `notStarted`.
    const { settle: _settle, ...heard } = request;
    const [continued, next] = previousHeartbeatContinued(remote(), heard, iso(T0));
    keep(next);
    return { machineLabel: "M1", continued };
  };

/** The source's document with `count` threads held here, each copied to M1. */
const manyThreads = (
  count: number,
  build: (record: HandoffDocument["threads"][string]) => HandoffDocument["threads"][string],
): HandoffDocument => {
  const record = { ...sourceDocument().threads[thread]!, replicas: [replicaStatus(m1, 3)] };
  const threads: Record<string, HandoffDocument["threads"][string]> = {};
  // The thread that matters comes last, past one full page.
  for (let index = 0; index < count - 1; index += 1) {
    threads[`thread:filler-${index}`] = build(record);
  }
  threads[thread] = build(record);
  return { ...sourceDocument(), threads };
};

describe("a hold from sleep or silence lifts only on its own answer (1390 AC-36)", () => {
  const sleepRequest: TakeoverRequest = {
    sourceEnvironmentId: m4,
    sourceThreadId: thread,
    epoch: 2,
    sequence: 3,
    reason: "sleep",
    modelSelection: null,
  };
  const heldBySleep = (): HandoffDocument => ({
    ...sourceDocument(),
    threads: { [thread]: sleepPending(sourceDocument().threads[thread]!) },
  });

  it.effect(
    "a heartbeat reaching the previous-release receiver mid-takeover keeps the source held; the next one fences it",
    () =>
      Effect.gen(function* () {
        const { state, moves, awake } = yield* rig(heldBySleep(), m4);
        state.activeRunId = null;
        // M1 received the takeover and saved its lease; it has not recorded it continued yet.
        let remote = destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 });
        state.answer = previousReceiver(
          () => remote,
          (next) => (remote = next),
        );
        yield* moves.heartbeat;
        const held = state.document.threads[thread];
        expect(held?.lease?.state).toBe("handing-off");
        expect(held?.pendingTakeover?.request).toEqual(sleepRequest);
        expect(pendingDisarm(state.document)).toEqual([
          { environmentId: m1, machineLabel: "M1", since: iso(T0) },
        ]);
        // Never sent again: a receiver on that release would start it.
        expect(state.sent).toEqual([]);
        // M1 finishes: the continuation is recorded, and the next heartbeat hears of it.
        remote = markContinued(remote, sleepRequest, continuedHere, iso(T0 + 10_000));
        yield* awake(30_000);
        yield* moves.heartbeat;
        const fenced = state.document.threads[thread];
        expect(fenced?.continuedOn?.threadId).toBe("thread:continued");
        expect(fenced?.lease?.state).toBe("fenced");
        expect(fenced?.pendingTakeover).toBeNull();
        expect(pendingDisarm(state.document)).toEqual([]);
        expect(state.sent).toEqual([]);
      }),
  );

  it.effect("this release's receiver: not started for that takeover gives the thread back", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(heldBySleep(), m4);
      state.activeRunId = null;
      // Not started, but for another epoch than the one held here: nothing changes.
      state.answer = (peer) => ({
        machineLabel: peer === m1 ? "M1" : "M3",
        continued: [],
        notStarted: [{ sourceThreadId: thread, epoch: 3 }],
      });
      yield* moves.heartbeat;
      expect(state.heartbeats.find((entry) => entry.peer === m1)?.request.settle).toEqual([
        { sourceThreadId: thread, epoch: 2 },
      ]);
      expect(state.document.threads[thread]?.lease?.state).toBe("handing-off");
      // The answer for exactly the takeover held here releases it.
      state.answer = (peer, request) => ({
        machineLabel: peer === m1 ? "M1" : "M3",
        continued: [],
        notStarted: request.settle ?? [],
      });
      yield* awake(30_000);
      yield* moves.heartbeat;
      const record = state.document.threads[thread];
      expect(record?.lease?.state).toBe("active");
      expect(record?.pendingTakeover).toBeNull();
      expect(record?.continuedOn).toBeNull();
      expect(state.sent).toEqual([]);
      expect(pendingDisarm(state.document)).toEqual([]);
    }),
  );

  it.effect(
    "an armed machine that answers after it may have acted keeps its fence until it settles the thread",
    () =>
      Effect.gen(function* () {
        const { state, moves, awake } = yield* rig(armedSourceDocument(), m4);
        state.down.add(m1);
        yield* awake(170_000);
        yield* moves.heartbeat;
        expect(state.document.threads[thread]?.autoFence?.environmentId).toBe(m1);
        // M1 comes back on the previous release: it answers, but cannot say it started nothing.
        state.down.delete(m1);
        let remote = destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 });
        state.answer = previousReceiver(
          () => remote,
          (next) => (remote = next),
        );
        yield* awake(30_000);
        yield* moves.heartbeat;
        const asked = state.heartbeats.filter((entry) => entry.peer === m1).at(-1);
        expect(asked?.request.settle).toEqual([{ sourceThreadId: thread, epoch: 2 }]);
        expect(state.document.autoContinuePeers?.[m1]).toBeDefined();
        expect(state.document.threads[thread]?.autoFence?.environmentId).toBe(m1);
        expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
        expect(pendingDisarm(state.document).map((entry) => entry.environmentId)).toEqual([m1]);
        // Updated, M1 says nothing started for it there: disarmed, and turns start here again.
        state.answer = (peer, request) => ({
          machineLabel: peer === m1 ? "M1" : "M3",
          continued: [],
          notStarted: request.settle ?? [],
        });
        yield* awake(30_000);
        yield* moves.heartbeat;
        expect(state.document.autoContinuePeers).toEqual({});
        expect(state.document.threads[thread]?.autoFence).toBeNull();
        expect(turnRefusal(state.document, thread, m4)).toBeNull();
        expect(pendingDisarm(state.document)).toEqual([]);
      }),
  );

  it.effect("thread 501, acted on by the previous release, is asked about and ends fenced", () =>
    Effect.gen(function* () {
      const document = manyThreads(501, sleepPending);
      const { state, moves, awake } = yield* rig(document, m4);
      state.activeRunId = null;
      let remote = markContinued(
        destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 }),
        sleepRequest,
        continuedHere,
        iso(T0),
      );
      state.answer = previousReceiver(
        () => remote,
        (next) => (remote = next),
      );
      yield* moves.heartbeat;
      const first = state.heartbeats.find((entry) => entry.peer === m1)!.request;
      expect(first.leases).toHaveLength(500);
      expect(first.leases.some((lease) => lease.sourceThreadId === thread)).toBe(false);
      // Not asked about, so not released: it never runs here while M1 runs it.
      expect(state.document.threads[thread]?.lease?.state).toBe("handing-off");
      yield* awake(30_000);
      yield* moves.heartbeat;
      const second = state.heartbeats.filter((entry) => entry.peer === m1)[1]!.request;
      expect(second.leases.some((lease) => lease.sourceThreadId === thread)).toBe(true);
      const record = state.document.threads[thread];
      expect(record?.continuedOn?.threadId).toBe("thread:continued");
      expect(record?.lease?.state).toBe("fenced");
      // The others were never answered for: each keeps its hold.
      expect(
        Object.entries(state.document.threads).filter(
          ([, entry]) => entry.lease?.state === "active",
        ),
      ).toEqual([]);
      expect(state.sent).toEqual([]);
    }),
  );

  it.effect("more threads than a page: each is asked about in turn", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(
        manyThreads(501, (record) => record),
        m4,
      );
      yield* moves.heartbeat;
      yield* awake(30_000);
      yield* moves.heartbeat;
      const asked = new Set(
        state.heartbeats
          .filter((entry) => entry.peer === m1)
          .flatMap((entry) => entry.request.leases.map((lease) => lease.sourceThreadId)),
      );
      expect(asked.size).toBe(501);
      expect(asked.has(thread)).toBe(true);
    }),
  );
});

const continuedOnM1 = {
  sourceThreadId: thread,
  epoch: 2,
  threadId: ThreadId.make("thread:continued"),
};

/** M1 after it continued the thread on its own: it names that continuation whenever asked. */
const answersContinued = (peer: EnvironmentId, request: HeartbeatRequest): HeartbeatResponse =>
  peer === m1
    ? {
        machineLabel: "M1",
        continued: request.leases.some((lease) => lease.sourceThreadId === thread)
          ? [continuedOnM1]
          : [],
      }
    : { machineLabel: "M3", continued: [], notStarted: request.settle ?? [] };

/** The turn gate this machine applies before a turn starts on the thread. */
const gateShut = (document: HandoffDocument) => turnRefusal(document, thread, m4) !== null;
const CONTINUES_ON_M1 = "This thread continues on M1; it no longer starts turns here.";

/**
 * The source after M1, armed and quiet past its fence, got the thread fenced here.
 * A turn the fence's interrupt did not stop still runs. M1 is back and says it
 * continued the thread; the writes from here on are recorded.
 */
const fencedForQuietM1 = Effect.gen(function* () {
  const setup = yield* rig(armedSourceDocument(), m4);
  setup.state.down.add(m1);
  yield* setup.awake(170_000);
  yield* setup.moves.heartbeat;
  expect(setup.state.document.threads[thread]?.autoFence?.environmentId).toBe(m1);
  setup.state.activeRunId = "run-2";
  setup.state.down.delete(m1);
  setup.state.answer = answersContinued;
  setup.state.history.length = 0;
  return setup;
});

describe("a machine that says it continued a thread fences it here for good (1390 AC-36)", () => {
  it.effect(
    "the fence is saved before the thread is read; a read that fails waits for the next beat",
    () =>
      Effect.gen(function* () {
        const { state, moves, awake } = yield* fencedForQuietM1;
        // The thread store does not read once, right after M1's answer.
        state.shellReads.push("fail");
        yield* awake(30_000);
        yield* moves.heartbeat;
        // No write in that heartbeat let a turn start here.
        expect(state.history.length).toBeGreaterThan(0);
        expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
        const record = state.document.threads[thread];
        expect(record?.continuedOn).toMatchObject({
          environmentId: m1,
          threadId: "thread:continued",
        });
        expect(record?.lease).toMatchObject({ state: "fenced", epoch: 2 });
        expect(turnRefusal(state.document, thread, m4)).toBe(CONTINUES_ON_M1);
        expect(state.dispatched).not.toContainEqual(
          expect.objectContaining({ type: "run.interrupt", runId: "run-2" }),
        );
        // M1 is unreachable on the next beat: what this machine saved finishes the stop.
        state.down.add(m1);
        yield* awake(30_000);
        yield* moves.heartbeat;
        expect(state.dispatched).toContainEqual(
          expect.objectContaining({ type: "run.interrupt", threadId: thread, runId: "run-2" }),
        );
        expect(state.dispatched).toContainEqual(
          expect.objectContaining({ type: "thread.project-move.record", threadId: thread }),
        );
        expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
        expect(pendingDisarm(state.document)).toEqual([]);
      }),
  );

  it.effect("a restart right after that answer reads the thread shut", () =>
    Effect.gen(function* () {
      const first = yield* fencedForQuietM1;
      first.state.shellReads.push("fail");
      yield* first.awake(30_000);
      yield* first.moves.heartbeat;
      const saved = reloaded(first.state.document);
      expect(turnRefusal(saved, thread, m4)).toBe(CONTINUES_ON_M1);
      // A new process over the saved file, with M1 silent again.
      const second = yield* rig(saved, m4);
      second.state.down.add(m1);
      yield* TestClock.setTime(T0 + 170_000 + 60_000);
      yield* second.moves.heartbeat;
      expect(second.state.history.filter((document) => !gateShut(document))).toEqual([]);
      expect(turnRefusal(second.state.document, thread, m4)).toBe(CONTINUES_ON_M1);
    }),
  );

  it.effect("a fence that does not save keeps every hold, and the machine stays armed", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* fencedForQuietM1;
      // The handoff file takes no write that records the continuation.
      state.refuse = (next) => (next.threads[thread]?.continuedOn ?? null) !== null;
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
      expect(state.document.autoContinuePeers?.[m1]).toBeDefined();
      expect(state.document.threads[thread]?.autoFence?.environmentId).toBe(m1);
      expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
      expect(pendingDisarm(state.document).map((entry) => entry.environmentId)).toEqual([m1]);
      // Once the file takes writes again, the same answer fences the thread.
      state.refuse = null;
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.document.threads[thread]?.continuedOn?.threadId).toBe("thread:continued");
      expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
    }),
  );

  it.effect("stopping the turn here fails: the thread stays shut, the next beat finishes", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* fencedForQuietM1;
      // The thread reads and the interrupt goes out; then the store breaks while the
      // interrupt waits for the turn to end.
      state.shellReads.push("ok", "die");
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
      // M1 is unreachable next, so nothing it says decides this.
      state.down.add(m1);
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
      expect(turnRefusal(state.document, thread, m4)).toBe(CONTINUES_ON_M1);
      expect(state.dispatched).toContainEqual(
        expect.objectContaining({ type: "thread.project-move.record", threadId: thread }),
      );
    }),
  );

  it.effect("keeping this machine's changes fails: the thread stays shut", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* fencedForQuietM1;
      state.projectDies = true;
      yield* awake(30_000);
      yield* moves.heartbeat;
      state.down.add(m1);
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.history.filter((document) => !gateShut(document))).toEqual([]);
      expect(turnRefusal(state.document, thread, m4)).toBe(CONTINUES_ON_M1);
    }),
  );

  it.effect("a quiet machine's fence saves when the thread does not read; the turn stops", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(armedSourceDocument(), m4);
      state.down.add(m1);
      // The thread store does not read when M1 passes its fence.
      state.shellReads.push("fail");
      yield* awake(170_000);
      yield* moves.heartbeat;
      expect(state.document.threads[thread]?.autoFence?.environmentId).toBe(m1);
      expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
      expect(state.dispatched).toEqual([]);
      // M1 is still quiet: the turn the fence missed stops on the next beat.
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.dispatched).toEqual([
        expect.objectContaining({ type: "run.interrupt", threadId: thread, runId: "run-1" }),
      ]);
      expect(state.document.threads[thread]?.fencedBy).toBe("sleep");
      expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
    }),
  );
});

describe("a lid close an earlier release sent (Away)", () => {
  const sleep: AwaySleepSession = {
    state: "pending-intent",
    targetEnvironmentId: m1,
    graceMinutes: 5,
    projectIds: [],
    threadIds: [thread],
    sentAt: iso(T0),
    dueAt: iso(T0 + 5 * MINUTE),
  };
  /** The session that release saved when the lid closed. */
  const lidClose = (intent: AwaySleepSession = sleep): AwaySession =>
    sleepSessionOf({
      sessionId: "away-1",
      targetEnvironmentId: m1,
      targetLabel: "M1",
      coordinatorScope: "live",
      sleep: intent,
      facts: { projectTitles: new Map(), threadTitles: new Map(), handoffOff: [] },
    });
  const withSession = (session: unknown): HandoffDocument => ({
    ...sourceDocument(),
    awaySession: session,
  });
  const saved = (session: AwaySession) => withSession(Schema.encodeSync(AwaySession)(session));
  const waitsOnM1 = [{ environmentId: m1, machineLabel: "M1", since: iso(T0) }];
  const wokeAt = iso(T0 + 10 * MINUTE);

  it("names its target, through a restart, until the wake check finds nothing moved", () => {
    expect(pendingDisarm(saved(lidClose()))).toEqual(waitsOnM1);
    expect(pendingDisarm(reloaded(saved(lidClose())))).toEqual(waitsOnM1);
    // No answer to the send, a refused send, and Run here anyway all leave the intent
    // with M1, or its outcome unsettled: still listed.
    for (const state of ["send-uncertain", "send-failed"] as const) {
      expect(pendingDisarm(saved(lidClose({ ...sleep, state })))).toEqual(waitsOnM1);
    }
    const forced = lidClose({
      ...sleep,
      wokeAt,
      unreachableSince: wokeAt,
      forcedLocalAt: iso(T0 + 20 * MINUTE),
    });
    expect(pendingDisarm(saved(forced))).toEqual(waitsOnM1);
    // A session this version cannot decode still names its target.
    expect(
      pendingDisarm(
        withSession({
          trigger: "sleep",
          targetLabel: "M1",
          broughtBackAt: null,
          sleep: { state: "pending-intent", targetEnvironmentId: m1, sentAt: iso(T0) },
        }),
      ),
    ).toEqual(waitsOnM1);
    // The wake check found nothing moved: the session closes and drops its intent.
    const { sleep: _dropped, ...closed } = settleSleepNothingMoved(lidClose(), wokeAt, new Map());
    expect(pendingDisarm(saved(closed))).toEqual([]);
  });

  it("clears once the wake check records what moved, or Bring back ran", () => {
    const open = lidClose();
    expect(pendingDisarm(saved(open))).toEqual(waitsOnM1);
    const moved: AwaySession = {
      ...settleSleepMoved(open, wokeAt, [], new Map([[thread as string, "thread:continued"]])),
      sleep: { ...sleep, state: "wake-prompt", wokeAt },
    };
    expect(pendingDisarm(saved(moved))).toEqual([]);
    expect(pendingDisarm(saved({ ...open, broughtBackAt: wokeAt }))).toEqual([]);
    // A Leave pressed by hand is no lid close.
    expect(pendingDisarm(saved({ ...open, trigger: "manual" }))).toEqual([]);
  });
});

describe(`against the previous release (${PREVIOUS_RELEASE})`, () => {
  /** What this version's source sends M1 on its first heartbeat after the update. */
  const heartbeatAfterUpdate = Effect.gen(function* () {
    const { state, moves } = yield* rig(armedSourceDocument(), m4);
    yield* moves.heartbeat;
    const sent = state.heartbeats.find((entry) => entry.peer === m1)?.request;
    if (sent === undefined) throw new Error("no heartbeat reached M1");
    return sent;
  });
  /** M1 on the previous release, armed by the source's last heartbeat before it updated. */
  const armedReceiver = (lastSeenMs = T0) =>
    destinationDocument({ autoContinueMinutes: 5, lastSeenMs });
  const candidates = (document: HandoffDocument, nowMs: number, watchingSinceMs = T0) =>
    previousAutoContinueCandidates(document, { nowMs, watchingSinceMs, projectOf: noProject });

  it.effect(
    "this source, an armed receiver on the previous release: the heartbeat disarms it",
    () =>
      Effect.gen(function* () {
        expect(PREVIOUS_RELEASE).toBe("v1.0.378");
        // Armed, it would continue the copy after five quiet minutes.
        expect(candidates(armedReceiver(), T0 + 5 * MINUTE)).toHaveLength(1);
        const sent = yield* heartbeatAfterUpdate;
        expect(sent.leases).toEqual([{ sourceThreadId: thread, epoch: 1 }]);
        const [continued, disarmed] = previousHeartbeatContinued(
          armedReceiver(),
          sent,
          iso(T0 + 30_000),
        );
        expect(continued).toEqual([]);
        expect(disarmed.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
        // The lid closes right after: however long the silence, it starts nothing.
        expect(candidates(disarmed, T0 + 24 * 60 * MINUTE)).toEqual([]);
      }),
  );

  it.effect(
    "an armed receiver offline through the update and the lid close: held, shown, never run twice",
    () =>
      Effect.gen(function* () {
        const { state, moves, awake } = yield* rig(armedSourceDocument(), m4);
        // M1 hears nothing from the updated source: no heartbeat can disarm it.
        state.down.add(m1);
        yield* awake(170_000);
        yield* moves.heartbeat;
        // Before M1 could act (five minutes), this copy already stopped and says why.
        expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
        expect(pendingDisarm(state.document)).toEqual([
          { environmentId: m1, machineLabel: "M1", since: iso(T0) },
        ]);
        expect(candidates(armedReceiver(), T0 + 170_000)).toEqual([]);
        // A receiver that was asleep or restarted while offline starts nothing on its own.
        expect(candidates(armedReceiver(), T0 + 60 * MINUTE, T0 + 10 * MINUTE)).toEqual([]);
        // One that stayed awake behind a partition may still continue: this version
        // cannot retract that from here, so it promises a hold, not zero starts.
        expect(candidates(armedReceiver(), T0 + 5 * MINUTE)).toEqual([
          { sourceEnvironmentId: m4, sourceThreadId: thread },
        ]);
        expect(state.document.threads[thread]?.autoFence).not.toBeNull();
      }),
  );

  it.effect("a receiver that already continued before its answer was lost still says so", () =>
    Effect.gen(function* () {
      const request: TakeoverRequest = {
        sourceEnvironmentId: m4,
        sourceThreadId: thread,
        epoch: 2,
        sequence: 3,
        reason: "auto-takeover",
        modelSelection: null,
      };
      const acted = markContinued(
        armedReceiver(),
        request,
        {
          threadId: ThreadId.make("thread:continued"),
          machineLabel: "M1",
          modelSelection: null,
          resumed: true,
          notice: null,
        },
        iso(T0 + 5 * MINUTE),
      );
      // The updated source's heartbeat names no delay; the old receiver answers what it did.
      const sent = yield* heartbeatAfterUpdate;
      expect(sent.leases).toEqual([{ sourceThreadId: thread, epoch: 1 }]);
      const [continued] = previousHeartbeatContinued(acted, sent, iso(T0 + 6 * MINUTE));
      expect(continued).toEqual([
        { sourceThreadId: thread, epoch: 2, threadId: "thread:continued" },
      ]);
      // And this version, as that receiver, answers the same for a takeover it made earlier.
      const [here] = heartbeatContinued(acted, sent, iso(T0 + 6 * MINUTE));
      expect(here).toEqual(continued);
    }),
  );

  it.effect(
    "a source on the previous release names this machine: nothing is armed or started",
    () =>
      Effect.gen(function* () {
        const minutes = previousAutoContinueMinutes({ autoTakeoverMinutes: 5 });
        expect(minutes).toBe(5);
        const named: HeartbeatRequest = {
          sourceEnvironmentId: m4,
          sourceLabel: "M4",
          leases: [{ sourceThreadId: thread, epoch: 1, autoContinueMinutes: minutes! }],
        };
        const { state, moves, awake } = yield* rig(
          destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 }),
          m1,
        );
        const [, heard] = heartbeatContinued(state.document, named, iso(T0));
        expect(heard.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
        // The previous release would have armed itself on the same heartbeat.
        const [, armed] = previousHeartbeatContinued(state.document, named, iso(T0));
        expect(armed.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBe(5);
        state.document = heard;
        state.down.add(m4);
        yield* awake(30 * MINUTE);
        yield* moves.replicate;
        expect(state.takeovers).toEqual([]);
      }),
  );
});
