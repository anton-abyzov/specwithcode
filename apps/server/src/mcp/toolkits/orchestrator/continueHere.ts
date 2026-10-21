import {
  type HandoffIncomingReplica,
  type OrchestratorMcpHandoffReadyListInput,
  type OrchestratorMcpHandoffReadyListResult,
  type OrchestratorMcpHandoffReadyThread,
  type OrchestratorMcpThreadContinueHereInput,
  type OrchestratorMcpThreadContinueHereResult,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as HandoffMode from "../../../handoff/HandoffMode.ts";
import { isLeaseStale } from "../../../handoff/handoffState.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { assertMayMigrate, handoffFailure } from "./migrate.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** The calling coordinator's project; replicas are matched only by its explicit link (0948). */
const callerProject = (tool: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    yield* McpInvocationContext.requireThreadScope(scope, tool);
    const context = yield* loadCaller();
    const caller = context.caller;
    if (caller === undefined) return yield* unavailable();
    return { context, caller } as const;
  });

const readyThread = (
  replica: HandoffIncomingReplica,
  now: number,
): OrchestratorMcpHandoffReadyThread => ({
  source: { environmentId: replica.sourceEnvironmentId, label: replica.sourceLabel },
  sourceThreadId: replica.sourceThreadId,
  title: replica.title,
  checkpointAt: replica.checkpoint.createdAt,
  branch: replica.checkpoint.branch,
  sourceUnreachable: replica.sourceUnreachable,
  sourceLastSeenAt: replica.sourceLastSeenAt,
  canContinueNow: replica.continuedThreadId === null && isLeaseStale(replica.lease, now),
  continuedThreadId: replica.continuedThreadId,
});

/** Threads other machines replicated here for this project, newest checkpoint first. */
export const listHandoffReady = (input: OrchestratorMcpHandoffReadyListInput) =>
  Effect.gen(function* () {
    const { caller } = yield* callerProject("studio_handoff_ready_list");
    const handoff = yield* HandoffMode.HandoffMode;
    const snapshot = yield* handoff.snapshot.pipe(Effect.mapError(handoffFailure));
    const now = yield* Clock.currentTimeMillis;
    const threads = snapshot.incoming
      .filter((replica) => replica.projectId === caller.projectId)
      .filter((replica) => input.includeContinued === true || replica.continuedThreadId === null)
      .toSorted((a, b) => b.checkpoint.createdAt.localeCompare(a.checkpoint.createdAt))
      .map((replica) => readyThread(replica, now));
    return {
      projectId: caller.projectId,
      threads,
    } satisfies OrchestratorMcpHandoffReadyListResult;
  });

const matchesMachine = (replica: HandoffIncomingReplica, machine: string) => {
  const wanted = machine.trim().toLowerCase();
  return (
    replica.sourceEnvironmentId.toLowerCase() === wanted ||
    replica.sourceLabel.trim().toLowerCase() === wanted
  );
};

/**
 * Continues one handoff-ready thread of this project on this machine, in one
 * call. The handoff service refuses while the source still renews its lease,
 * so two machines never run the same thread.
 */
export const continueHere = (input: OrchestratorMcpThreadContinueHereInput) =>
  Effect.gen(function* () {
    const { context, caller } = yield* callerProject("studio_thread_continue_here");
    yield* assertMayMigrate(context, caller);
    const handoff = yield* HandoffMode.HandoffMode;
    const snapshot = yield* handoff.snapshot.pipe(Effect.mapError(handoffFailure));
    const candidates = snapshot.incoming.filter(
      (replica) =>
        replica.sourceThreadId === input.sourceThreadId &&
        (input.machine === undefined || matchesMachine(replica, input.machine)),
    );
    if (candidates.length === 0) {
      return yield* failure(
        "thread_not_found",
        `This machine holds no handoff checkpoint of thread ${input.sourceThreadId}. Call studio_handoff_ready_list for the threads it can continue.`,
      );
    }
    if (candidates.length > 1) {
      return yield* failure(
        "invalid_request",
        `Machines ${candidates.map((replica) => replica.sourceLabel).join(" and ")} both replicated thread ${input.sourceThreadId}; name one with machine.`,
      );
    }
    const replica = candidates[0]!;
    if (replica.projectId !== caller.projectId) {
      return yield* failure(
        "capability_denied",
        replica.projectId === null
          ? `Thread ${input.sourceThreadId} from ${replica.sourceLabel} belongs to a project that is not linked to this one; link the projects first.`
          : `Thread ${input.sourceThreadId} from ${replica.sourceLabel} belongs to another project; a coordinator continues only its own project's threads.`,
      );
    }
    const continued = yield* handoff
      .continueHere({
        sourceEnvironmentId: replica.sourceEnvironmentId,
        sourceThreadId: replica.sourceThreadId,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      })
      .pipe(Effect.mapError(handoffFailure));
    return {
      source: { environmentId: replica.sourceEnvironmentId, label: replica.sourceLabel },
      sourceThreadId: replica.sourceThreadId,
      threadId: continued.threadId,
      machineLabel: continued.machineLabel,
      modelSelection: continued.modelSelection,
      notice: continued.notice,
    } satisfies OrchestratorMcpThreadContinueHereResult;
  });
