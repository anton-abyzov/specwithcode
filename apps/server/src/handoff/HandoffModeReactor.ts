/**
 * Feeds run updates to handoff mode and runs its timers: leases renew every
 * 30 seconds and running threads checkpoint every 5 minutes.
 */
import {
  HANDOFF_LEASE_RENEW_MS,
  HANDOFF_LONG_TURN_CHECKPOINT_MS,
  type OrchestrationV2DomainEvent,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { HandoffMode } from "./HandoffMode.ts";

const TICKS_PER_CHECKPOINT = Math.max(
  1,
  Math.round(HANDOFF_LONG_TURN_CHECKPOINT_MS / HANDOFF_LEASE_RENEW_MS),
);

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const handoff = yield* HandoffMode;

  const processEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.created" || event.type === "run.updated"
      ? handoff.observeRun(event.payload)
      : Effect.void;

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
