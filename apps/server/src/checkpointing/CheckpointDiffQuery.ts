/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  OrchestrationGetTurnDiffResult,
  type CheckpointRef,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type OrchestrationV2RunStatus,
  type ThreadId,
} from "@specweave-studio/contracts";
import { splitPatchByFile } from "@specweave-studio/shared/structuredPatch";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("specweave-studio/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

/** Stopped runs keep the ready checkpoint capture took for them (D-06). */
const DIFFABLE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "cancelled",
]);

/**
 * A checkpoint as the turn diff reads it. Its stamped folder, scope ordinal
 * and file list are absent from older checkpoints and contexts.
 */
type TurnCheckpoint = ProjectionCheckpointContext["checkpoints"][number] & {
  readonly ordinalWithinScope?: number | undefined;
  readonly cwd?: string | undefined;
  readonly files?: ReadonlyArray<{ readonly path: string }> | undefined;
};

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
  truncated = false,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The patch's file blocks for the files a turn's card lists, so files that
 * changed only because HEAD moved stay out of the panel too (AC-08).
 */
function patchForFiles(patch: string, files: ReadonlyArray<{ readonly path: string }>): string {
  const paths = new Set(files.map((file) => file.path));
  return splitPatchByFile(patch)
    .filter(
      (block) =>
        (block.newPath !== null && paths.has(block.newPath)) ||
        (block.oldPath !== null && paths.has(block.oldPath)),
    )
    .map((block) => block.text)
    .join("");
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const crypto = yield* Crypto.Crypto;

  /**
   * The scope snapshot the to checkpoint's card was computed from, when no
   * ready run checkpoint marks the from turn: a failed run takes none, and
   * the next turn's baseline is captured when that turn starts (AC-05).
   */
  const scopeSnapshotBefore = Effect.fn("CheckpointDiffQuery.scopeSnapshotBefore")(
    function* (input: {
      readonly toCheckpoint: TurnCheckpoint;
      readonly turnsBack: number;
      readonly cwd: string;
    }) {
      // Run checkpoints of the root scope sit at their run's ordinal.
      const ordinalWithinScope =
        (input.toCheckpoint.ordinalWithinScope ?? input.toCheckpoint.appRunOrdinal ?? 0) -
        input.turnsBack;
      if (ordinalWithinScope < 0) return undefined;
      const checkpointRef = yield* checkpointRefForScopeOrdinal({
        scopeId: input.toCheckpoint.scopeId,
        ordinalWithinScope,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const exists = yield* checkpointStore.hasCheckpointRef({ cwd: input.cwd, checkpointRef });
      return exists ? checkpointRef : undefined;
    },
  );

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const diffableRunIds = new Set(
        projection.runs.filter((run) => DIFFABLE_RUN_STATUSES.has(run.status)).map((run) => run.id),
      );
      const readyCheckpoints: ReadonlyArray<TurnCheckpoint> = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "ready" &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          diffableRunIds.has(checkpoint.runId),
      );
      const maxTurnCount = readyCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = readyCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      // The scope's cwd follows the latest run; a stamped checkpoint keeps its own.
      const cwd = toCheckpoint.cwd ?? toScope.cwd;

      // The root scope is shared by every run in this thread. Its runId
      // tracks the latest owner, while ordinal zero stays the baseline.
      const firstScope =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
          : undefined;
      const fromCheckpointRef: CheckpointRef | undefined =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : yield* checkpointRefForScopeOrdinal({
                scopeId: firstScope.id,
                ordinalWithinScope: 0,
              }).pipe(Effect.provideService(Crypto.Crypto, crypto))
          : (readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
              ?.ref ??
            (yield* scopeSnapshotBefore({
              toCheckpoint,
              turnsBack: input.toTurnCount - input.fromTurnCount,
              cwd,
            })));
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const diffInput = {
        cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
      };
      const diffCheckpointsReport = CheckpointStore.implementedMethod(
        checkpointStore,
        "diffCheckpointsReport",
      );
      const report = yield* (
        diffCheckpointsReport === undefined
          ? checkpointStore
              .diffCheckpoints(diffInput)
              .pipe(Effect.map((diff) => ({ diff, truncated: false })))
          : diffCheckpointsReport(diffInput)
      ).pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
      // The persisted file list describes one turn; a longer range keeps every file.
      const files = input.toTurnCount - input.fromTurnCount === 1 ? toCheckpoint.files : undefined;
      const diff = files === undefined ? report.diff : patchForFiles(report.diff, files);

      const turnDiff = buildTurnDiffResult(input, diff, report.truncated);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
