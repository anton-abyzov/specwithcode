/**
 * Automatic continuation of handoff-mode threads (AC-10): the pure rules,
 * then the source and the designated machine through HandoffMoves with stub
 * peers, a stub receiver and an injected monotonic clock.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HandoffCheckpoint,
  type HandoffIncomingReplica,
  type HandoffRunEnding,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  AUTO_CONTINUE_FENCE_MARGIN_MS,
  AutoContinueMonotonicClock,
  autoContinueCandidates,
  autoContinueMinutes,
  designatedMachine,
  makeAutoContinueWatch,
  noteAnnounced,
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
} from "./handoffState.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";
import {
  HANDOFF_PROTOCOL_VERSION,
  type HeartbeatRequest,
  type TakeoverRequest,
} from "./handoffWire.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const m4 = EnvironmentId.make("env-m4");
const m1 = EnvironmentId.make("env-m1");
const m3 = EnvironmentId.make("env-m3");
const project = ProjectId.make("project-m4");
const m1Project = ProjectId.make("project-m1");
const thread = ThreadId.make("thread:fix-build");
const coordinatorThread = ThreadId.make(`project-coordinator:${project}`);

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

describe("automatic continuation rules", () => {
  it("is off at 0 and waits at least five minutes", () => {
    expect(autoContinueMinutes({ autoTakeoverMinutes: 0 })).toBeNull();
    expect(autoContinueMinutes({ autoTakeoverMinutes: 1 })).toBe(5);
    expect(autoContinueMinutes({ autoTakeoverMinutes: 15 })).toBe(15);
  });

  it("names the sleep target, else the active coordinator's standby, never a coordinator thread", () => {
    const standbyProject = {
      id: project,
      workspaceSettings: {
        coordinatorThreadId: coordinatorThread,
        coordinatorBinding: {
          epoch: 2,
          state: "active" as const,
          standby: {
            member: {
              environmentId: m3,
              projectId: ProjectId.make("project-m3"),
              coordinatorThreadId: ThreadId.make("project-coordinator:project-m3"),
            },
            afterMinutes: 15 as const,
            enabledAt: iso(T0),
          },
        },
      },
    };
    const base = { project: standbyProject, threadId: thread, self: m4 };
    expect(designatedMachine({ ...base, config: { sleepTarget: m1 } })).toBe(m1);
    expect(designatedMachine({ ...base, config: { sleepTarget: null } })).toBe(m3);
    expect(
      designatedMachine({
        ...base,
        config: { sleepTarget: null },
        project: {
          ...standbyProject,
          workspaceSettings: {
            ...standbyProject.workspaceSettings,
            coordinatorBinding: {
              ...standbyProject.workspaceSettings.coordinatorBinding,
              state: "transferred" as const,
            },
          },
        },
      }),
    ).toBeNull();
    expect(
      designatedMachine({ ...base, threadId: coordinatorThread, config: { sleepTarget: m1 } }),
    ).toBeNull();
    expect(designatedMachine({ ...base, config: { sleepTarget: m4 }, project: null })).toBeNull();
  });

  it("keeps the designation only on the copies the latest heartbeat named with a delay", () => {
    const document = destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 });
    const named: HeartbeatRequest = {
      sourceEnvironmentId: m4,
      sourceLabel: "M4",
      leases: [{ sourceThreadId: thread, epoch: 1, autoContinueMinutes: 15 }],
    };
    const [, designated] = heartbeatContinued(document, named, iso(T0 + MINUTE));
    expect(designated.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBe(15);
    // The source switched its sleep target to another machine: this copy is no longer named.
    const [, dropped] = heartbeatContinued(
      designated,
      { ...named, leases: [{ sourceThreadId: thread, epoch: 1 }] },
      iso(T0 + 2 * MINUTE),
    );
    expect(dropped.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
    // A heartbeat that leaves the thread out drops it too.
    const [, omitted] = heartbeatContinued(
      designated,
      { ...named, leases: [] },
      iso(T0 + 2 * MINUTE),
    );
    expect(omitted.incomingDetails?.[incomingKey(m4, thread)]?.autoContinueMinutes).toBeNull();
  });

  it("counts the source's silence from the first announcement and the shortest delay", () => {
    let peers = noteAnnounced({}, m1, 15, iso(T0));
    peers = noteAnnounced(peers, m1, 30, iso(T0 + MINUTE));
    expect(peers[m1]).toEqual({ minutes: 15, baselineAt: iso(T0) });
    peers = noteAnnounced(peers, m1, 5, iso(T0 + 2 * MINUTE));
    expect(peers[m1]).toEqual({ minutes: 5, baselineAt: iso(T0) });
    // Five minutes less the margin: 170 seconds.
    expect(5 * MINUTE - AUTO_CONTINUE_FENCE_MARGIN_MS).toBe(170_000);
    expect(peerPastFence(peers[m1], T0 + 169_999)).toBe(false);
    expect(peerPastFence(peers[m1], T0 + 170_000)).toBe(true);
    // An answer restarts the count; an answer to a heartbeat without a delay forgets the peer.
    peers = noteAnswered(peers, m1, 5, iso(T0 + 3 * MINUTE));
    expect(peerPastFence(peers[m1], T0 + 3 * MINUTE + 169_999)).toBe(false);
    expect(noteAnswered(peers, m1, null, iso(T0 + 4 * MINUTE))[m1]).toBeUndefined();
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

  it("continues only a named, running copy after the full delay heard while awake", () => {
    const at = (document: HandoffDocument, nowMs: number, watchingSinceMs = T0) =>
      autoContinueCandidates(document, { nowMs, watchingSinceMs, projectOf: noProject });
    const named = destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 });
    expect(at(named, T0 + 5 * MINUTE - 1)).toEqual([]);
    expect(at(named, T0 + 5 * MINUTE)).toEqual([
      { sourceEnvironmentId: m4, sourceThreadId: thread },
    ]);
    // A delay under five minutes is clamped.
    const short = destinationDocument({ autoContinueMinutes: 1, lastSeenMs: T0 });
    expect(at(short, T0 + 4 * MINUTE)).toEqual([]);
    // Not named, or named with no delay: never.
    expect(
      at(destinationDocument({ autoContinueMinutes: null, lastSeenMs: T0 }), T0 + 60 * MINUTE),
    ).toEqual([]);
    // The source was last heard before this watch began (this machine slept or restarted).
    expect(at(named, T0 + 60 * MINUTE, T0 + MINUTE)).toEqual([]);
    // A finished run has nothing to continue.
    expect(
      at(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0, runEnding: "completed" }),
        T0 + 60 * MINUTE,
      ),
    ).toEqual([]);
    // Coordinator threads, by id or by the member's recorded coordinator thread.
    expect(
      at(
        destinationDocument({
          autoContinueMinutes: 5,
          lastSeenMs: T0,
          sourceThreadId: coordinatorThread,
        }),
        T0 + 60 * MINUTE,
      ),
    ).toEqual([]);
    const renamed = ThreadId.make("thread:coordinator-renamed");
    expect(
      autoContinueCandidates(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0, sourceThreadId: renamed }),
        {
          nowMs: T0 + 60 * MINUTE,
          watchingSinceMs: T0,
          projectOf: () => ({
            workspaceSettings: {
              logicalProject: {
                members: [{ environmentId: m4, coordinatorThreadId: renamed }],
              },
            },
          }),
        },
      ),
    ).toEqual([]);
  });

  it("starts the watch again after sleep or a clock stepped backwards", () => {
    let mono = 0;
    const watch = makeAutoContinueWatch({ nowMs: () => mono }, T0);
    mono += 30_000;
    expect(watch.observe(T0 + 30_000)).toBe(T0);
    // Asleep for an hour: the wall clock ran on, the monotonic clock did not.
    mono += 30_000;
    expect(watch.observe(T0 + 60 * MINUTE)).toBe(T0 + 60 * MINUTE);
    mono += 30_000;
    expect(watch.observe(T0 + 60 * MINUTE + 30_000)).toBe(T0 + 60 * MINUTE);
    mono += 30_000;
    expect(watch.observe(T0 + 59 * MINUTE)).toBe(T0 + 59 * MINUTE);
  });
});

// Through HandoffMoves

interface Rig {
  document: HandoffDocument;
  readonly heartbeats: Array<{ peer: EnvironmentId; request: HeartbeatRequest }>;
  readonly takeovers: Array<TakeoverRequest>;
  readonly dispatched: Array<{ readonly type: string }>;
  readonly down: Set<EnvironmentId>;
  activeRunId: string | null;
  mono: number;
}

const rig = (document: HandoffDocument, self: EnvironmentId) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(T0);
    const state: Rig = {
      document,
      heartbeats: [],
      takeovers: [],
      dispatched: [],
      down: new Set(),
      activeRunId: "run-1",
      mono: 0,
    };
    const handoff = {
      environmentId: self,
      machineLabel: self === m4 ? "M4" : "M1",
      document: Effect.sync(() => state.document),
      updateDocument: <A>(change: (document: HandoffDocument) => readonly [A, HandoffDocument]) =>
        Effect.sync(() => {
          const [result, next] = change(state.document);
          state.document = next;
          return result;
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
          : Effect.succeed({ machineLabel: labels[peer]!, continued: [] });
      },
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
      Layer.succeed(ProjectService.ProjectService, {
        getById: (id: ProjectId) => Effect.succeedSome({ id, workspaceSettings: {} }),
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
        getThreadShell: (id: ThreadId) => Effect.succeed(id === thread ? shell() : null),
      } as never),
      Layer.succeed(AutoContinueMonotonicClock, { nowMs: () => state.mono }),
    );
    const moves = yield* HandoffMoves.make.pipe(Effect.provide(services));
    /** Thirty awake seconds: both clocks move. */
    const awake = (ms: number) =>
      Effect.gen(function* () {
        state.mono += ms;
        yield* TestClock.adjust(`${ms} millis`);
      });
    return { state, moves, awake };
  });

