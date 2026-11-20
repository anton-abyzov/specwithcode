/**
 * Gives the limit handoff (0968) its port: a move is 0967's `handOff`.
 *
 * The persisted handoff document decides what an answer means, because only
 * it says whether anything moved. A thread that continues elsewhere (or whose
 * lease another machine holds) counts as moved; one still handing off, or a
 * machine that woke paused, is in doubt: nothing runs here and the same
 * target is asked again, which 0967's per-thread idempotency makes safe. Only
 * with the document untouched is an error a refusal, and its message is
 * shown per target as given ("Minis: no .env.local; Minis: Claude not signed
 * in").
 *
 * A move that went through also says why on the source thread: 0967 links it
 * to the continuation, and the adapter adds the note the move banner shows
 * ("Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5").
 *
 * @module LimitHandoffAdapter
 */
import {
  CommandId,
  type EnvironmentId,
  type HandOffInput,
  type HandOffResult,
  type HandoffModeError,
  type ThreadId,
} from "@specweave-studio/contracts";
import { formatModelSlugName } from "@specweave-studio/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { handoffLine } from "../handoff/handoffLine.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { type HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import type { PeerCheckRequest, PeerCheckResponse } from "../handoff/handoffPlan.ts";
import {
  HANDOFF_APP_VERSION,
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
} from "../handoff/handoffWire.ts";
import type { HandoffDocument } from "../handoff/handoffState.ts";
import { AUTOMATIC_OFF } from "../handoff/HandoffTransferRunner.ts";
import { turnRefusal } from "../handoff/HandoffTurnGate.ts";
import {
  type LimitHandoffOutcome,
  LimitHandoffPort,
  type LimitHandoffPortShape,
  type LimitHandoffRequest,
} from "./MachineLimitHandoff.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** The longest note a move link carries. */
const NOTE_MAX = 300;

export interface LimitHandoffAdapterDeps {
  readonly environmentId: EnvironmentId;
  /** This machine, as a check names it to the machine it asks. */
  readonly machineLabel?: string;
  /** The peer call that asks a machine what it would run a thread on (1390). */
  readonly check?: (
    environmentId: EnvironmentId,
    request: PeerCheckRequest,
  ) => Effect.Effect<PeerCheckResponse, HandoffPeerError>;
  readonly document: Effect.Effect<HandoffDocument, HandoffModeError>;
  readonly handOff: (input: HandOffInput) => Effect.Effect<HandOffResult, HandoffModeError>;
  /** Puts the note on the source thread's link to `continuation`; never fails the move. */
  readonly recordNote?: (input: {
    readonly threadId: ThreadId;
    readonly continuation: ThreadId;
    readonly note: string;
  }) => Effect.Effect<void>;
}

/**
 * The line both the source and its move banner show: "Hit 95% of Claude on
 * M4 · continued on Minis with Claude Opus 5.5", then what 0967 reported
 * (files not carried over). Pure, for tests.
 */
export function limitHandoffNote(
  request: LimitHandoffRequest,
  result: HandOffResult,
  at: { readonly atMs: number; readonly timeZone?: DateTime.TimeZone },
): string {
  const started = result.modelSelection ?? request.modelSelection;
  const model =
    started.model === request.modelSelection.model && request.modelLabel !== undefined
      ? request.modelLabel
      : formatModelSlugName(started.model);
  // The same line the destination writes (1390 AC-28), then the model and 0967's notice.
  const parts = [
    handoffLine({ machineLabel: result.machineLabel, reason: request.sourceSummary, ...at }),
    `with ${model}`,
    ...(result.notice === null ? [] : [result.notice]),
  ];
  const note = parts.join(" · ").trim();
  return note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1).trimEnd()}…`;
}

/**
 * Adds `note` to the source thread's handoff link once 0967 recorded it.
 * A thread linked elsewhere (or not linked) is left as it is.
 */
export const recordMoveNote = (input: {
  readonly threadId: ThreadId;
  readonly continuation: ThreadId;
  readonly note: string;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(input.threadId);
    const link = projection.thread.movedTo;
    if (link == null || link.kind !== "handoff" || link.threadId !== input.continuation) return;
    if (link.note === input.note) return;
    yield* orchestrator.dispatch({
      type: "thread.project-move.record",
      commandId: CommandId.make(`limit-handoff-note:${input.threadId}:${link.threadId}`),
      threadId: input.threadId,
      side: "source",
      link: { ...link, note: input.note },
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.limit-handoff.note-failed", {
        threadId: input.threadId,
        cause,
      }),
    ),
  );

const doubt = (message: string): LimitHandoffOutcome => ({ type: "in-doubt", message });

/**
 * What the handoff state already says about the thread: moved, in doubt, or
 * null when it is free to move. Pure, for tests.
 */
export function heldOutcome(
  document: HandoffDocument,
  threadId: ThreadId,
  environmentId: EnvironmentId,
): LimitHandoffOutcome | null {
  const record = document.threads[threadId];
  if (record === undefined) return null;
  if (record.continuedOn !== null) {
    return {
      type: "moved",
      machineLabel: record.continuedOn.machineLabel,
      threadId: record.continuedOn.threadId,
      notice: null,
    };
  }
  const lease = record.lease;
  if (lease !== null && lease.holderEnvironmentId !== environmentId) {
    return {
      type: "moved",
      machineLabel: lease.holderLabel,
      threadId: lease.holderThreadId === threadId ? null : lease.holderThreadId,
      notice: null,
    };
  }
  const refusal = turnRefusal(document, threadId, environmentId);
  return refusal === null ? null : { type: "in-doubt", message: refusal, heldByState: true };
}

/** An error from `handOff` once the document showed nothing moved or pending. */
export function errorOutcome(error: HandoffModeError, machineLabel: string): LimitHandoffOutcome {
  switch (error.code) {
    // Another copy already continued it: never run here, never asked again.
    case "fenced":
      return { type: "moved", machineLabel, threadId: null, notice: error.message };
    // Handoff still starting, or a move of this thread in flight.
    case "busy":
      return doubt(error.message);
    // Nothing moved (the document is untouched), so the next target may take it.
    case "unreachable":
      return { type: "refused", code: error.code, message: error.message, retryable: true };
    default:
      return { type: "refused", code: error.code, message: error.message, retryable: false };
  }
}

export function makeLimitHandoffPort(deps: LimitHandoffAdapterDeps): LimitHandoffPortShape {
  const held = (threadId: ThreadId) =>
    deps.document.pipe(
      Effect.map((document) => heldOutcome(document, threadId, deps.environmentId)),
      // An unreadable document may hide a move in flight.
      Effect.orElseSucceed(() => doubt("The handoff state could not be read.")),
    );
  const check = deps.check;
  const optedOut = (threadId: ThreadId) =>
    deps.document.pipe(
      Effect.map((document) => document.threads[threadId]?.mode === "off"),
      Effect.orElseSucceed(() => true),
    );
  return {
    available: true,
    // Only the thread's own Off opts out; the project default and On both let it start.
    // A preference that cannot be read starts nothing.
    optedOut,
    ...(check === undefined
      ? {}
      : ({
          check: (environmentId: EnvironmentId, input) =>
            check(environmentId, {
              sourceEnvironmentId: deps.environmentId,
              sourceLabel: (deps.machineLabel ?? deps.environmentId).slice(0, 120),
              protocolVersion: HANDOFF_PROTOCOL_VERSION,
              appVersion: HANDOFF_APP_VERSION,
              capabilities: HANDOFF_CAPABILITIES,
              ...input,
            }).pipe(
              Effect.map((response) => ({ kind: "answered" as const, response })),
              Effect.catch((error) =>
                Effect.succeed({
                  kind: "failed" as const,
                  error: { message: error.message, needsUpdate: error.needsUpdate === true },
                }),
              ),
            ),
        } satisfies Pick<LimitHandoffPortShape, "check">)),
    handOff: (request) =>
      Effect.gen(function* () {
        const before = yield* held(request.threadId);
        if (before !== null) return before;
        // Off is read again here, at the send: it may have been chosen while a machine
        // answered. The runner refuses it once more before the hold.
        if (yield* optedOut(request.threadId))
          return {
            type: "refused",
            code: "automatic_off",
            message: AUTOMATIC_OFF,
            retryable: true,
          } satisfies LimitHandoffOutcome;
        const answer = yield* deps
          .handOff({
            threadId: request.threadId,
            destinationEnvironmentId: request.destinationEnvironmentId,
            modelSelection: request.modelSelection,
            // The transfer record keeps who asked, for which run (the key names it)
            // and why, so a thread that arrives for a run is not sent straight
            // back for the same one and both machines can say why it left.
            trigger: {
              kind: "automatic",
              key: request.idempotencyKey.slice(0, 512),
              reason: request.sourceSummary.slice(0, 120),
              ...(request.usageWindowKey === undefined
                ? {}
                : { usageWindowKey: request.usageWindowKey.slice(0, 120) }),
              // The run and the disposition the move was admitted for; the runner
              // refuses it before the hold when the thread is no longer there.
              ...(request.runId === undefined ? {} : { runId: request.runId.slice(0, 256) }),
              disposition: request.resume ? "resume" : "ready",
            },
          })
          .pipe(Effect.result);
        if (answer._tag === "Success") {
          if (deps.recordNote !== undefined) {
            yield* deps.recordNote({
              threadId: request.threadId,
              continuation: answer.success.threadId,
              note: limitHandoffNote(request, answer.success, {
                atMs: DateTime.toEpochMillis(yield* DateTime.now),
              }),
            });
          }
          return {
            type: "moved",
            machineLabel: answer.success.machineLabel,
            threadId: answer.success.threadId,
            notice: answer.success.notice,
          } satisfies LimitHandoffOutcome;
        }
        const after = yield* held(request.threadId);
        if (after !== null) return after;
        return errorOutcome(
          answer.failure,
          request.destinationLabel ?? request.destinationEnvironmentId,
        );
      }).pipe(
        Effect.tap((outcome) =>
          Effect.logInfo("orchestration-v2.limit-handoff.port", {
            threadId: request.threadId,
            destination: request.destinationEnvironmentId,
            key: request.idempotencyKey,
            outcome: outcome.type,
            ...(outcome.type === "refused"
              ? { code: outcome.code, retryable: outcome.retryable }
              : {}),
          }),
        ),
      ),
  };
}

/** Provides the limit handoff port from handoff mode's moves. */
export const layer = Layer.effect(
  LimitHandoffPort,
  Effect.gen(function* () {
    const mode = yield* HandoffMode;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const peers = yield* HandoffPeers;
    return makeLimitHandoffPort({
      environmentId: mode.environmentId,
      machineLabel: mode.machineLabel,
      check: peers.check,
      document: mode.document,
      handOff: mode.handOff,
      recordNote: (input) =>
        recordMoveNote(input).pipe(
          Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        ),
    });
  }),
);
