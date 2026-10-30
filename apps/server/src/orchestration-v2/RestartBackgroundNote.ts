import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RestartCancelledBackgroundWork,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import {
  latestRootProviderFailure,
  runRanAfter,
} from "@specweave-studio/shared/orchestrationV2ThreadError";

type Work = OrchestrationV2RestartCancelledBackgroundWork;
type Attempt = Pick<OrchestrationV2RunAttempt, "id" | "runId">;

const MAX_LABEL_LENGTH = 160;

function compactLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

/** Describes a background-capable turn item that restart recovery cancels. */
export function cancelledTurnItemWork(item: OrchestrationV2TurnItem): Work | undefined {
  switch (item.type) {
    case "subagent":
      return {
        kind: "subagent",
        label: compactLabel(item.title) ?? compactLabel(item.prompt) ?? "subagent",
        id: item.id,
      };
    case "command_execution":
      return {
        kind: "shell",
        label: compactLabel(item.input) ?? compactLabel(item.title) ?? "background command",
        id: item.id,
      };
    case "dynamic_tool": {
      const monitor =
        item.input !== null &&
        typeof item.input === "object" &&
        Reflect.get(item.input, "persistent") === true;
      return {
        kind: monitor ? "monitor" : "task",
        label: compactLabel(item.title) ?? compactLabel(item.toolName) ?? "background tool",
        id: item.id,
      };
    }
    default:
      return undefined;
  }
}

function restartWorkKind(task: OrchestrationV2PendingBackgroundTask): Work["kind"] {
  switch (task.kind) {
    case "command":
      return "shell";
    case "subagent":
      return "subagent";
    case "monitor":
      return "monitor";
    case "background_task":
    case "workflow":
      return "task";
    default:
      task satisfies never;
      return "task";
  }
}

/**
 * Describes a provider-native subagent that an outage interrupted, keyed by
 * its subagent id so every settlement path names it the same way.
 */
export function interruptedSubagentWork(subagent: {
  readonly id: string;
  readonly title: string | null;
  readonly prompt: string;
}): Work {
  return {
    kind: "subagent",
    label: compactLabel(subagent.title) ?? compactLabel(subagent.prompt) ?? "subagent",
    id: subagent.id,
  };
}

/** Describes a provider-reported background task (the provider-thread roster). */
export function cancelledRosterTaskWork(task: OrchestrationV2PendingBackgroundTask): Work {
  const kind = restartWorkKind(task);
  const description = compactLabel(task.description);
  return {
    kind,
    label:
      compactLabel(
        description === undefined ? task.taskId : `${description} (id ${task.taskId})`,
      ) ?? "background task",
    id: task.taskId,
  };
}

const MAX_NOTE_ENTRIES = 10;

/**
 * Provider-facing text for work the model still expects to hear back from.
 * Bounded (entries and label length) so it cannot crowd out the turn's context.
 */
export function restartCancelledBackgroundWorkNote(work: ReadonlyArray<Work>): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    "Note: this background work was interrupted before it finished (a SpecWithCode server restart, a usage limit or a provider failure ended it). It will not report back. Rerun or finish it yourself if it is still needed:",
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ].join("\n");
}

type ProviderTurnState = Pick<
  OrchestrationV2ProviderTurn,
  "runAttemptId" | "providerThreadId" | "status"
>;

/** The provider never accepted this continuation's prompt, so starting it again repeats nothing. */
export function continuationFailedBeforePrompt(
  run: Pick<OrchestrationV2Run, "id" | "status" | "activeAttemptId" | "restartContinuationOfRunId">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>,
  attempts: ReadonlyArray<Attempt> = [],
): boolean {
  if (run.status !== "failed" || run.restartContinuationOfRunId === undefined) return false;
  // A retried run's earlier attempt may have taken the prompt.
  const attemptIds = new Set<string | null>([
    run.activeAttemptId,
    ...attempts.flatMap((attempt) => (attempt.runId === run.id ? [attempt.id] : [])),
  ]);
  return !providerTurns.some(
    (turn) => turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId),
  );
}