describe("automatic continuation between machines", () => {
  it.effect("names only the designated machine in heartbeats, with the delay", () =>
    Effect.gen(function* () {
      const { state, moves } = yield* rig(sourceDocument(), m4);
      yield* moves.heartbeat;
      const toM1 = state.heartbeats.find((entry) => entry.peer === m1)?.request.leases;
      const toM3 = state.heartbeats.find((entry) => entry.peer === m3)?.request.leases;
      expect(toM1).toEqual([{ sourceThreadId: thread, epoch: 1, autoContinueMinutes: 5 }]);
      expect(toM3).toEqual([{ sourceThreadId: thread, epoch: 1 }]);
    }),
  );

  it.effect("names no one when the setting is off or the thread is not in handoff mode", () =>
    Effect.gen(function* () {
      const off = sourceDocument();
      const { state, moves } = yield* rig(
        { ...off, config: { ...off.config, autoTakeoverMinutes: 0 } },
        m4,
      );
      yield* moves.heartbeat;
      expect(
        state.heartbeats.every((entry) =>
          entry.request.leases.every((lease) => lease.autoContinueMinutes === undefined),
        ),
      ).toBe(true);
      const notOn = sourceDocument();
      const other = yield* rig(
        {
          ...notOn,
          threads: { [thread]: { ...notOn.threads[thread]!, mode: "off" } },
        },
        m4,
      );
      yield* other.moves.heartbeat;
      expect(
        other.state.heartbeats.every((entry) =>
          entry.request.leases.every((lease) => lease.autoContinueMinutes === undefined),
        ),
      ).toBe(true);
    }),
  );

  it.effect("fences and interrupts the source once the designated machine goes quiet", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(sourceDocument(), m4);
      yield* moves.heartbeat;
      state.down.add(m1);
      // M3 still answers, so the older all-replicas-silent fence never fires here.
      for (let elapsed = 30_000; elapsed < 170_000; elapsed += 30_000) {
        yield* awake(30_000);
        yield* moves.heartbeat;
      }
      expect(state.document.threads[thread]?.autoFence ?? null).toBeNull();
      expect(state.dispatched).toEqual([]);
      yield* awake(20_000);
      yield* moves.heartbeat;
      expect(state.document.threads[thread]?.autoFence).toMatchObject({
        environmentId: m1,
        machineLabel: "M1",
      });
      expect(state.document.threads[thread]?.fencedBy).toBe("sleep");
      expect(state.dispatched).toEqual([
        expect.objectContaining({ type: "run.interrupt", threadId: thread, runId: "run-1" }),
      ]);
      expect(turnRefusal(state.document, thread, m4)).toContain("M1 is not answering");
      // M1 answers again: the fence lifts and turns start here once more.
      state.down.delete(m1);
      yield* awake(30_000);
      yield* moves.heartbeat;
      expect(state.document.threads[thread]?.autoFence).toBeNull();
      expect(turnRefusal(state.document, thread, m4)).toBeNull();
    }),
  );

  it.effect("keeps the fence across a restart with M1 still quiet", () =>
    Effect.gen(function* () {
      const first = yield* rig(sourceDocument(), m4);
      yield* first.moves.heartbeat;
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
    }),
  );

  it.effect("continues on the designated machine as an automatic takeover", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 }),
        m1,
      );
      state.down.add(m4);
      yield* awake(4 * MINUTE);
      yield* moves.replicate;
      expect(state.takeovers).toEqual([]);
      yield* awake(MINUTE);
      yield* moves.replicate;
      expect(state.takeovers).toEqual([
        expect.objectContaining({
          sourceEnvironmentId: m4,
          sourceThreadId: thread,
          reason: "auto-takeover",
          epoch: 2,
        }),
      ]);
    }),
  );

  it.effect("does not continue while the source still answers a direct probe", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 }),
        m1,
      );
      yield* awake(10 * MINUTE);
      yield* moves.replicate;
      expect(state.takeovers).toEqual([]);
    }),
  );

  it.effect("never continues after sleeping through the source's silence", () =>
    Effect.gen(function* () {
      const { state, moves, awake } = yield* rig(
        destinationDocument({ autoContinueMinutes: 5, lastSeenMs: T0 }),
        m1,
      );
      yield* awake(MINUTE);
      yield* moves.replicate;
      // The lid closed: an hour passes on the wall clock alone.
      yield* TestClock.adjust("60 minutes");
      yield* moves.replicate;
      yield* awake(30 * MINUTE);
      yield* moves.replicate;
      expect(state.takeovers).toEqual([]);
    }),
  );
});
