import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { localChildOwnership } from "./ChildMachineHandoff.ts";
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  latestRootProviderFailure,
  runRanAfter,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { cancelledForUpdate } from "./RestartQueueHold.ts";
import {
  AGENT_STOP_PROGRESS,
  isOpenWorkStatus,
  lostWorkNoteEvents,
  openNativeSubagentWork,
  outageProgress,
  PERSON_STOP_PROGRESS,
  settleNativeSubagents,
  settleRunlessRootTurns,
  subagentProviderThreadId,
  type SubagentSettlementStatus,
} from "./SubagentSettlement.ts";
import { SYSTEM_INTERRUPT_REASONS } from "./systemInterruptReasons.ts";

/**
 * Settles provider-native subagents that nothing will ever report on: their
 * thread has no run in progress and no live provider process runs them any
 * more (it exited, hit a limit, or was replaced). Restart recovery does this
 * at startup; this sweep does it while the server keeps running.
 *
 * A thread is settled only when two sweeps in a row find the same open work
 * with no live process, so a process that is just starting or reporting is
 * never cut short. The cause comes from how the thread's latest run ended: a
 * person's Stop is final (`cancelled`, "Stopped by you"); anything else is an
 * outage (`interrupted`), and the parent's next turn is told which subagents
 * it lost so it can rerun or finish them.
 */

export const STRANDED_SUBAGENT_SWEEP_INTERVAL = "1 minute";

const BLOCKING_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

interface SettlementCause {
  readonly status: SubagentSettlementStatus;
  readonly progress: string;
}

