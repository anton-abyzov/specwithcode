/**
 * The one check the orchestrator makes before a turn starts on a thread in
 * handoff mode: a copy another machine continued, a lease another machine
 * holds, a transfer in flight, a copy whose automatic-continuation machine
 * went quiet, or a machine that lost its network while other machines hold
 * copies of its threads never starts a turn. Without handoff state every turn
 * is allowed (the default), so tests and servers that never use handoff mode
 * see no change.
 */
import type { ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { autoFenceRefusal } from "./HandoffAutoContinue.ts";
import * as HandoffModeStore from "./HandoffModeStore.ts";
import type { HandoffDocument } from "./handoffState.ts";

/**
 * Where a thread runs, as this machine's handoff state tells it: here, on the
 * machine it was handed off to, or unknown while that state does not read.
 */
export type ThreadContinuation =
  | { readonly kind: "here" }
  | { readonly kind: "moved"; readonly machineLabel: string }
  | { readonly kind: "unknown" };

export interface HandoffTurnGateShape {
  /** Null when a turn may start; otherwise the reason it may not. Never fails. */
  readonly check: (threadId: ThreadId) => Effect.Effect<string | null>;
  /**
   * The handoff note and transcript an idle continuation carries into its first
   * turn, or null. Never fails. Absent means none (test gates).
   */
  readonly pendingSeed?: (threadId: ThreadId) => Effect.Effect<string | null>;
  /**
   * Whether this copy of the thread still runs here, was handed off to another
   * machine, or cannot tell because the handoff state does not read. Never
   * fails. Absent means here (test gates).
   */
  readonly continuedOn?: (threadId: ThreadId) => Effect.Effect<ThreadContinuation>;
}

export class HandoffTurnGate extends Context.Reference<HandoffTurnGateShape>(
  "specweave-studio/handoff/HandoffTurnGate",
  {
    defaultValue: () => ({
      check: () => Effect.succeed(null),
      pendingSeed: () => Effect.succeed(null),
    }),
  },
) {}

/**
 * Whether a worker's routine may run on this machine, by the same rule as a
 * turn on its thread (1390 AC-45): it runs only when a turn could start here.
 * A thread handed off to a named machine rests the routine; any other refusal
 * (a lease another machine holds, a handoff without its answer yet, a paused
 * machine, a state that does not read) makes it wait.
 */
export type RoutineThreadPlace =
  | { readonly kind: "here" }
  | { readonly kind: "moved"; readonly machineLabel: string }
  | { readonly kind: "wait"; readonly reason: string };

export const HANDOFF_STATE_UNREAD_WAIT =
  "Waiting: this machine cannot read its handoff state, so its thread may have moved.";

export const routineThreadPlace = (
  gate: HandoffTurnGateShape,
  threadId: ThreadId,
): Effect.Effect<RoutineThreadPlace> =>
  Effect.gen(function* () {
    const continued =
      gate.continuedOn === undefined
        ? { kind: "here" as const }
        : yield* gate.continuedOn(threadId);
    if (continued.kind === "moved") return continued;
    if (continued.kind === "unknown")
      return { kind: "wait", reason: HANDOFF_STATE_UNREAD_WAIT } as const;
    const refusal = yield* gate.check(threadId);
    return refusal === null
      ? ({ kind: "here" } as const)
      : ({ kind: "wait", reason: `Waiting: its thread cannot run here now. ${refusal}` } as const);
  });

/** Why a turn may not start on this machine, or null. Pure, for tests. */
/** Why a thread waits after this machine paused on losing its network. */
export const PAUSED_OFFLINE_REFUSAL =
  "This machine lost its network while other machines hold copies of this thread, so one of them may have continued it. It starts no turn here until one of those machines answers; choose Resume this machine to run it here anyway.";

/** Why no turn starts while this machine's handoff file does not read. */
const UNREADABLE_STATE_REFUSAL =
  "This machine cannot read its handoff state, so another machine may have continued this thread. It starts no turn here until that state reads again.";

export function turnRefusal(
  document: HandoffDocument,
  threadId: string,
  environmentId: string,
): string | null {
  const record = document.threads[threadId];
  if (record === undefined) return null;
  if (record.continuedOn !== null) {
    return `This thread continues on ${record.continuedOn.machineLabel}; it no longer starts turns here.`;
  }
  const lease = record.lease;
  if (lease !== null) {
    if (lease.state === "fenced" || lease.holderEnvironmentId !== environmentId) {
      return `Another machine (${lease.holderLabel}) runs this thread now; this copy is read-only.`;
    }
    if (lease.state === "handing-off") {
      return "This thread is being handed off; it starts no turn until the handoff finishes.";
    }
  }
  const autoFenced = autoFenceRefusal(record);
  if (autoFenced !== null) return autoFenced;
  // Turning handoff off leaves the copies elsewhere continuable, so the mode does not matter.
  if (document.pausedSince !== null && lease !== null && record.replicas.length > 0) {
    return PAUSED_OFFLINE_REFUSAL;
  }
  return null;
}

export const layer = Layer.effect(
  HandoffTurnGate,
  Effect.gen(function* () {
    const store = yield* HandoffModeStore.HandoffModeStore;
    // Runtimes built without a server identity (tests) keep the default: every turn starts.
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    if (Option.isNone(environment)) return HandoffTurnGate.defaultValue();
    const environmentId = yield* environment.value.getEnvironmentId;
    return {
      check: (threadId: ThreadId) =>
        store.read.pipe(
          Effect.map((document) => turnRefusal(document, threadId, environmentId)),
          // A lease state that does not read may say another machine continued this
          // thread, so no turn starts until it reads again (1390 AC-36).
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff mode could not read its lease state", { cause }).pipe(
              Effect.as(UNREADABLE_STATE_REFUSAL),
            ),
          ),
        ),
      pendingSeed: (threadId: ThreadId) =>
        store.read.pipe(
          Effect.map((document) => document.threads[threadId]?.pendingSeed ?? null),
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff mode could not read a continuation's seed", {
              cause,
            }).pipe(Effect.as(null)),
          ),
        ),
      continuedOn: (threadId: ThreadId) =>
        store.read.pipe(
          Effect.map((document): ThreadContinuation => {
            const label = document.threads[threadId]?.continuedOn?.machineLabel;
            return label === undefined ? { kind: "here" } : { kind: "moved", machineLabel: label };
          }),
          // A state that does not read may say the thread moved: never "here" (1390 AC-45).
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff mode could not read where a thread runs", { cause }).pipe(
              Effect.as({ kind: "unknown" } as const),
            ),
          ),
        ),
    };
  }),
).pipe(Layer.provide(HandoffModeStore.layer));
