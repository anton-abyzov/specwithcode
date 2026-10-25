import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
  // Provenance stamped at capture; older checkpoints carry none of these.
  /** The folder the snapshot staged. */
  readonly cwd?: string;
  /** The repository root of `cwd`; patch paths are relative to it. */
  readonly repoRoot?: string;
  /** The checked-out branch, or null when HEAD was detached. */
  readonly branch?: string | null;
  readonly headOid?: string;
  /** The machine whose server took the snapshot. */
  readonly capturedOnEnvironmentId?: EnvironmentId;
  readonly notGitRepository?: boolean;
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
        ...(checkpoint.cwd === undefined ? {} : { cwd: checkpoint.cwd }),
        ...(checkpoint.repoRoot === undefined ? {} : { repoRoot: checkpoint.repoRoot }),
        ...(checkpoint.branch === undefined ? {} : { branch: checkpoint.branch }),
        ...(checkpoint.headOid === undefined ? {} : { headOid: checkpoint.headOid }),
        ...(checkpoint.capturedOnEnvironmentId === undefined
          ? {}
          : { capturedOnEnvironmentId: checkpoint.capturedOnEnvironmentId }),
        ...(checkpoint.notGitRepository === undefined
          ? {}
          : { notGitRepository: checkpoint.notGitRepository }),
      },
    ];
  });
}