/** A short stable digest, so a command id names the exact work it settled. */
function digest(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** The latest run any provider saw: the one whose end also ended its process. */
function latestStartedRun(runs: ReadonlyArray<OrchestrationV2Run>): OrchestrationV2Run | undefined {
  return runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.status !== "queued" &&
      run.status !== "rolled_back" &&
      !cancelledForUpdate(run) &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
}

/** The child root status a settled parent row stands for. */
function childRootStatus(status: string): SubagentSettlementStatus | "completed" {
  switch (status) {
    case "completed":
    case "cancelled":
    case "failed":
      return status;
    default:
      return "interrupted";
  }
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const environmentId = Option.isNone(environment)
    ? null
    : yield* environment.value.getEnvironmentId;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  // What the previous sweep found settleable, by thread. Only the same
  // verdict twice in a row settles anything.
  const suspects = yield* Ref.make<ReadonlyMap<ThreadId, string>>(new Map());
  const updateHold = yield* ServiceUpdateHold.optional;

  /**
   * Whether a live provider process may still run this provider thread's
   * work. A closed session runs nothing; an open one that cannot say is
   * trusted to be running it.
   */
  const providerThreadLive = Effect.fn("StrandedSubagents.providerThreadLive")(function* (
    providerThread: OrchestrationV2ProviderThread,
  ) {
    if (providerThread.providerSessionId === null) return false;
    const session = yield* sessions
      .get(providerThread.providerSessionId)
      .pipe(Effect.orElseSucceed(() => Option.some(null)));
    if (Option.isNone(session)) return false;
    if (session.value === null || session.value.liveBackgroundWork === undefined) return true;
    return yield* session.value
      .liveBackgroundWork(providerThread)
      .pipe(Effect.orElseSucceed(() => true));
  });

  const settlementCause = Effect.fn("StrandedSubagents.settlementCause")(function* (
    threadId: ThreadId,
    runs: ReadonlyArray<OrchestrationV2Run>,
    providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  ) {
    const latest = latestStartedRun(runs);
    if (latest === undefined) {
      return {
        status: "interrupted",
        progress: outageProgress({ driver: null, failureClass: null }),
      } satisfies SettlementCause;
    }
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunIds: [latest.id],
      turnItemTypes: ["run_interrupt_request", "error"],
    });
    const request = turnItems.findLast(
      (item) => item.type === "run_interrupt_request" && item.runId === latest.id,
    );
    if (
      request?.type === "run_interrupt_request" &&
      !SYSTEM_INTERRUPT_REASONS.has(request.message)
    ) {
      switch (request.cause ?? "user") {
        case "user":
          return { status: "cancelled", progress: PERSON_STOP_PROGRESS } satisfies SettlementCause;
        case "agent":
        case "delegated_cancel":
          return { status: "cancelled", progress: AGENT_STOP_PROGRESS } satisfies SettlementCause;
        case "service_update":
          return {
            status: "interrupted",
            progress: outageProgress({ driver: null, failureClass: "service_update" }),
          } satisfies SettlementCause;
      }
    }
    return {
      status: "interrupted",
      progress: outageProgress({
        driver:
          providerThreads.find((candidate) => candidate.id === latest.providerThreadId)?.driver ??
          null,
        failureClass: latestRootProviderFailure(latest, turnItems)?.class ?? null,
      }),
    } satisfies SettlementCause;
  });

  /** Settles a native child thread's runless root turn and its open items. */
  const settleChild = Effect.fn("StrandedSubagents.settleChild")(function* (
    childThreadId: ThreadId,
    status: SubagentSettlementStatus | "completed",
  ) {
    const child = yield* projections.getRuntimeRecoveryProjection(childThreadId);
    const roots = child.nodes.filter(
      (node) =>
        node.kind === "root_turn" &&
        node.runId === null &&
        (isOpenWorkStatus(node.status) ||
          child.turnItems.some((item) => item.nodeId === node.id && isOpenWorkStatus(item.status))),
    );
    if (roots.length === 0) return false;
    const now = yield* DateTime.now;
    const commandId = CommandId.make(
      `command:stranded-subagents:${childThreadId}:${digest(roots.map((node) => node.id).join(","))}`,
    );
    const events = yield* settleRunlessRootTurns({
      projection: child,
      status,
      now,
      allocateEventId: () => ids.allocate.event({ threadId: childThreadId, commandId }),
      settledNodeIds: new Set(),
      settledItemIds: new Set(),
    });
    if (events.length === 0) return false;
    const result = yield* eventSink.commitCommand({
      commandId,
      threadId: childThreadId,
      commandType: "stranded-subagents.settle",
      acceptedAt: now,
      events,
      effects: [],
    });
    return result.committed;
  });

  const sweepParent = Effect.fn("StrandedSubagents.sweepParent")(function* (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
    previous: ReadonlyMap<ThreadId, string>,
    suspected: Map<ThreadId, string>,
  ) {
    const threadId = projection.thread.id;
    const owned = yield* projections.getThreadRecords(threadId, ["runs", "providerThreads"]);
    const runs = [...owned.runs];
    const providerThreads = [...owned.providerThreads];
    // Native descendants execute in their nearest non-native owner's process.
    // An independently delegated ancestor is an execution boundary.
    let ancestor = projection;
    const seen = new Set<ThreadId>([threadId]);
    for (let depth = 0; isProviderNativeSubagentThread(ancestor.thread); depth += 1) {
      const parent = ancestor.thread.lineage.parentThreadId;
      if (parent === null || seen.has(parent) || depth >= 16) return false;
      seen.add(parent);
      ancestor = yield* projections.getRuntimeRecoveryProjection(parent);
      if (!localChildOwnership(ancestor.thread, environmentId)) return false;
      runs.push(...ancestor.runs);
      for (const candidate of ancestor.providerThreads) {
        if (!providerThreads.some((known) => known.id === candidate.id))
          providerThreads.push(candidate);
      }
    }
    // A replacement run owns only its own session. A live process on B must
    // not shield A's retired work (including A -> B -> A).
    const deadThreads = new Set<OrchestrationV2ProviderThread["id"]>();
    for (const providerThread of providerThreads) {
      if (
        runs.some(
          (run) =>
            run.providerThreadId === providerThread.id && BLOCKING_RUN_STATUSES.has(run.status),
        )
      )
        continue;
      if (!(yield* providerThreadLive(providerThread))) deadThreads.add(providerThread.id);
    }
    const scope = { providerThreadIds: deadThreads };
    const open = openNativeSubagentWork(projection, scope);
    if (open.items.length === 0 && open.rows.length === 0) return false;
    const subagentIds = [
      ...open.items.map((item) => item.subagentId),
      ...open.rows.map((row) => row.id),
    ].toSorted();
    const verdict = `parent:${subagentIds.join(",")}`;
    if (previous.get(threadId) !== verdict) {
      suspected.set(threadId, verdict);
      return false;
    }
    const cause = yield* settlementCause(
      ancestor.thread.id,
      runs.filter((run) => run.providerThreadId !== null && deadThreads.has(run.providerThreadId)),
      providerThreads,
    );
    const now = yield* DateTime.now;
    const commandId = CommandId.make(`command:stranded-subagents:${threadId}:${digest(verdict)}`);
    const allocateEventId = () => ids.allocate.event({ threadId, commandId });
    const settlement = yield* settleNativeSubagents({
      projection,
      scope,
      status: cause.status,
      progress: cause.progress,
      now,
      allocateEventId,
    });
    const notes = yield* lostWorkNoteEvents({
      projection: { thread: ancestor.thread, runs: ancestor.runs },
      lostWork: settlement.lostWork,
      now,
      allocateEventId,
    });
    const result = yield* eventSink.commitCommand({
      commandId,
      threadId,
      commandType: "stranded-subagents.settle",
      acceptedAt: now,
      events: [...settlement.events, ...notes],
      effects: [],
    });
    if (!result.committed) return false;
    for (const childThreadId of settlement.childThreadIds) {
      // A valid receipt may only close the item, with no row event at all.
      // Carry its validated outcome instead of re-reading the old projection.
      yield* settleChild(
        childThreadId,
        settlement.childStatuses.get(childThreadId) ?? cause.status,
      ).pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("Could not settle a stranded subagent's own thread", {
            threadId: childThreadId,
            cause: failure,
          }),
        ),
      );
    }
    yield* Effect.logInfo("Settled subagents no provider process runs any more", {
      threadId,
      subagents: subagentIds.length,
      status: cause.status,
    });
    return true;
  });

  /**
   * A native child whose parent row is already settled (or gone) still shows
   * its root turn running. Its parent's sweep handles a child whose row is open.
   */
  const sweepChild = Effect.fn("StrandedSubagents.sweepChild")(function* (
    projection: ProjectionStore.ProjectionRuntimeRecoveryState,
    previous: ReadonlyMap<ThreadId, string>,
    suspected: Map<ThreadId, string>,
  ) {
    const threadId = projection.thread.id;
    const parentThreadId = projection.thread.lineage.parentThreadId;
    if (!isProviderNativeSubagentThread(projection.thread) || parentThreadId === null) {
      return false;
    }
    const roots = projection.nodes.filter(
      (node) =>
        node.kind === "root_turn" &&
        node.runId === null &&
        (isOpenWorkStatus(node.status) ||
          projection.turnItems.some(
            (item) => item.nodeId === node.id && isOpenWorkStatus(item.status),
          )),
    );
    if (roots.length === 0) return false;
    const owner = yield* projections.getRuntimeRecoveryProjection(parentThreadId);
    if (!localChildOwnership(owner.thread, environmentId)) return false;
    const { subagents } = owner;
    const row = subagents.find((candidate) => candidate.childThreadId === threadId);
    if (row !== undefined && isOpenWorkStatus(row.status)) return false;
    const verdict = `child:${roots.map((node) => node.id).join(",")}`;
    if (previous.get(threadId) !== verdict) {
      suspected.set(threadId, verdict);
      return false;
    }
    return yield* settleChild(
      threadId,
      row === undefined ? "interrupted" : childRootStatus(row.status),
    );
  });

  const sweepThread = Effect.fn("StrandedSubagents.sweepThread")(function* (
    threadId: ThreadId,
    previous: ReadonlyMap<ThreadId, string>,
    suspected: Map<ThreadId, string>,
  ) {
    const projection = yield* projections.getRuntimeRecoveryProjection(threadId);
    if (
      projection.thread.deletedAt !== null ||
      !localChildOwnership(projection.thread, environmentId)
    )
      return false;
    const open = openNativeSubagentWork(projection);
    if (open.items.length > 0 || open.rows.length > 0) {
      return yield* sweepParent(projection, previous, suspected);
    }
    return yield* sweepChild(projection, previous, suspected);
  });

  const sweep = Effect.fn("StrandedSubagents.sweep")(function* () {
    // A held service is about to be updated, and the update reads the whole database while it
    // holds: one settled subagent would make it read everything again. The interrupts the hold
    // made strand subagents on purpose; the new release's restart recovery settles them.
    if (yield* updateHold.isHeld) return 0;
    const threadIds = yield* projections.getRecoveryThreadIds("stranded-subagents");
    const previous = yield* Ref.get(suspects);
    const suspected = new Map<ThreadId, string>();
    let settled = 0;
    for (const threadId of threadIds) {
      const result = yield* sweepThread(threadId, previous, suspected).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Stranded subagent sweep skipped a thread", { threadId, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (result) settled += 1;
    }
    yield* Ref.set(suspects, suspected);
    return settled;
  });

  const start = (): Effect.Effect<void, never, Scope.Scope> =>
    forkParked(
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Stranded subagent sweep failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(STRANDED_SUBAGENT_SWEEP_INTERVAL)),
        Effect.asVoid,
      ),
    );

  return { start, sweep };
});
