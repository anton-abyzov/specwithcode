import {
  type EnvironmentId,
  type HandoffModeError,
  type HandoffModeSnapshot,
  isProjectCoordinatorThreadId,
  ORCHESTRATOR_MCP_MIGRATE_MAX_THREADS,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadMigrateInput,
  type OrchestratorMcpThreadMigrateResult,
  type OrchestratorMcpThreadMigrateThreadResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as HandoffMode from "../../../handoff/HandoffMode.ts";
import { effectiveHandoffMode } from "../../../handoff/handoffState.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { bulkStopTargets } from "../../OrchestratorMcpBulkThreads.ts";
import {
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  unavailable,
} from "../../threadAccess.ts";
import { assertThreadInGrant, assertThreadWritable, workGrantOf } from "../../workGrantAccess.ts";

type FailureCode = OrchestratorMcpFailure["code"];

const failure = (code: FailureCode, message: string) =>
  new OrchestratorMcpFailure({ code, message });

const HANDOFF_FAILURE_CODES: Partial<Record<HandoffModeError["code"], FailureCode>> = {
  not_found: "thread_not_found",
  invalid: "invalid_request",
  unreachable: "machine_unreachable",
  needs_grant: "machine_not_authorized",
  fenced: "thread_fenced",
};

/** The handoff service's own code and message, verbatim: never a substitute outcome. */
export const handoffFailure = (error: HandoffModeError) =>
  failure(
    HANDOFF_FAILURE_CODES[error.code] ?? "orchestration_error",
    `Handoff failed (${error.code}): ${error.message}`,
  );

export function migrateSummary(
  label: string,
  results: ReadonlyArray<Pick<OrchestratorMcpThreadMigrateThreadResult, "outcome">>,
): string {
  const counts = (["moved", "stayed", "skipped"] as const)
    .map((outcome) => [outcome, results.filter((row) => row.outcome === outcome).length] as const)
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${count} ${outcome}`);
  return counts.length === 0
    ? `${label}: no running handoff-mode threads to move.`
    : `${label}: ${counts.join(", ")}.`;
}

/** Only this project's coordinator, or a caller in full-access/default mode, moves its threads. */
const assertMayMigrate = (context: Caller, caller: OrchestrationV2ThreadShell) =>
  Effect.gen(function* () {
    if (
      context.limits.runtimeMode === "full-access" &&
      context.limits.interactionMode === "default"
    ) {
      return;
    }
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects
      .getById(caller.projectId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(unavailable));
    if (project !== undefined && isProjectCoordinatorThreadId(caller.id, project)) return;
    return yield* failure(
      "capability_denied",
      "Only this project's coordinator, or a thread in full-access mode, moves threads to another machine.",
    );
  });

/** A thread of the caller's project on this machine, other than the caller, it may write. */
const loadTarget = (context: Caller, caller: OrchestrationV2ThreadShell, threadId: string) =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const resolved = yield* workers.resolveThread({ machine: undefined, threadId });
    if (resolved.target.kind === "remote") {
      return yield* failure(
        "invalid_request",
        `Thread ${resolved.threadId} runs on ${resolved.target.machine.label}; only threads running on this machine can be moved from here.`,
      );
    }
    const shell = yield* context.threads
      .getThreadShell(resolved.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${resolved.threadId} was not found.`);
    }
    if (shell.id === caller.id) {
      return yield* failure(
        "invalid_request",
        "A thread cannot move itself; the user moves the coordinator.",
      );
    }
    if (shell.projectId !== caller.projectId) {
      return yield* failure(
        "capability_denied",
        `Thread ${shell.id} belongs to another project; a coordinator moves only its own project's threads.`,
      );
    }
    const work = yield* workGrantOf(context);
    yield* assertThreadInGrant(work, shell);
    yield* assertThreadWritable(work, shell);
    return shell;
  });

const isHandoffModeThread = (snapshot: HandoffModeSnapshot, shell: OrchestrationV2ThreadShell) => {
  const record = snapshot.threads.find((thread) => thread.threadId === shell.id);
  if (record?.continuedOn != null) return false;
  return (
    (record?.effectiveMode ?? effectiveHandoffMode(snapshot, shell.projectId, "inherit")) === "on"
  );
};

const skipped = (
  shell: OrchestrationV2ThreadShell,
  detail: string,
): OrchestratorMcpThreadMigrateThreadResult => ({
  threadId: shell.id,
  title: shell.title,
  outcome: "skipped",
  detail,
  continuedThreadId: null,
  resumed: null,
});

/**
 * Omitted threadIds mean this project's running handoff-mode threads. The
 * service would take every project's, so the tool names them itself; a
 * thread outside the caller's modes or grant is reported as skipped.
 */
