/**
 * Feeds run updates to handoff mode and runs its timers: leases renew every
 * 30 seconds and running threads checkpoint every 5 minutes. Work boundaries
 * inside a turn checkpoint too: a child about to launch (where the provider
 * has a pre-launch hook), a child starting, a child's result arriving and a
 * provider session retiring.
 */
import {
  HANDOFF_LEASE_RENEW_MS,
  HANDOFF_LONG_TURN_CHECKPOINT_MS,
  isOrchestrationV2WorkActive,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { SubagentLaunchCheckpoints } from "../orchestration-v2/SubagentLaunchCheckpoints.ts";
import { forkParked } from "../serverActivation.ts";
import { HandoffMode } from "./HandoffMode.ts";

const TICKS_PER_CHECKPOINT = Math.max(
  1,
  Math.round(HANDOFF_LONG_TURN_CHECKPOINT_MS / HANDOFF_LEASE_RENEW_MS),
);

/** Boundaries remembered so each checkpoints once; old ones age out. */
const MAX_SEEN_BOUNDARIES = 2_000;

/**
 * The thread to checkpoint at a work boundary, keyed so each boundary counts
 * once: fan-out (a child starts), a child's terminal result, and a provider
 * session detaching before it retires. Quota percentages play no part.
 */
export function workBoundaryCheckpoint(
  event: OrchestrationV2DomainEvent,
): { readonly threadId: ThreadId; readonly key: string } | null {
  if (event.type === "subagent.updated") {
    const child = event.payload;
    const phase = isOrchestrationV2WorkActive(child.status)
      ? "started"
      : child.status === "idle"
        ? null
        : "settled";
    return phase === null
      ? null
      : { threadId: child.threadId, key: `subagent:${child.id}:${phase}` };
  }
  if (event.type === "provider-session.detached")
    return { threadId: event.threadId, key: `session:${event.payload.providerSessionId}` };
  return null;
}

/**
 * The checkpoint a provider awaits before it launches a native child
 * (Claude's PreToolUse on Agent). Providers without such a hook get only the
 * fan-out checkpoint once the child's first update lands. It never fails:
 * the launch goes ahead whatever happens here.
 */
export const launchCheckpoint =
  (handoff: Pick<HandoffMode["Service"], "checkpoint">) => (threadId: ThreadId) =>
    // Reason literals are a closed set older peers decode; this is an unscheduled interval.
    handoff.checkpoint(threadId, "interval").pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not checkpoint before a subagent launch", { threadId, cause }),
      ),
    );

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const handoff = yield* HandoffMode;
  yield* (yield* SubagentLaunchCheckpoints).serve(launchCheckpoint(handoff));

  const seen = new Set<string>();
  const processEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "run.created" || event.type === "run.updated")
      return handoff.observeRun(event.payload);
    const boundary = workBoundaryCheckpoint(event);
    if (boundary === null || seen.has(boundary.key)) return Effect.void;
    seen.add(boundary.key);
    if (seen.size > MAX_SEEN_BOUNDARIES) seen.delete(seen.values().next().value!);
    // Reason literals are a closed set older peers decode; this is an unscheduled interval.
    return handoff.checkpoint(boundary.threadId, "interval").pipe(Effect.ignore);
  };

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, processEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Handoff mode event stream failed", { cause }),
      ),
    ),
  );

  let tickCount = 0;
  yield* forkParked(
    Effect.suspend(() => {
      tickCount += 1;
      return handoff.tick({ checkpointRunning: tickCount % TICKS_PER_CHECKPOINT === 0 });
    }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(HANDOFF_LEASE_RENEW_MS))), Effect.asVoid),
  );
});
