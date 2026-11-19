import {
  EnvironmentId,
  type HandOffInput,
  type HandOffResult,
  HandoffModeError,
  type HandoffModeErrorCode,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { HandoffMode } from "../handoff/HandoffMode.ts";
import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import type { PeerCheckRequest } from "../handoff/handoffPlan.ts";
import { HANDOFF_CAPABILITIES, HANDOFF_PROTOCOL_VERSION } from "../handoff/handoffWire.ts";
import { PAUSED_OFFLINE_REFUSAL } from "../handoff/HandoffTurnGate.ts";

import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  type HandoffDocument,
  type HandoffThreadRecord,
} from "../handoff/handoffState.ts";
import {
  heldOutcome,
  layer,
  limitHandoffNote,
  makeLimitHandoffPort,
} from "./LimitHandoffAdapter.ts";
import { LimitHandoffPort, type LimitHandoffRequest } from "./MachineLimitHandoff.ts";
import * as Orchestrator from "./Orchestrator.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const threadId = ThreadId.make("t1");
const projectId = ProjectId.make("p1");
const at = "2026-10-20T14:00:00.000Z";

const request: LimitHandoffRequest = {
  threadId,
  projectId,
  destinationEnvironmentId: minis,
  destinationLabel: "Minis",
  modelSelection: { instanceId: ProviderInstanceId.make("own"), model: "opus" },
  reason: "usage-limit",
  resume: true,
  idempotencyKey: "limit-handoff:t1:r1",
  sourceSummary: "Claude limit reached on M4",
};

const withRecord = (patch: Partial<HandoffThreadRecord>): HandoffDocument => ({
  ...EMPTY_HANDOFF_DOCUMENT,
  threads: { [threadId]: { ...emptyThreadRecord(projectId), ...patch } },
});

const lease = (state: "active" | "handing-off" | "fenced", holder = m4) => ({
  holderEnvironmentId: holder,
  holderLabel: holder === m4 ? "M4" : "Minis",
  holderThreadId: holder === m4 ? threadId : ThreadId.make("remote-t1"),
  epoch: 3,
  renewedAt: at,
  state,
});

const continued = {
  environmentId: minis,
  machineLabel: "Minis",
  threadId: ThreadId.make("remote-t1"),
  at,
};

/**
 * A fake 0967: `answer` decides the call's result and may rewrite the
 * document first, the way a takeover that lost its answer leaves it.
 */
function harness(input: {
  readonly document?: HandoffDocument;
  readonly answer: (
    call: HandOffInput,
    doc: { current: HandoffDocument },
  ) => Effect.Effect<HandOffResult, HandoffModeError>;
}) {
  const doc = { current: input.document ?? EMPTY_HANDOFF_DOCUMENT };
  const calls: HandOffInput[] = [];
  const notes: Array<{ threadId: ThreadId; continuation: ThreadId; note: string }> = [];
  const port = makeLimitHandoffPort({
    environmentId: m4,
    document: Effect.sync(() => doc.current),
    handOff: (call) =>
      Effect.suspend(() => {
        calls.push(call);
        return input.answer(call, doc);
      }),
    recordNote: (note) => Effect.sync(() => void notes.push({ ...note })),
  });
  return { port, calls, doc, notes };
}

const fail = (code: HandoffModeErrorCode, message: string) =>
  Effect.fail(new HandoffModeError({ code, message }));

