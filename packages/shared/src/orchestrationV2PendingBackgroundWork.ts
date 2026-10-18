import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
  ThreadPullRequestLink,
} from "@specweave-studio/contracts";
import { isOrchestrationV2WorkActive } from "@specweave-studio/contracts";

import { threadPullRequestKeyOf } from "./threadPullRequests.ts";

const BACKGROUND_TURN_ITEM_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

/**
 * True terminal run statuses (includes `rolled_back`). Retained as the
 * canonical terminal set for this module; do not widen or reuse it as the
 * background-wait gate — that gate intentionally excludes `rolled_back`.
 */
const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "rolled_back",
]);

/**
 * Run statuses that allow a pending-background roster to surface.
 * Includes `waiting`: a successful turn persists as waiting until checkpoint
 * capture flips it to completed, and waiting is only set from completed.
 * Excludes `rolled_back`: the provider-thread roster is not run-tied, so a
 * rolled-back latest run must fail the gate entirely (not only item filter).
 * Built explicitly rather than spreading or deleting from TERMINAL_RUN_STATUSES.
 */
const SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "waiting",
]);

// Keep TERMINAL_RUN_STATUSES referenced so the true-terminal set stays defined
// next to the background-wait subset (rolled_back is terminal, not wait-settled).
void TERMINAL_RUN_STATUSES;

export type PendingBackgroundWorkTask = OrchestrationV2PendingBackgroundTask;

/**
 * Whether a turn-item update can end background work that a settled run is
 * still waiting on: an item of a background type that is no longer active.
 * Streaming output on a running item, and every other item type, cannot.
 */
export function turnItemUpdateCanEndBackgroundWork(
  item: Pick<OrchestrationV2TurnItem, "type" | "status">,
): boolean {
  return BACKGROUND_TURN_ITEM_TYPES.has(item.type) && !isOrchestrationV2WorkActive(item.status);
}

/**
 * Whether background work left behind by a completed root run holds back its
 * completion alert (desktop/web notification and the mobile push). Commands,
 * such as dev servers and other long-lived shells, do not: the agent is done
 * and may leave them running for hours. Subagents and monitors do, because
 * they wake the agent and it continues (#13625). Work the adapter cannot name,
 * including kinds this build does not know, holds as the conservative choice.
 */
export function backgroundWorkHoldsCompletion(
  tasks: ReadonlyArray<Pick<PendingBackgroundWorkTask, "kind">>,
): boolean {
  return tasks.some((task) => backgroundWorkKindHoldsCompletion(task.kind));
}

function backgroundWorkKindHoldsCompletion(kind: PendingBackgroundWorkTask["kind"]): boolean {
  switch (kind) {
    case "command":
      return false;
    case "subagent":
    case "monitor":
    case "workflow":
    case "background_task":
      return true;
  }
}

type PendingBackgroundWorkRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;

type PendingBackgroundWorkPullRequest = Pick<
  ThreadPullRequestLink,
  "host" | "repository" | "number" | "url" | "source" | "watch"
>;

type PendingBackgroundWorkProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "pendingBackgroundTasks"
>;

type PendingBackgroundWorkTurnItem = {
  readonly id: OrchestrationV2TurnItem["id"] | string;
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly title: string | null;
  /** When present and the run is rolled_back, the item is abandoned, not pending. */
  readonly runId?: OrchestrationV2Run["id"] | string | null;
  readonly nativeItemRef?: {
    readonly nativeId: string | null;
  } | null;
  readonly input?: unknown;
  readonly prompt?: string | undefined;
  readonly childThreadId?: ThreadId | null;
};

function isLatestRunSettledForBackgroundWait(
  latestRun: PendingBackgroundWorkRun | null | undefined,
): boolean {
  if (latestRun === undefined || latestRun === null) {
    return false;
  }
  return SETTLED_FOR_BACKGROUND_WAIT_RUN_STATUSES.has(latestRun.status);
}