const CONTINUATION_START_RETRY_DELAYS_MS = [60_000, 180_000];

/**
 * Backoff before restarting a continuation that failed to start (under load a
 * resumed provider can time out before taking the prompt), or undefined to let
 * it fail.
 */
export function continuationStartRetryDelayMs(
  run: OrchestrationV2Run,
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId">>;
    readonly attempts?: ReadonlyArray<Attempt>;
    readonly turnItems: Parameters<typeof latestRootProviderFailure>[1];
  },
): number | undefined {
  if (!continuationFailedBeforePrompt(run, projection.providerTurns, projection.attempts))
    return undefined;
  // These fail the same way however often they start.
  const failureClass = latestRootProviderFailure(run, projection.turnItems)?.class;
  if (
    failureClass === "usage_limit" ||
    failureClass === "permission_error" ||
    failureClass === "validation_error"
  )
    return undefined;
  let failedStarts = 0;
  const visited = new Set<string>();
  for (
    let current: OrchestrationV2Run | undefined = run;
    current !== undefined &&
    !visited.has(current.id) &&
    continuationFailedBeforePrompt(current, projection.providerTurns, projection.attempts);
    current = projection.runs.find(
      (candidate) => candidate.id === current?.restartContinuationOfRunId,
    )
  ) {
    visited.add(current.id);
    failedStarts += 1;
  }
  return CONTINUATION_START_RETRY_DELAYS_MS[failedStarts - 1];
}

/**
 * A run whose turn had settled before the restart cancelled its background
 * work. Continuing it prompts the provider with the note. A run cut mid-turn
 * instead resumes that turn, which Codex does natively without a prompt.
 */
export function isRestartNoteSource(
  source: Pick<OrchestrationV2Run, "status" | "activeAttemptId" | "restartCancelledBackgroundWork">,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
): boolean {
  return (
    // A failed or interrupted turn is never continued. Recovery cancels a
    // waiting run it cannot checkpoint, so a cancelled one still qualifies.
    (source.status === "completed" ||
      source.status === "waiting" ||
      source.status === "cancelled") &&
    (source.restartCancelledBackgroundWork?.length ?? 0) > 0 &&
    !providerTurns.some(
      (turn) => turn.runAttemptId === source.activeAttemptId && turn.status === "cancelled",
    )
  );
}

/**
 * The note a restart continuation of `source` carries, and whether the turn it
 * continues had settled (the note is then the whole prompt). A continuation cut
 * before its provider turn completed may not have delivered its own note:
 * adapters can announce a running turn before accepting the prompt. Carry the
 * note forward until a completed turn proves delivery.
 */
export function restartContinuationNote(
  source: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): { readonly work: ReadonlyArray<Work>; readonly settled: boolean } {
  const completedAttempts = new Set(
    providerTurns.filter((turn) => turn.status === "completed").map((turn) => turn.runAttemptId),
  );
  const completedRuns = new Set(
    attempts.filter((attempt) => completedAttempts.has(attempt.id)).map((attempt) => attempt.runId),
  );
  let current = source;
  let work = current.restartCancelledBackgroundWork ?? [];
  const visited = new Set([current.id]);
  while (
    current.restartContinuationOfRunId !== undefined &&
    !completedRuns.has(current.id) &&
    !(current.activeAttemptId !== null && completedAttempts.has(current.activeAttemptId))
  ) {
    const previous = runs.find((candidate) => candidate.id === current.restartContinuationOfRunId);
    if (previous === undefined || visited.has(previous.id)) break;
    visited.add(previous.id);
    current = previous;
    work = mergeRestartCancelledBackgroundWork(current.restartCancelledBackgroundWork ?? [], work);
  }
  return { work, settled: isRestartNoteSource(current, providerTurns) };
}

/**
 * A restart continuation prompted with the note rather than a native resume.
 * A turn cut mid-way that lost background work is prompted too, so the note
 * is delivered with it; only a continuation without a note resumes natively.
 */
