/**
 * The one check the orchestrator makes before a turn starts on a thread in
 * handoff mode: a copy another machine continued, a lease another machine
 * holds, a transfer in flight, or a machine that woke fenced never starts a
 * turn. Without handoff state every turn is allowed (the default), so tests
 * and servers that never use handoff mode see no change.
 */
import type { ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HandoffModeStore from "./HandoffModeStore.ts";
import { effectiveHandoffMode, type HandoffDocument } from "./handoffState.ts";

export interface HandoffTurnGateShape {
  /** Null when a turn may start; otherwise the reason it may not. Never fails. */
  readonly check: (threadId: ThreadId) => Effect.Effect<string | null>;
}

export class HandoffTurnGate extends Context.Reference<HandoffTurnGateShape>(
  "specweave-studio/handoff/HandoffTurnGate",
  { defaultValue: () => ({ check: () => Effect.succeed(null) }) },
) {}

/** Why a turn may not start on this machine, or null. Pure, for tests. */
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
  if (
    document.pausedSince !== null &&
    lease !== null &&
    record.replicas.length > 0 &&
    effectiveHandoffMode(document, record.projectId, record.mode) !== "off"
  ) {
    return "This machine woke after handing its threads off and no other machine answered yet. Choose Continue here anyway to run it here.";
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
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff mode could not read its lease state", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
    };
  }),
).pipe(Layer.provide(HandoffModeStore.layer));