const selectProjectThreads = (
  context: Caller,
  caller: OrchestrationV2ThreadShell,
  handoff: HandoffMode.HandoffMode["Service"],
) =>
  Effect.gen(function* () {
    const snapshot = yield* handoff.snapshot.pipe(Effect.mapError(handoffFailure));
    const shells = yield* context.threads
      .listProjectThreads({ projectId: caller.projectId, includeSubagents: false })
      .pipe(Effect.mapError(unavailable));
    const work = yield* workGrantOf(context);
    const movable: Array<OrchestrationV2ThreadShell> = [];
    const refused: Array<OrchestratorMcpThreadMigrateThreadResult> = [];
    for (const { shell } of bulkStopTargets(shells, caller.id)) {
      if (!isHandoffModeThread(snapshot, shell)) continue;
      const admitted = yield* assertTargetWithinLimits(context.limits, shell).pipe(
        Effect.mapError(() => "This thread runs in broader modes than the caller."),
        Effect.andThen(
          Effect.all([assertThreadInGrant(work, shell), assertThreadWritable(work, shell)]).pipe(
            Effect.mapError((error) => error.message),
          ),
        ),
        Effect.result,
      );
      if (admitted._tag === "Success") movable.push(shell);
      else refused.push(skipped(shell, admitted.failure));
    }
    if (movable.length > ORCHESTRATOR_MCP_MIGRATE_MAX_THREADS) {
      return yield* failure(
        "invalid_request",
        `This project has ${movable.length} running handoff-mode threads; name at most ${ORCHESTRATOR_MCP_MIGRATE_MAX_THREADS} in threadIds.`,
      );
    }
    return { movable, refused } as const;
  });

const moveMany = (
  handoff: HandoffMode.HandoffMode["Service"],
  destinationEnvironmentId: EnvironmentId,
  fallbackLabel: string,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
) =>
  shells.length === 0
    ? Effect.succeed({ label: fallbackLabel, results: [] })
    : handoff
        .handOffMachine({
          destinationEnvironmentId,
          reason: "manual",
          threadIds: shells.map((shell) => shell.id),
        })
        .pipe(
          Effect.mapError(handoffFailure),
          Effect.map((run) => ({
            label: run.destinationLabel,
            results: run.results.map((row): OrchestratorMcpThreadMigrateThreadResult => ({
              threadId: row.threadId,
              title: row.title,
              outcome: row.outcome,
              detail: row.detail,
              continuedThreadId: row.continuedThreadId,
              resumed: row.resumed,
            })),
          })),
        );

/**
 * Moves threads of the caller's project to another machine through 0967's
 * handoff. Each thread keeps its owner; only its execution moves.
 */
export const migrateThreads = (input: OrchestratorMcpThreadMigrateInput) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    yield* McpInvocationContext.requireThreadScope(scope, "studio_thread_migrate");
    const context = yield* loadCaller();
    const caller = context.caller;
    if (caller === undefined) return yield* unavailable();
    yield* assertMayMigrate(context, caller);

    const threadIds = input.threadIds === undefined ? undefined : [...new Set(input.threadIds)];
    if (input.modelSelection !== undefined && threadIds?.length !== 1) {
      return yield* failure(
        "invalid_request",
        "modelSelection needs exactly one thread in threadIds.",
      );
    }
    const targets: Array<OrchestrationV2ThreadShell> = [];
    for (const threadId of threadIds ?? []) {
      targets.push(yield* loadTarget(context, caller, threadId));
    }

    const workers = yield* RemoteWorkers.RemoteWorkers;
    const destination = yield* workers.resolveMachine(input.machine);
    if (destination.kind === "local") {
      return yield* failure(
        "invalid_request",
        "studio_thread_migrate moves threads to another machine; name one from studio_machine_list.",
      );
    }
    const { environmentId } = destination.machine;
    const handoff = yield* HandoffMode.HandoffMode;

    if (targets.length === 1) {
      const shell = targets[0]!;
      const moved = yield* handoff
        .handOff({
          threadId: shell.id,
          destinationEnvironmentId: environmentId,
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        })
        .pipe(Effect.mapError(handoffFailure));
      const results: ReadonlyArray<OrchestratorMcpThreadMigrateThreadResult> = [
        {
          threadId: shell.id,
          title: shell.title,
          outcome: "moved",
          detail: moved.notice,
          continuedThreadId: moved.threadId,
          resumed: null,
        },
      ];
      return {
        destination: { environmentId, label: moved.machineLabel },
        reason: "manual",
        results,
        summary: migrateSummary(moved.machineLabel, results),
      } satisfies OrchestratorMcpThreadMigrateResult;
    }

    const selection =
      threadIds === undefined
        ? yield* selectProjectThreads(context, caller, handoff)
        : { movable: targets, refused: [] };
    const run = yield* moveMany(
      handoff,
      environmentId,
      destination.machine.label,
      selection.movable,
    );
    const results = [...run.results, ...selection.refused];
    return {
      destination: { environmentId, label: run.label },
      reason: "manual",
      results,
      summary: migrateSummary(run.label, results),
    } satisfies OrchestratorMcpThreadMigrateResult;
  });
