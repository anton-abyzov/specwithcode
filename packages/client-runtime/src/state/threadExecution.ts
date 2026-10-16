import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@specweave-studio/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderGoal,
  type ServerProviderModel,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
} from "@specweave-studio/shared/model";
import { formatDuration } from "@specweave-studio/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "./models.ts";
import { shortenShellCommand } from "./shellCommandLabel.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

export { shortenShellCommand };

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  return usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  );
}

/** The run that stands for the thread's outcome when no run is executing. */
function presentedLatestRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Returns the run that owns live provider work, falling back to the newest run
 * once the thread is idle. A newer queued run must not make an older executing
 * run look settled in clients that render per-run activity.
 */
export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Provider-native subagent threads never get app runs: their work is a runless
 * root turn whose status follows the subagent. Returns when that work started
 * while it is still active, so clients can show the same working state (and
 * timer) as a run. Stop, queue, and steer stay run-only.
 */
export function deriveRunlessWorkStartedAt(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const status = deriveProviderSubagentStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * Status of a provider-native subagent thread (see
 * isProviderNativeSubagentThread), read from its runless root turn. Null
 * until that root turn arrives, and for every other thread.
 */
export function deriveProviderSubagentStatus(
  projection: OrchestrationV2ThreadProjection,
): ProviderSubagentStatus | null {
  if (!isProviderNativeSubagentThread(projection.thread)) return null;
  const node = projection.nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
}

/** The observed selection belongs to the active provider thread, never a previous handoff. */
export function deriveReportedModelSelection(
  projection: OrchestrationV2ThreadProjection,
): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

// Option ids providers use for reasoning effort (Codex, Claude, Grok/ACP, OpenCode).
const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

/**
 * The reasoning effort a thread's model runs at, resolved and named the way
 * the composer's effort picker does: the stored choice when valid, else the
 * descriptor's current value, else the model's default. Null when the
 * provider catalog has no effort option for this model (a subagent on a
 * model the catalog does not describe), rather than guessing.
 */
export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const descriptors = getProviderOptionDescriptors({ caps, selections: selection.options });
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const label = getProviderOptionCurrentLabel(descriptor, selection, reportedSelection);
    if (label) return label;
  }
  return null;
}

const SUBAGENT_STATUS_LABELS: Record<OrchestrationV2ExecutionNode["status"], string> = {
  idle: "Idle",
  pending: "Working",
  running: "Working",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Cancelled",
};

/**
 * One line for the read-only subagent bar: "Working 12s", "Completed in 34s",
 * or just the status when no duration is known.
 */