describe("LimitHandoffAdapter", () => {
  it.effect("the layer replaces the port that refuses every move", () =>
    Effect.gen(function* () {
      expect((yield* LimitHandoffPort).available).toBe(false);
      const provided = yield* Effect.gen(function* () {
        return yield* LimitHandoffPort;
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mock(HandoffMode)({
                environmentId: m4,
                machineLabel: "M4",
                document: Effect.succeed(EMPTY_HANDOFF_DOCUMENT),
              }),
            ),
            Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
            Layer.provide(Layer.mock(HandoffPeers)({})),
          ),
        ),
      );
      expect(provided.available).toBe(true);
    }),
  );

  it.effect("a move that succeeds is moved, asked once with 0967's input and its trigger", () =>
    Effect.gen(function* () {
      const { port, calls } = harness({
        answer: () =>
          Effect.succeed({
            environmentId: minis,
            machineLabel: "Minis",
            threadId: ThreadId.make("remote-t1"),
            modelSelection: request.modelSelection,
            notice: "Continued on Minis.",
          }),
      });
      expect(port.available).toBe(true);
      expect(yield* port.handOff(request)).toEqual({
        type: "moved",
        machineLabel: "Minis",
        threadId: "remote-t1",
        notice: "Continued on Minis.",
      });
      expect(calls).toEqual([
        {
          threadId,
          destinationEnvironmentId: minis,
          modelSelection: request.modelSelection,
          // What an automatic move back is weighed against on the other machine,
          // and why it left, for the transfer record and the line on both machines.
          trigger: {
            kind: "automatic",
            key: request.idempotencyKey,
            reason: "Claude limit reached on M4",
          },
        },
      ]);
    }),
  );

  it.effect("a failed preflight is refused for good with every failure, as given", () =>
    Effect.gen(function* () {
      const message = "Minis: no .env.local; Minis: Claude not signed in";
      for (const code of ["needs_grant", "invalid", "not_found", "not_a_repository"] as const) {
        const { port } = harness({ answer: () => fail(code, message) });
        expect(yield* port.handOff(request)).toEqual({
          type: "refused",
          code,
          message,
          retryable: false,
        });
      }
    }),
  );

  it.effect("fenced elsewhere counts as moved: no local fallback and no retry", () =>
    Effect.gen(function* () {
      const { port } = harness({
        answer: () => fail("fenced", "This thread already continues on M3."),
      });
      expect(yield* port.handOff(request)).toMatchObject({
        type: "moved",
        machineLabel: "Minis",
        threadId: null,
      });
      // The continuation the document names wins over the attempt's label.
      const named = harness({
        answer: (_, doc) =>
          Effect.suspend(() => {
            doc.current = withRecord({ lease: lease("fenced"), continuedOn: continued });
            return fail("fenced", "This thread already continues on Minis.");
          }),
      });
      expect(yield* named.port.handOff(request)).toEqual({
        type: "moved",
        machineLabel: "Minis",
        threadId: "remote-t1",
        notice: null,
      });
    }),
  );

  it.effect("a takeover that lost its answer is in doubt, whatever code came back", () =>
    Effect.gen(function* () {
      for (const code of ["unreachable", "failed"] as const) {
        const { port } = harness({
          answer: (_, doc) =>
            Effect.suspend(() => {
              doc.current = withRecord({ lease: lease("handing-off") });
              return fail(code, "Minis did not answer.");
            }),
        });
        expect((yield* port.handOff(request)).type).toBe("in-doubt");
      }
    }),
  );

  it.effect("busy is in doubt; a thread still handing off is not asked again", () =>
    Effect.gen(function* () {
      const starting = harness({ answer: () => fail("busy", "Handoff is still starting.") });
      expect(yield* starting.port.handOff(request)).toEqual({
        type: "in-doubt",
        message: "Handoff is still starting.",
      });
      const pending = harness({
        document: withRecord({ lease: lease("handing-off") }),
        answer: () => Effect.die("never asked"),
      });
      expect((yield* pending.port.handOff(request)).type).toBe("in-doubt");
      expect(pending.calls).toEqual([]);
    }),
  );

  it.effect("unreachable before anything moved lets the next target try", () =>
    Effect.gen(function* () {
      const { port } = harness({
        document: withRecord({ lease: lease("active") }),
        answer: () => fail("unreachable", "Minis did not answer."),
      });
      expect(yield* port.handOff(request)).toEqual({
        type: "refused",
        code: "unreachable",
        message: "Minis did not answer.",
        retryable: true,
      });
    }),
  );

  it.effect("a thread already continued or leased elsewhere is moved without asking", () =>
    Effect.gen(function* () {
      const done = harness({
        document: withRecord({ lease: lease("fenced"), continuedOn: continued }),
        answer: () => Effect.die("never asked"),
      });
      expect(yield* done.port.handOff(request)).toEqual({
        type: "moved",
        machineLabel: "Minis",
        threadId: "remote-t1",
        notice: null,
      });
      const leased = harness({
        document: withRecord({ lease: lease("active", minis) }),
        answer: () => Effect.die("never asked"),
      });
      expect(yield* leased.port.handOff(request)).toMatchObject({
        type: "moved",
        machineLabel: "Minis",
      });
      expect([...done.calls, ...leased.calls]).toEqual([]);
    }),
  );

  it.effect("a move puts why it moved on the source thread's link", () =>
    Effect.gen(function* () {
      const { port, notes } = harness({
        answer: () =>
          Effect.succeed({
            environmentId: minis,
            machineLabel: "Minis",
            threadId: ThreadId.make("remote-t1"),
            modelSelection: request.modelSelection,
            notice: null,
          }),
      });
      yield* port.handOff({
        ...request,
        reason: "threshold",
        sourceSummary: "Hit 95% of Claude on M4",
        modelLabel: "Claude Opus 5.5",
      });
      expect(notes).toEqual([
        {
          threadId,
          continuation: ThreadId.make("remote-t1"),
          note: "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5",
        },
      ]);
    }),
  );

  it.effect("a refusal, a doubt or an earlier move records no note", () =>
    Effect.gen(function* () {
      const refused = harness({ answer: () => fail("invalid", "Minis: no .env.local") });
      yield* refused.port.handOff(request);
      const doubted = harness({ answer: () => fail("busy", "Handoff is still starting.") });
      yield* doubted.port.handOff(request);
      const earlier = harness({
        document: withRecord({ lease: lease("fenced"), continuedOn: continued }),
        answer: () => Effect.die("never asked"),
      });
      yield* earlier.port.handOff(request);
      expect([...refused.notes, ...doubted.notes, ...earlier.notes]).toEqual([]);
    }),
  );

  it.effect("an unreadable handoff document is in doubt", () =>
    Effect.gen(function* () {
      const port = makeLimitHandoffPort({
        environmentId: m4,
        document: Effect.fail(new HandoffModeError({ code: "failed", message: "EACCES" })),
        handOff: () => Effect.die("never asked"),
      });
      expect((yield* port.handOff(request)).type).toBe("in-doubt");
    }),
  );
});