function isPersistentDynamicToolInput(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

function descriptionFromTurnItem(item: PendingBackgroundWorkTurnItem): string | undefined {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (item.type === "command_execution" && typeof item.input === "string") {
    const command = item.input.trim();
    return command.length > 0 ? command : undefined;
  }
  if (item.type === "dynamic_tool") {
    const toolName = Reflect.get(item, "toolName");
    if (typeof toolName === "string" && toolName.trim().length > 0) {
      return toolName.trim();
    }
  }
  if (item.type === "subagent" && typeof item.prompt === "string") {
    const prompt = item.prompt.trim();
    return prompt.length > 0 ? prompt : undefined;
  }
  return undefined;
}

function pendingTaskFromTurnItem(
  taskId: string,
  item: PendingBackgroundWorkTurnItem,
): PendingBackgroundWorkTask {
  const description = descriptionFromTurnItem(item);
  const named = { taskId, ...(description === undefined ? {} : { description }) };
  switch (item.type) {
    case "subagent":
      return {
        ...named,
        kind: "subagent",
        ...(item.childThreadId == null ? {} : { childThreadId: item.childThreadId }),
      };
    case "command_execution":
      return { ...named, kind: "command" };
    default:
      return { ...named, kind: "background_task" };
  }
}

function nativeTaskIdFromTurnItem(item: PendingBackgroundWorkTurnItem): string {
  const nativeId = item.nativeItemRef?.nativeId;
  if (typeof nativeId === "string" && nativeId.length > 0) {
    return nativeId;
  }
  return String(item.id);
}

/**
 * The turn items the pending-work list names, without its settled-run gate.
 * Stop ends exactly these, so the list and Stop cannot disagree.
 */
export function pendingBackgroundTurnItems<Item extends PendingBackgroundWorkTurnItem>(input: {
  readonly turnItems: ReadonlyArray<Item>;
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
}): ReadonlyArray<Item> {
  const rolledBackRunIds = new Set(
    (input.runs ?? []).filter((run) => run.status === "rolled_back").map((run) => String(run.id)),
  );
  return input.turnItems.filter(
    (item) =>
      BACKGROUND_TURN_ITEM_TYPES.has(item.type) &&
      isOrchestrationV2WorkActive(item.status) &&
      !(item.type === "dynamic_tool" && isPersistentDynamicToolInput(item.input)) &&
      // Null/absent run id stays eligible; only known rolled_back runs drop.
      (item.runId === undefined ||
        item.runId === null ||
        !rolledBackRunIds.has(String(item.runId))),
  );
}

/**
 * Derive one normalized pending-background-work list for post-settlement UI.
 *
 * Sources:
 * - Provider-thread roster (Claude SDK background tasks)
 * - Active command_execution / dynamic_tool / subagent turn items
 * - Pull request watches, as monitors: a watch wakes the agent, so the thread
 *   stays working between wakes instead of returning to the inbox. Callers
 *   that pick a run to interrupt leave `pullRequests` out; Stop ends watches
 *   on its own.
 *
 * Gated on latest root run settlement. Dedupes by native task ID. Excludes
 * the roster while any interruptible foreground run remains active. Excludes
 * Grok persistent monitors (`dynamic_tool` input with `persistent: true`).
 * Excludes turn items whose run resolves to `rolled_back` (abandoned work);
 * items with a null or absent run id stay eligible (matches SQL shell path).
 * Does not consult subagent entities (those double-count turn items).
 */
export function derivePendingBackgroundWork(input: {
  readonly latestRun: PendingBackgroundWorkRun | null | undefined;
  readonly providerThreads: ReadonlyArray<PendingBackgroundWorkProviderThread>;
  readonly turnItems: ReadonlyArray<PendingBackgroundWorkTurnItem>;
  readonly activeProviderThreadId?: string | null;
  readonly hasActiveRun?: boolean;
  /**
   * Run rows used to exclude items owned by rolled_back runs. Optional for
   * callers that already filtered (SQL shell path); in-memory callers should
   * pass projection runs so policy cannot drift.
   */
  readonly runs?: ReadonlyArray<PendingBackgroundWorkRun>;
  readonly pullRequests?: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined;
}): ReadonlyArray<PendingBackgroundWorkTask> {
  const hasActiveRun =
    input.hasActiveRun ??
    input.runs?.some(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    ) ??
    false;
  if (hasActiveRun) {
    return [];
  }
  // A thread that never ran waits on nothing else, but a watch started on it still wakes it.
  if (input.latestRun == null) {
    return pullRequestWatchTasks(input.pullRequests);
  }
  if (!isLatestRunSettledForBackgroundWait(input.latestRun)) {
    return [];
  }

  const byTaskId = new Map<string, PendingBackgroundWorkTask>();

  const providerThreads =
    input.activeProviderThreadId === undefined || input.activeProviderThreadId === null
      ? input.providerThreads
      : input.providerThreads.filter((thread) => thread.id === input.activeProviderThreadId);

  for (const providerThread of providerThreads) {
    for (const task of providerThread.pendingBackgroundTasks ?? []) {
      if (task.taskId.length === 0 || byTaskId.has(task.taskId)) {
        continue;
      }
      const { description: rawDescription, ...named } = task;
      const description = rawDescription?.trim();
      byTaskId.set(task.taskId, {
        ...named,
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    }
  }

  for (const item of pendingBackgroundTurnItems(input)) {
    const taskId = nativeTaskIdFromTurnItem(item);
    if (byTaskId.has(taskId)) {
      continue;
    }

    byTaskId.set(taskId, pendingTaskFromTurnItem(taskId, item));
  }

  for (const task of pullRequestWatchTasks(input.pullRequests)) byTaskId.set(task.taskId, task);

  return Array.from(byTaskId.values());
}

function pullRequestWatchTasks(
  pullRequests: ReadonlyArray<PendingBackgroundWorkPullRequest> | undefined,
): Array<PendingBackgroundWorkTask> {
  return (pullRequests ?? []).flatMap((link) =>
    link.watch === undefined || link.source === "stack-dismissed"
      ? []
      : [
          {
            taskId: `pull-request-watch:${threadPullRequestKeyOf(link)}`,
            description: `Watching pull request #${link.number}`,
            kind: "monitor" as const,
          },
        ],
  );
}

/** What a running turn is waiting on: its newest unfinished tool or subagent. */
export interface ActiveRunWork<Time = unknown> {
  readonly label: string;
  readonly startedAt: Time;
  /** The thread a `studio_thread_wait` waits on, so the UI can link it. */
  readonly waitThreadId?: string;
}

/** Tools that wait on other work: a legitimate wait, never a stall of this thread. */
function waitTarget(item: {
  readonly type: string;
}): { readonly label: string; readonly threadId?: string } | null {
  if (item.type !== "dynamic_tool") return null;
  const toolName = Reflect.get(item, "toolName");
  if (typeof toolName !== "string") return null;
  // `mcp__studio-code__studio_thread_wait` and the bare name are the same tool.
  const tool = toolName.split("__").at(-1) ?? toolName;
  if (tool === "studio_thread_wait") {
    const input = Reflect.get(item, "input");
    const threadId =
      input !== null && typeof input === "object" ? Reflect.get(input, "threadId") : undefined;
    return typeof threadId === "string" && threadId.trim().length > 0
      ? { label: "another thread", threadId: threadId.trim() }
      : { label: "another thread" };
  }
  if (tool === "task_status" || tool === "delegate_task") return { label: "a delegated task" };
  return null;
}

const ACTIVE_WORK_LABEL_MAX = 60;

/**
 * The newest unfinished command, tool or subagent of the active run, or null
 * when the run is between steps. A long test suite shows here; a turn that
 * finished but never ended does not.
 */
export function deriveActiveRunWork<
  Time,
  Item extends {
    readonly type: OrchestrationV2TurnItem["type"];
    readonly status: OrchestrationV2TurnItem["status"];
    readonly runId?: OrchestrationV2Run["id"] | string | null;
    readonly startedAt: Time | null;
    readonly updatedAt: Time;
  },
>(input: {
  readonly activeRunId: OrchestrationV2Run["id"] | string | null;
  readonly turnItems: ReadonlyArray<Item>;
  readonly toMillis: (time: Time) => number;
}): ActiveRunWork<Time> | null {
  if (input.activeRunId === null) return null;
  let newest: Item | null = null;
  for (const item of input.turnItems) {
    if (String(item.runId ?? "") !== String(input.activeRunId)) continue;
    if (!BACKGROUND_TURN_ITEM_TYPES.has(item.type)) continue;
    if (!isOrchestrationV2WorkActive(item.status)) continue;
    if (
      newest === null ||
      input.toMillis(item.startedAt ?? item.updatedAt) >=
        input.toMillis(newest.startedAt ?? newest.updatedAt)
    ) {
      newest = item;
    }
  }
  if (newest === null) return null;
  const wait = waitTarget(newest);
  if (wait !== null) {
    return {
      label: wait.label,
      startedAt: newest.startedAt ?? newest.updatedAt,
      ...(wait.threadId === undefined ? {} : { waitThreadId: wait.threadId }),
    };
  }
  const description =
    descriptionFromTurnItem(newest as unknown as PendingBackgroundWorkTurnItem)
      ?.split("\n")[0]
      ?.trim() ?? "";
  const fallback = newest.type === "subagent" ? "a subagent" : "a tool";
  const label =
    description.length === 0
      ? fallback
      : description.length > ACTIVE_WORK_LABEL_MAX
        ? `${description.slice(0, ACTIVE_WORK_LABEL_MAX - 1)}…`
        : description;
  return { label, startedAt: newest.startedAt ?? newest.updatedAt };
}

/** A running turn with nothing in flight and no events for this long is stalled. */
export const RUN_STALL_IDLE_MS = 10 * 60_000;
/** A turn waiting on a command may stay quiet much longer: test suites, builds. */
export const RUN_STALL_WAITING_IDLE_MS = 2 * 60 * 60_000;

/** What a turn stopped to ask the person: an approval, an answer or a sign-in. */
export type RunAwaitingPerson = "approval" | "answer" | "sign-in";

const AWAITING_PERSON_LABELS: Record<RunAwaitingPerson, string> = {
  approval: "your approval",
  answer: "your answer",
  "sign-in": "your sign-in",
};

export type RunHealth =
  | { readonly state: "working"; readonly idleMs: number }
  | {
      readonly state: "waiting";
      readonly idleMs: number;
      readonly label: string;
      readonly waitingMs: number;
      /** Set when the wait is on another thread, which the UI links. */
      readonly waitThreadId?: string;
      /** Set when the turn waits on the person, which no quiet period turns into a stall. */
      readonly awaitingPerson?: RunAwaitingPerson;
    }
  | { readonly state: "stalled"; readonly idleMs: number; readonly label: string | null };

/**
 * Tells a long legitimate turn from a stuck one. `lastActivityMs` is the
 * thread's last provider event. Null when the turn is not running.
 */
export function classifyRunHealth(input: {
  readonly running: boolean;
  readonly lastActivityMs: number;
  readonly activeWork: {
    readonly label: string;
    readonly startedAtMs: number;
    readonly waitThreadId?: string | undefined;
  } | null;
  /**
   * True when the source cannot say what is in flight (a server older than
   * `activeWork`): quiet then means as little as a long command would.
   */
  readonly activeWorkUnknown?: boolean;
  /**
   * Set while the turn is blocked on a request to the person. Its quiet is the
   * person's, however long: never a stall. `sinceMs` is when it was asked.
   */
  readonly awaitingPerson?: {
    readonly kind: RunAwaitingPerson;
    readonly sinceMs: number;
  } | null;
  readonly nowMs: number;
}): RunHealth | null {
  if (!input.running) return null;
  const idleMs = Math.max(0, input.nowMs - input.lastActivityMs);
  const awaiting = input.awaitingPerson ?? null;
  if (awaiting !== null) {
    const sinceMs = Number.isFinite(awaiting.sinceMs) ? awaiting.sinceMs : input.lastActivityMs;
    return {
      state: "waiting",
      idleMs,
      label: AWAITING_PERSON_LABELS[awaiting.kind],
      waitingMs: Math.max(0, input.nowMs - sinceMs),
      awaitingPerson: awaiting.kind,
    };
  }
  if (input.activeWork === null) {
    const limit = input.activeWorkUnknown === true ? RUN_STALL_WAITING_IDLE_MS : RUN_STALL_IDLE_MS;
    return idleMs >= limit ? { state: "stalled", idleMs, label: null } : { state: "working", idleMs };
  }
  const waitThreadId = input.activeWork.waitThreadId;
  // Waiting on another thread is that thread's progress, not this one stalling.
  if (waitThreadId === undefined && idleMs >= RUN_STALL_WAITING_IDLE_MS) {
    return { state: "stalled", idleMs, label: input.activeWork.label };
  }
  return {
    state: "waiting",
    idleMs,
    label: input.activeWork.label,
    waitingMs: Math.max(0, input.nowMs - input.activeWork.startedAtMs),
    ...(waitThreadId === undefined ? {} : { waitThreadId }),
  };
}