export function isRestartNoteContinuation(
  run: Pick<OrchestrationV2Run, "restartContinuationOfRunId">,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<Pick<ProviderTurnState, "runAttemptId" | "status">>,
  attempts: ReadonlyArray<Attempt>,
): boolean {
  const source =
    run.restartContinuationOfRunId === undefined
      ? undefined
      : runs.find((candidate) => candidate.id === run.restartContinuationOfRunId);
  return (
    source !== undefined &&
    restartContinuationNote(source, runs, providerTurns, attempts).work.length > 0
  );
}

/**
 * Work cancelled by a restart that the run's provider thread has not been told
 * about yet. The note belongs to the provider thread that lost the work: turns
 * on another provider (after a switch) neither owe it nor deliver it. A later
 * completed turn on the same provider thread proves delivery, so the pending
 * set is derived rather than cleared. Compactions and
 * resumed turns carry no note, and a rolled-back run left native history, so
 * none of them counts as delivery. A note continuation's own prompt is the note.
 */
export function pendingRestartCancelledBackgroundWork(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerTurns: ReadonlyArray<ProviderTurnState>;
  readonly compactionMessageIds: ReadonlySet<string>;
  readonly run: Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "completedAt"
    | "userMessageId"
    | "providerThreadId"
    | "restartContinuationOfRunId"
    | "activeAttemptId"
  >;
  /** Include earlier attempts: a steer replaces the attempt but not the run. */
  readonly attempts: ReadonlyArray<Attempt>;
}): ReadonlyArray<Work> {
  const isCompaction = (run: typeof input.run) => input.compactionMessageIds.has(run.userMessageId);
  // The current run prepends the note unless it is a compaction or a
  // continuation (whose own prompt is the note, or which resumes natively).
  if (
    input.run.providerThreadId === null ||
    input.run.restartContinuationOfRunId !== undefined ||
    isCompaction(input.run)
  )
    return [];
  const providerThreadId = input.run.providerThreadId;
  const deliveredAttemptIds = new Set(
    input.providerTurns
      .filter((turn) => turn.status === "completed")
      .map((turn) => turn.runAttemptId),
  );
  const sameThread = input.runs;
  const prompted = sameThread.filter(
    (candidate) =>
      candidate.id !== input.run.id &&
      candidate.activeAttemptId !== null &&
      candidate.status !== "rolled_back" &&
      (deliveredAttemptIds.has(candidate.activeAttemptId) ||
        input.attempts.some(
          (attempt) => attempt.runId === candidate.id && deliveredAttemptIds.has(attempt.id),
        )) &&
      !isCompaction(candidate) &&
      (candidate.restartContinuationOfRunId === undefined ||
        isRestartNoteContinuation(candidate, input.runs, input.providerTurns, input.attempts)),
  );
  // A steer restarts this run on a new attempt: an earlier attempt that already
  // reached the provider delivered the note, so the replacement must not repeat it.
  const alreadyDelivered = input.attempts.some(
    (attempt) =>
      attempt.runId === input.run.id &&
      attempt.id !== input.run.activeAttemptId &&
      deliveredAttemptIds.has(attempt.id),
  );
  if (alreadyDelivered) return [];
  return sameThread
    .filter((source) => runRanAfter(input.run, source))
    .reduce<ReadonlyArray<Work>>(
      (work, source) =>
        mergeRestartCancelledBackgroundWork(
          work,
          (source.restartCancelledBackgroundWork ?? []).filter((entry) => {
            const portable = entry.kind === "subagent" && entry.id !== undefined;
            if (!portable && source.providerThreadId !== providerThreadId) return false;
            return !prompted.some(
              (later) =>
                runRanAfter(later, source) &&
                (portable || later.providerThreadId === source.providerThreadId),
            );
          }),
        ),
      [],
    );
}

export function mergeRestartCancelledBackgroundWork(
  current: ReadonlyArray<Work>,
  added: ReadonlyArray<Work>,
): ReadonlyArray<Work> {
  // Rows recorded before ids existed fall back to kind + label.
  const identity = (entry: Work) => entry.id ?? `${entry.kind}\u0000${entry.label}`;
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const entry of added) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
