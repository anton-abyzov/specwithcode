/**
 * Subagents belong to the thread that started them, not to the list of threads.
 * A provider's own subagent (Claude's Agent tool, Codex's spawn) and a child a
 * worker started with delegate_task both get a backing thread so their work has
 * somewhere to stream, but the project shows them only through their parent: a
 * count in its header, a popover listing them and a read-only peek. A
 * coordinator's direct workers are the exception: they are the project's threads.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import {
  subagentExecutionStatus,
  threadAwaitingPerson,
  type SubagentExecutionStatus,
} from "@specweave-studio/client-runtime/state/models";
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import { isOrchestrationV2WorkActive } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import { isOrchestratorThreadId } from "./projectCoordinatorThreads";

type LineageShell = Pick<EnvironmentThreadShell, "id" | "environmentId" | "lineage">;

/** Subagents rarely nest deeply; the cap only stops a malformed cycle. */
const MAX_SUBAGENT_DEPTH = 16;

/**
 * True for a thread that is some other thread's subagent and so is never listed
 * or opened as a thread. A coordinator's own worker is a thread, whichever tool
 * started it; `coordinatorIds` names the coordinators the caller knows besides
 * the ones whose id says so.
 */
export function isNestedSubagentThread(
  thread: Pick<EnvironmentThreadShell, "lineage">,
  coordinatorIds: ReadonlySet<string> = EMPTY_IDS,
): boolean {
  // Shells from servers that predate lineage carry none: those are never subagents.
  const lineage = thread.lineage as typeof thread.lineage | undefined;
  const parent = lineage?.parentThreadId ?? null;
  if (lineage?.relationshipToParent !== "subagent" || parent === null) return false;
  return !isOrchestratorThreadId(parent) && !coordinatorIds.has(parent);
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * The thread a subagent is shown inside: its nearest ancestor that is a thread
 * itself. Null when the chain leaves the loaded shells.
 */
export function subagentHostThread<T extends LineageShell>(
  thread: T,
  lookup: (threadId: string) => T | undefined,
  coordinatorIds: ReadonlySet<string> = EMPTY_IDS,
): T | null {
  let current: T | undefined = thread;
  for (let step = 0; current && step < MAX_SUBAGENT_DEPTH; step += 1) {
    if (!isNestedSubagentThread(current, coordinatorIds))
      return current === thread ? null : current;
    const parent: string | null = current.lineage.parentThreadId;
    current = parent === null ? undefined : lookup(parent);
    if (current && current.environmentId !== thread.environmentId) return null;
  }
  return null;
}

/** Every subagent below a thread, nearest first, with its depth below it. */
export function subagentDescendants<
  T extends LineageShell & Pick<EnvironmentThreadShell, "deletedAt">,
>(
  shells: readonly T[],
  parent: Pick<EnvironmentThreadShell, "id" | "environmentId">,
  coordinatorIds: ReadonlySet<string> = EMPTY_IDS,
): Array<{ readonly thread: T; readonly depth: number }> {
  const children = new Map<string, T[]>();
  for (const shell of shells) {
    if (shell.deletedAt !== null || shell.environmentId !== parent.environmentId) continue;
    if (!isNestedSubagentThread(shell, coordinatorIds)) continue;
    const key = shell.lineage.parentThreadId!;
    const list = children.get(key);
    if (list) list.push(shell);
    else children.set(key, [shell]);
  }
  const result: Array<{ thread: T; depth: number }> = [];
  const seen = new Set<string>([parent.id]);
  const walk = (id: string, depth: number) => {
    if (depth > MAX_SUBAGENT_DEPTH) return;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push({ thread: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(parent.id, 0);
  return result;
}

export type SubagentEntryStatus = SubagentExecutionStatus;

/** One row of a thread's subagent popover. */
export interface SubagentEntry {
  readonly key: string;
  /** The backing thread whose transcript the peek shows; null before it starts. */
  readonly childThreadId: EnvironmentThreadShell["id"] | null;
  readonly title: string;
  readonly status: SubagentEntryStatus;
  readonly origin: OrchestrationV2Subagent["origin"] | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly prompt: string | null;
  readonly result: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly depth: number;
  /** A workflow is one script fanning out to many agents; its agents list as subagents. */
  readonly kind?: "subagent" | "workflow";
  /** Set while its run is blocked on the person; the row then reads waiting, not working. */
  readonly awaitingPerson?: SubagentAwaitingPerson;
}

export type SubagentAwaitingPerson = NonNullable<ReturnType<typeof threadAwaitingPerson>>["kind"];

/** What a backing thread's open request asks of the person, while its run is still open. */
function awaitingPersonOf(thread: EnvironmentThreadShell): SubagentAwaitingPerson | null {
  return threadAwaitingPerson(thread)?.kind ?? null;
}

type ProjectedSubagent = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "childThreadId"
  | "title"
  | "prompt"
  | "status"
  | "origin"
  | "providerInstanceId"
  | "model"
  | "result"
  | "startedAt"
  | "completedAt"
> &
  Partial<Pick<OrchestrationV2Subagent, "threadId">>;

function iso(value: DateTime.Utc | null): string | null {
  return value === null ? null : DateTime.formatIso(value);
}

/**
 * The subagents a thread started, from its own records (title, model, result)
 * and from the backing threads the client has loaded, so a row shows while the
 * parent's detail is still loading and nested subagents appear under theirs.
 */
export function threadSubagentEntries(input: {
  readonly parent: Pick<EnvironmentThreadShell, "id" | "environmentId">;
  readonly projected: readonly ProjectedSubagent[];
  readonly shells: readonly EnvironmentThreadShell[];
  readonly coordinatorIds?: ReadonlySet<string>;
  /** Hosts that do not answer now; their children read unknown. */
  readonly unreachable?: ReadonlySet<string> | undefined;
}): SubagentEntry[] {
  const coordinatorIds = input.coordinatorIds ?? EMPTY_IDS;
  // A projection can carry inherited history. Only this parent's records
  // supplement its explicitly linked subtree; never another thread's records.
  const projected = input.projected.filter(
    (agent) => agent.threadId === undefined || agent.threadId === input.parent.id,
  );
  const byChild = new Map(
    projected
      .filter((agent) => agent.childThreadId !== null)
      .map((agent) => [String(agent.childThreadId), agent]),
  );
  const entries: SubagentEntry[] = [];
  const listed = new Set<string>();
  const sameHost = new Map(
    input.shells
      .filter((shell) => shell.environmentId === input.parent.environmentId)
      .map((shell) => [String(shell.id), shell]),
  );
  for (const { thread, depth } of subagentDescendants(input.shells, input.parent, coordinatorIds)) {
    const agent = byChild.get(thread.id);
    listed.add(thread.id);
    const status = subagentExecutionStatus({
      record: agent,
      thread,
      parent: sameHost.get(String(thread.lineage.parentThreadId)),
      unreachable: input.unreachable,
    });
    // A run blocked on an approval or a question waits on the person, not on its work.
    const awaitingPerson = status === "unknown" ? null : awaitingPersonOf(thread);
    entries.push({
      key: thread.id,
      childThreadId: thread.id,
      title: agent?.title?.trim() || thread.title || "Subagent",
      status: awaitingPerson !== null && isSubagentEntryActive({ status }) ? "waiting" : status,
      ...(awaitingPerson === null ? {} : { awaitingPerson }),
      origin: agent?.origin ?? null,
      providerInstanceId: agent?.providerInstanceId ?? thread.modelSelection.instanceId,
      model: agent?.model ?? thread.modelSelection.model,
      prompt: agent?.prompt ?? null,
      result: agent?.result ?? null,
      startedAt: agent ? iso(agent.startedAt) : thread.createdAt,
      completedAt: agent
        ? iso(agent.completedAt)
        : threadRuntimeIsActive(thread.runtime)
          ? null
          : (thread.latestRun?.completedAt ?? null),
      depth,
    });
  }
  // Records whose backing thread has not reached this client yet still count.
  const listedRecords = new Set<string>();
  for (const agent of projected) {
    if (listedRecords.has(String(agent.id))) continue;
    listedRecords.add(String(agent.id));
    if (agent.childThreadId !== null) {
      if (listed.has(String(agent.childThreadId)) || sameHost.has(String(agent.childThreadId)))
        continue;
      listed.add(String(agent.childThreadId));
    }
    entries.push({
      key: agent.id,
      childThreadId: null,
      title: agent.title?.trim() || firstLine(agent.prompt) || "Subagent",
      status: input.unreachable?.has(input.parent.environmentId)
        ? "unknown"
        : subagentExecutionStatus({ record: agent }),
      origin: agent.origin,
      providerInstanceId: agent.providerInstanceId,
      model: agent.model,
      prompt: agent.prompt,
      result: agent.result,
      startedAt: iso(agent.startedAt),
      completedAt: iso(agent.completedAt),
      depth: 0,
    });
  }
  return entries;
}

export function isSubagentEntryActive(entry: Pick<SubagentEntry, "status">): boolean {
  return entry.status !== "unknown" && isOrchestrationV2WorkActive(entry.status);
}

/** Rows that count toward "Working · N subagents": at work, not waiting on the person. */
export function workingSubagentEntryCount(entries: readonly SubagentEntry[]): number {
  return entries.filter(
    (entry) =>
      entry.kind !== "workflow" && entry.awaitingPerson === undefined && entry.status === "running",
  ).length;
}

/**
 * How many of a thread's subagents are still working. Same verdict as its
 * popover rows; `projected` is the parent's own records when its detail is
 * loaded, so a completed record outranks a stale running child root.
 */
export function runningSubagentCount(
  shells: readonly EnvironmentThreadShell[],
  parent: Pick<EnvironmentThreadShell, "id" | "environmentId">,
  coordinatorIds: ReadonlySet<string> = EMPTY_IDS,
  projected: readonly ProjectedSubagent[] = [],
  unreachable?: ReadonlySet<string>,
): number {
  return workingSubagentEntryCount(
    threadSubagentEntries({
      parent,
      shells,
      coordinatorIds,
      unreachable,
      // Records without a loaded backing thread are counted by the popover, not the list.
      projected: projected.filter((agent) => agent.childThreadId !== null),
    }).filter((entry) => entry.childThreadId !== null),
  );
}

/**
 * "Working · N" for every listed thread. The open thread counts from its
 * popover rows; the others from their shells. Both read the parent's shell,
 * so a parent's count does not change with which thread is open.
 */
export function listedRunningSubagents(input: {
  readonly threads: readonly Pick<EnvironmentThreadShell, "id" | "environmentId">[];
  readonly shells: readonly EnvironmentThreadShell[];
  readonly coordinatorIds: ReadonlySet<string>;
  readonly unreachable?: ReadonlySet<string> | undefined;
  readonly selected: Pick<EnvironmentThreadShell, "id" | "environmentId"> | null;
  readonly selectedEntries: readonly SubagentEntry[];
}): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of input.threads) {
    const running =
      input.selected !== null &&
      thread.environmentId === input.selected.environmentId &&
      thread.id === input.selected.id
        ? workingSubagentEntryCount(input.selectedEntries)
        : runningSubagentCount(input.shells, thread, input.coordinatorIds, [], input.unreachable);
    if (running > 0) counts.set(`${thread.environmentId}:${thread.id}`, running);
  }
  return counts;
}

/** "Working · 2 subagents": the parent's status word with its working subagents. */
export function withRunningSubagents(word: string | null, running: number): string | null {
  if (running <= 0) return word;
  const count = `${running} ${running === 1 ? "subagent" : "subagents"}`;
  return `${word ?? "Working"} · ${count}`;
}

export function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !/^#+\s*$/.test(part));
  if (!line) return null;
  const plain = line.replace(/^#+\s+/, "").replace(/\*\*/g, "");
  return plain.length > 140 ? `${plain.slice(0, 137)}...` : plain;
}

export const SUBAGENT_STATUS_LABELS: Record<SubagentEntryStatus, string> = {
  idle: "Idle",
  pending: "Starting",
  running: "Working",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted, rerun pending",
  unknown: "Unknown (machine unreachable)",
};

const AWAITING_PERSON_LABELS: Record<SubagentAwaitingPerson, string> = {
  approval: "Approval requested",
  answer: "Answer needed",
  "sign-in": "Sign-in needed",
};

/** A row's status words: what it waits on from the person, or its status. */
export function subagentEntryLabel(
  entry: Pick<SubagentEntry, "status" | "awaitingPerson">,
): string {
  return entry.awaitingPerson === undefined
    ? SUBAGENT_STATUS_LABELS[entry.status]
    : `${isSubagentEntryActive(entry) ? "" : `${SUBAGENT_STATUS_LABELS[entry.status]} · `}${AWAITING_PERSON_LABELS[entry.awaitingPerson]}`;
}

export function subagentStatusTone(
  status: SubagentEntryStatus,
): "working" | "failed" | "waiting" | "done" | "idle" {
  if (status === "running" || status === "pending") return "working";
  if (status === "waiting") return "waiting";
  if (status === "failed" || status === "interrupted") return "failed";
  if (status === "completed") return "done";
  return "idle";
}

const WORKFLOW_TOOL_NAMES = new Set(["Workflow", "workflow"]);

/** The workflow's `meta.name`, or the saved workflow it ran. */
function workflowName(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const name = Reflect.get(input, "name");
  if (typeof name === "string" && name.trim()) return name.trim();
  const script = Reflect.get(input, "script");
  if (typeof script !== "string") return null;
  return /meta\s*=\s*\{[\s\S]*?\bname\s*:\s*["'`]([^"'`]+)["'`]/u.exec(script)?.[1]?.trim() ?? null;
}

function workflowDescription(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const script = Reflect.get(input, "script");
  if (typeof script !== "string") return null;
  return (
    /meta\s*=\s*\{[\s\S]*?\bdescription\s*:\s*["'`]([^"'`]+)["'`]/u.exec(script)?.[1]?.trim() ??
    null
  );
}

/**
 * The workflows a thread ran, as rows beside its subagents: the Workflow tool
 * calls in its items, marked running while the provider still lists the
 * workflow as background work, with that work's current phase as progress.
 */
export function threadWorkflowEntries(input: {
  readonly parentThreadId?: string;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): SubagentEntry[] {
  const running = input.pendingBackgroundTasks.filter((task) => task.kind === "workflow");
  const unclaimed = new Set(running.map((task) => task.taskId));
  const entries: SubagentEntry[] = [];
  for (const item of input.turnItems) {
    if (input.parentThreadId !== undefined && item.threadId !== input.parentThreadId) continue;
    if (item.type !== "dynamic_tool" || item.toolName === null) continue;
    if (!WORKFLOW_TOOL_NAMES.has(item.toolName.split("__").at(-1) ?? "")) continue;
    const name = workflowName(item.input);
    // The provider names the background task after the workflow.
    const task =
      running.find(
        (candidate) =>
          unclaimed.has(candidate.taskId) &&
          name !== null &&
          candidate.description?.toLowerCase().includes(name.toLowerCase()),
      ) ?? null;
    if (task) unclaimed.delete(task.taskId);
    const failed = item.status === "failed";
    entries.push({
      key: `workflow:${item.id}`,
      childThreadId: null,
      title: name ?? task?.description ?? "Workflow",
      status: task ? "running" : failed ? "failed" : "completed",
      origin: null,
      providerInstanceId: null,
      model: null,
      prompt: workflowDescription(item.input),
      result: task && "progress" in task ? (task.progress ?? null) : null,
      startedAt: iso(item.startedAt ?? item.updatedAt),
      completedAt: task ? null : iso(item.updatedAt),
      depth: 0,
      kind: "workflow",
    });
  }
  for (const task of running) {
    if (!unclaimed.has(task.taskId)) continue;
    entries.push({
      key: `workflow:${task.taskId}`,
      childThreadId: null,
      title: task.description ?? "Workflow",
      status: "running",
      origin: null,
      providerInstanceId: null,
      model: null,
      prompt: null,
      result: "progress" in task ? (task.progress ?? null) : null,
      startedAt: null,
      completedAt: null,
      depth: 0,
      kind: "workflow",
    });
  }
  return entries;
}

/** Keep whole ancestry branches together while promoting any live descendant. */
export function groupSubagentPopupEntries(
  entries: readonly SubagentEntry[],
  now: number,
): {
  current: SubagentEntry[];
  history: SubagentEntry[];
} {
  type Branch = { entry: SubagentEntry; children: Branch[]; rank: number; at: number };
  const roots: Branch[] = [];
  const stack: Branch[] = [];
  const recentSince = now - 30 * 60_000;
  const priority = (entry: SubagentEntry) =>
    entry.awaitingPerson !== undefined
      ? 0
      : ["running", "pending", "waiting"].includes(entry.status)
        ? 1
        : entry.status === "unknown"
          ? 2
          : Number.isFinite(Date.parse(entry.completedAt ?? "")) &&
              Date.parse(entry.completedAt!) >= recentSince
            ? 3
            : 4;
  for (const entry of entries) {
    while (stack.length && stack.at(-1)!.entry.depth >= entry.depth) stack.pop();
    const branch: Branch = {
      entry,
      children: [],
      rank: priority(entry),
      at: Date.parse(entry.completedAt ?? entry.startedAt ?? "") || 0,
    };
    (stack.at(-1)?.children ?? roots).push(branch);
    stack.push(branch);
  }
  const rank = (branch: Branch) => {
    for (const child of branch.children) {
      rank(child);
      branch.rank = Math.min(branch.rank, child.rank);
      branch.at = Math.max(branch.at, child.at);
    }
    branch.children.sort((a, b) => a.rank - b.rank || b.at - a.at);
  };
  roots.forEach(rank);
  roots.sort((a, b) => a.rank - b.rank || b.at - a.at);
  const result = { current: [] as SubagentEntry[], history: [] as SubagentEntry[] };
  const flatten = (branch: Branch, target: SubagentEntry[]) => {
    target.push(branch.entry);
    branch.children.forEach((child) => flatten(child, target));
  };
  roots.forEach((branch) => flatten(branch, branch.rank < 4 ? result.current : result.history));
  return result;
}
