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
});

// Through HandoffMoves

interface Rig {
  document: HandoffDocument;
  readonly heartbeats: Array<{ peer: EnvironmentId; request: HeartbeatRequest }>;
  readonly takeovers: Array<TakeoverRequest>;
  readonly dispatched: Array<{ readonly type: string }>;
  readonly down: Set<EnvironmentId>;
  activeRunId: string | null;
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
