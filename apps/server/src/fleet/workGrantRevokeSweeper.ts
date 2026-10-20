import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkGrants from "./WorkGrants.ts";

const SWEEP_INTERVAL = Duration.seconds(10);

/**
 * After a revoke's grace, interrupts every thread the revoked machine's work
 * started here (its subagents and forks stop with their thread). An
 * interrupt ends the run as the Stop button does: the thread, its worktree
 * and its checkpoints stay, so nothing it did is lost. Due revokes are read
 * from the grants file, so a restart during the grace still interrupts.
 */
export const sweepRevoked = Effect.gen(function* () {
  const grants = yield* WorkGrants.WorkGrants;
  if (!grants.enabled) return 0;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const now = yield* Clock.currentTimeMillis;
  const due = (yield* grants.policies).filter(
    (policy) =>
      policy.revokedAt !== null &&
      policy.interruptAt !== null &&
      policy.interruptedAt === null &&
      Date.parse(policy.interruptAt) <= now,
  );
  if (due.length === 0) return 0;
  const origins = yield* grants.origins;
  let interrupted = 0;
  for (const policy of due) {
    for (const origin of origins.filter(
      (entry) => entry.coordinatorEnvironmentId === policy.coordinatorEnvironmentId,
    )) {
      const threadId = ThreadId.make(origin.threadId);
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null || shell.activeRunId === null) continue;
      const result = yield* threads
        .interruptThread({
          projectId: ProjectId.make(shell.projectId),
          commandId: CommandId.make(
            `work-grant-revoke:${policy.coordinatorEnvironmentId}:${policy.revokedAt}:${threadId}`,
          ),
          threadId,
          reason: "The machine that started this work was revoked on this machine.",
        })
        .pipe(
          Effect.map(() => true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not interrupt work from a revoked machine.", {
              threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (result) interrupted += 1;
    }
    yield* grants.markInterrupted(EnvironmentId.make(policy.coordinatorEnvironmentId));
    yield* Effect.logInfo("Interrupted work from a revoked machine.", {
      coordinatorEnvironmentId: policy.coordinatorEnvironmentId,
    });
  }
  return interrupted;
});

export const layer = Layer.effectDiscard(
  sweepRevoked.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Revoked work sweep failed.", { cause }).pipe(Effect.as(0)),
    ),
    Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    Effect.forkScoped,
  ),
);