describe("heldOutcome", () => {
  it("is null for a thread handoff state does not hold", () => {
    expect(heldOutcome(EMPTY_HANDOFF_DOCUMENT, threadId, m4)).toBeNull();
    expect(heldOutcome(withRecord({ lease: lease("active") }), threadId, m4)).toBeNull();
  });

  it("holds a machine that woke paused with replicas", () => {
    const document: HandoffDocument = {
      ...withRecord({
        lease: lease("active"),
        replicas: [
          {
            environmentId: minis,
            machineLabel: "Minis",
            state: "current",
            sequence: 1,
            detail: null,
            updatedAt: at,
          },
        ],
      }),
      config: { ...EMPTY_HANDOFF_DOCUMENT.config, defaultMode: "on" },
      pausedSince: at,
    };
    expect(heldOutcome(document, threadId, m4)).toEqual({
      type: "in-doubt",
      message: PAUSED_OFFLINE_REFUSAL,
      heldByState: true,
    });
  });
});

describe("limitHandoffNote", () => {
  const result: HandOffResult = {
    environmentId: minis,
    machineLabel: "Minis",
    threadId: ThreadId.make("remote-t1"),
    modelSelection: null,
    notice: null,
  };
  const opus = { instanceId: ProviderInstanceId.make("own"), model: "claude-opus-5-5" };

  it("names the source's limit, the machine and the model", () => {
    expect(
      limitHandoffNote(
        { ...request, modelSelection: opus, modelLabel: "Claude Opus 5.5" },
        { ...result, modelSelection: opus },
      ),
    ).toBe("Claude limit reached on M4 · continued on Minis with Claude Opus 5.5");
  });

  it("names the model the destination started when it differs, and its notice", () => {
    expect(
      limitHandoffNote(
        { ...request, modelSelection: opus, modelLabel: "Claude Opus 5.5" },
        {
          ...result,
          modelSelection: { instanceId: ProviderInstanceId.make("own"), model: "claude-sonnet-5" },
          notice: "Not carried over: big.bin",
        },
      ),
    ).toBe(
      "Claude limit reached on M4 · continued on Minis with Claude Sonnet 5 · Not carried over: big.bin",
    );
    // Without a saved label the slug is spelled out.
    expect(limitHandoffNote({ ...request, modelSelection: opus }, result)).toBe(
      "Claude limit reached on M4 · continued on Minis with Claude Opus 5.5",
    );
  });

  it("stays within a move link's 300 characters", () => {
    const note = limitHandoffNote(request, { ...result, notice: "x".repeat(500) });
    expect(note.length).toBe(300);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("the automatic track start through the adapter (1390 T-13)", () => {
  const moved = () =>
    Effect.succeed({
      environmentId: minis,
      machineLabel: "Minis",
      threadId: ThreadId.make("remote-t1"),
      modelSelection: request.modelSelection,
      notice: null,
    });

  it.effect("carries the trigger key, the track's reason and the usage window (EC2-08)", () =>
    Effect.gen(function* () {
      const { port, calls, notes } = harness({ answer: moved });
      yield* port.handOff({
        ...request,
        track: "daily",
        sourceSummary: "Daily track out of tokens on M4",
        usageWindowKey: "2026-10-20T18:00:00.000Z",
      });
      expect(calls[0]?.trigger).toEqual({
        kind: "automatic",
        // The key names the run the move is for.
        key: "limit-handoff:t1:r1",
        reason: "Daily track out of tokens on M4",
        usageWindowKey: "2026-10-20T18:00:00.000Z",
      });
      // The line on the source thread says why it left (AC-28).
      expect(notes[0]?.note).toBe("Daily track out of tokens on M4 · continued on Minis with Opus");
    }),
  );

  it.effect("asks a machine with this machine's identity and capabilities", () =>
    Effect.gen(function* () {
      const asked: Array<PeerCheckRequest> = [];
      const port = makeLimitHandoffPort({
        environmentId: m4,
        machineLabel: "M4",
        document: Effect.succeed(EMPTY_HANDOFF_DOCUMENT),
        handOff: () => Effect.die("unused"),
        check: (environmentId, sent) =>
          environmentId === minis
            ? Effect.sync(() => {
                asked.push(sent);
                return { machineLabel: "Minis", capabilities: [...HANDOFF_CAPABILITIES], results: [] };
              })
            : Effect.fail(
                new HandoffPeerError({
                  code: "invalid",
                  message: "Needs update: OLD runs an older SpecWithCode.",
                  check: "version",
                  uncertain: false,
                  needsUpdate: true,
                }),
              ),
      });
      const input = {
        start: "automatic" as const,
        thresholdPercent: 95,
        threads: [
          {
            sourceThreadId: threadId,
            sourceProjectId: projectId,
            modelSelection: request.modelSelection,
            track: "daily" as const,
            driverKind: "claudeAgent",
            accountFingerprints: [`sha256:${"a".repeat(64)}`],
          },
        ],
      };
      expect(yield* port.check!(minis, input)).toMatchObject({
        kind: "answered",
        response: { machineLabel: "Minis" },
      });
      expect(asked[0]).toMatchObject({
        sourceEnvironmentId: m4,
        sourceLabel: "M4",
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        capabilities: HANDOFF_CAPABILITIES,
        ...input,
      });
      expect(asked[0]?.capabilities).toContain("handoff.track-start");
      // A machine with no check path is a failure that says so, never an answer.
      expect(yield* port.check!(EnvironmentId.make("env-old"), input)).toEqual({
        kind: "failed",
        error: { message: "Needs update: OLD runs an older SpecWithCode.", needsUpdate: true },
      });
    }),
  );

  it.effect("reads the thread's Hand off automatically: only Off opts out (AC-25)", () =>
    Effect.gen(function* () {
      const optedOut = (document: HandoffDocument) =>
        harness({ document, answer: moved }).port.optedOut!(threadId);
      expect(yield* optedOut(withRecord({ mode: "off" }))).toBe(true);
      expect(yield* optedOut(withRecord({ mode: "on" }))).toBe(false);
      expect(yield* optedOut(withRecord({ mode: "inherit" }))).toBe(false);
      expect(yield* optedOut(EMPTY_HANDOFF_DOCUMENT)).toBe(false);
    }),
  );
});