export function formatProviderSubagentStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
): string {
  if (status === null) return "Starting";
  const label = SUBAGENT_STATUS_LABELS[status.status];
  const live = isOrchestrationV2WorkActive(status.status);
  if (!live && status.status !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  // Whole seconds: a ticking label must not flicker through tenths.
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  const usageLimitedRun = presentedUsageLimitRun(projection);
  const latestRunProjection = presentedLatestRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const liveActivityRun = latestMatchingRun(projection, (run) =>
    ACTIVITY_RUN_STATUSES.has(run.status),
  );
  // Same rule as the shell runtime: only background work that holds the
  // completion parks the thread at idle; a dev server left running does not.
  const backgroundWorkHoldsRun = backgroundWorkHoldsCompletion(
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  );
  // A pull request watch can hold a thread that never ran.
  if (
    latestRun === null &&
    projection.thread.activeProviderThreadId === null &&
    !backgroundWorkHoldsRun
  ) {
    return null;
  }
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  const errorSummary = threadErrorSummary(
    latestRootProviderFailure(latestRunProjection, projection.turnItems),
    providerSession?.lastError ?? null,
    latestRunProjection?.status ?? null,
  );
  return {
    status: usageLimitedRun
      ? "failed"
      : backgroundWorkHoldsRun && latestRunProjection?.status !== "failed"
        ? "idle"
        : (activityRun?.status ?? "idle"),
    activeRunId,
    activityStartedAt:
      liveActivityRun === null
        ? null
        : DateTime.formatIso(orchestrationV2RunWorkStartedAt(liveActivityRun)),
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...errorSummary,
    lastErrorAt:
      errorSummary.lastError === null || !latestRunProjection?.completedAt
        ? null
        : DateTime.formatIso(latestRunProjection.completedAt),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

export type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

// `order` groups agents and workflows first, loose tasks last.
const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly plural: string }
> = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  workflow: { order: 1, singular: "workflow", plural: "workflows" },
  command: { order: 2, singular: "command", plural: "commands" },
  monitor: { order: 3, singular: "monitor", plural: "monitors" },
  background_task: { order: 4, singular: "background task", plural: "background tasks" },
};

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  /** The work's name, or its noun when the provider gave none. */
  readonly label: string;
  /** False when the provider gave no name and `label` is only the kind's noun. */
  readonly named: boolean;
  /** A subagent's own thread, when it has one. */
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  /**
   * "Waiting on subagent Review src/math.ts", "Waiting on 2 subagents and 1 command",
   * or "Running: Start the dev server" when only commands remain.
   */
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  /**
   * True when the work will wake the agent (subagents, workflows, monitors). False when
   * only commands remain, such as a dev server: the agent is done.
   */
  readonly waiting: boolean;
  /** The kind that leads the roster: the only item's kind, or the first group's. */
  readonly kind: BackgroundWorkKind;
  /**
   * False for one piece of work the provider gave no name: the labels then read as a
   * phrase ("Running a command"), not as the name of the work.
   */
  readonly named: boolean;
  /**
   * What a one-line strip shows: the only item's label, with a shell command cut to
   * the command it runs ("gh run list …" for "ID=$(gh run list …)"), or the counts.
   */
  readonly shortLabel: string;
  /**
   * The untruncated work for a tooltip or screen reader: the only label (the title
   * when it has no name), or every label.
   */
  readonly fullLabel: string;
  /** "2 commands · 1 subagent" when several pieces of work run; null for one. */
  readonly countSummary: string | null;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Names what a settled thread still runs, grouped by kind, for the composer strip. */
export function presentPendingBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks
    .map((task): PendingBackgroundWorkItem => {
      const description = task.description?.trim();
      const label =
        task.kind === "subagent" && description !== undefined
          ? formatSubagentDisplayTitle(description).trim()
          : description;
      const noun = BACKGROUND_WORK_KINDS[task.kind].singular;
      const name = label === undefined || label.length === 0 ? noun : label;
      // A native workflow reports its current phase or worker as it runs.
      const progress = task.kind === "workflow" ? task.progress?.trim() : undefined;
      const shown =
        progress === undefined || progress.length === 0 ? name : `${name} · ${progress}`;
      return {
        taskId: task.taskId,
        kind: task.kind,
        label: shown,
        named: shown !== noun,
        childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
      };
    })
    // `map` returned a new array; Hermes has no `toSorted`.
    .sort(
      (left, right) =>
        BACKGROUND_WORK_KINDS[left.kind].order - BACKGROUND_WORK_KINDS[right.kind].order,
    );
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const noun = BACKGROUND_WORK_KINDS[only.kind].singular;
    const named = only.named;
    const title = waiting
      ? named
        ? `Waiting on ${noun} ${only.label}`
        : `Waiting on a ${noun}`
      : named
        ? `Running: ${only.label}`
        : `Running a ${noun}`;
    return {
      title,
      items,
      waiting,
      kind: only.kind,
      named,
      shortLabel: !named
        ? title
        : only.kind === "command"
          ? shortenShellCommand(only.label)
          : only.label,
      fullLabel: named ? only.label : title,
      countSummary: null,
    };
  }
  const counts = new Map<BackgroundWorkKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = Array.from(counts, ([kind, count]) => {
    const { singular, plural } = BACKGROUND_WORK_KINDS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  const countSummary = groups.join(" · ");
  return {
    title: `${waiting ? "Waiting on" : "Running"} ${joinWithAnd(groups)}`,
    items,
    waiting,
    kind: items[0]?.kind ?? "background_task",
    named: true,
    shortLabel: countSummary,
    fullLabel: items.map((item) => item.label).join(", "),
    countSummary,
  };
}

export interface ProviderGoalPresentation {
  /** "Pursuing goal", "Goal paused", "Goal complete"... */
  readonly title: string;
  readonly objective: string;
  /** "12k / 50k tokens · 4m" for Codex, "2 checks" for Claude; null when nothing is reported. */
  readonly usage: string | null;
  /** Only Codex stops a goal short of done, and only a stopped goal can resume. */
  readonly canResume: boolean;
}

const PROVIDER_GOAL_TITLES: Record<OrchestrationV2ProviderGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Status line for a native `/goal`, shared by the web composer row and mobile.
 * An active goal on an idle thread (Claude after Stop) is set, not pursued.
 */
export function presentProviderGoal(
  goal: OrchestrationV2ProviderGoal,
  working: boolean,
): ProviderGoalPresentation {
  const usage: Array<string> = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget == null
        ? `${formatGoalTokens(goal.tokensUsed)} tokens`
        : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`,
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  if (goal.checks !== undefined && goal.checks > 0) {
    usage.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  }
  return {
    title: goal.status === "active" && !working ? "Goal set" : PROVIDER_GOAL_TITLES[goal.status],
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

/** The thread a notification row opens: that of the one subagent or delegated task it reports. */
export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): ThreadId | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
