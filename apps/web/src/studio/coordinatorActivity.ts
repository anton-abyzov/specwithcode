/**
 * What the project coordinator's conversation shows of its own work at each
 * timeline detail level. Normal is the conversation as it always was. Concise
 * keeps one reply per turn. Verbose adds each turn's steps under its last reply,
 * and the running turn's steps above the live progress line.
 *
 * @module coordinatorActivity
 */
import type { TimelineDetail } from "@specweave-studio/contracts";

import { itemLabel, toolLabel } from "./coordinatorProgress";

export type ActivityMessage = {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly runId: string | null;
  /** Shown as a system notice (a worker report), never hidden. */
  readonly notice: boolean;
};

export type ActivityItem = {
  readonly id: string;
  readonly runId: string | null;
  readonly ordinal: number;
  readonly type: string;
  readonly status: string;
  readonly parentItemId?: string | null | undefined;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
  /** A tool call's compact result; a worker launch names the task it started. */
  readonly output?: unknown;
  /** A worker item's task, and the thread it runs in. */
  readonly subagentId?: string | undefined;
  readonly childThreadId?: string | null | undefined;
  readonly fileName?: string | undefined;
  readonly pattern?: string | undefined;
  readonly patterns?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
  readonly prompt?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly outputIndicatesFailure?: boolean | undefined;
};

export type ActivityRun = { readonly id: string; readonly status: string };

export type RunActivityStep = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** The detail is prose (a thought), not a command or path. */
  readonly prose?: true;
  readonly failed: boolean;
};

export type RunActivity = {
  readonly runId: string;
  readonly summary: string;
  readonly steps: ReadonlyArray<RunActivityStep>;
};

export type CoordinatorConversationView = {
  readonly hiddenMessageIds: ReadonlySet<string>;
  /**
   * Concise: the hidden replies each shown reply stands in for, oldest first, so
   * the thread cards and attachments they carried move to the reply that shows.
   */
  readonly foldedIntoMessageId: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly activityByMessageId: ReadonlyMap<string, RunActivity>;
  readonly liveActivity: RunActivity | null;
};

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const DETAIL_LIMIT = 200;

type Category =
  | "worker"
  | "message"
  | "threads"
  | "command"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "memory"
  | "other";

const CATEGORY_ORDER: ReadonlyArray<Category> = [
  "worker",
  "threads",
  "message",
  "command",
  "edit",
  "read",
  "search",
  "web",
  "memory",
  "other",
];

function bareToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "");
}

function categorize(item: ActivityItem): Category | null {
  switch (item.type) {
    case "subagent":
      return "worker";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "web";
    case "dynamic_tool": {
      const tool = bareToolName(item.toolName ?? "");
      if (/^(delegate_task|studio_thread_launch|studio_thread_create|Task|Agent)$/.test(tool))
        return "worker";
      if (tool.startsWith("studio_thread_send")) return "message";
      // A delegated worker's status is a look at its thread.
      if (/^studio_thread_(list|read|wait)/.test(tool) || tool === "task_status") return "threads";
      if (tool === "Bash") return "command";
      if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return "edit";
      if (/^(Read|NotebookRead)$/.test(tool)) return "read";
      if (/^(Grep|Glob|LS)$/.test(tool)) return "search";
      if (/^Web(Search|Fetch)$/.test(tool)) return "web";
      if (tool.startsWith("studio_project_memory")) return "memory";
      // Loading tools and planning say nothing about the work itself.
      if (tool === "ToolSearch" || tool === "TodoWrite") return null;
      return "other";
    }
    default:
      return null;
  }
}

function plural(count: number, one: string, many: string): string {
  return (count === 1 ? one : many).replace("#", String(count));
}

/** A repeated action: "checked threads", then "checked threads 3 times". */
function repeated(count: number, phrase: string): string {
  return count === 1 ? phrase : `${phrase} ${count} times`;
}

// Countable work names its count, as the thread view's summaries do.
function categoryPhrase(category: Category, count: number): string {
  switch (category) {
    case "worker":
      return plural(count, "started 1 worker", "started # workers");
    case "command":
      return plural(count, "ran 1 command", "ran # commands");
    case "edit":
      return plural(count, "changed 1 file", "changed # files");
    case "read":
      return plural(count, "read 1 file", "read # files");
    case "message":
      return plural(count, "sent 1 message to a worker", "sent # messages to workers");
    case "threads":
      return repeated(count, "checked threads");
    case "search":
      return repeated(count, "searched code");
    case "web":
      return repeated(count, "searched the web");
    case "memory":
      return repeated(count, "used project memory");
    case "other":
      return plural(count, "used 1 other tool", "used # other tools");
  }
}

/** The file a read or edit worked on, so the summary counts files, not calls. */
function filePath(item: ActivityItem): string | undefined {
  if (item.type === "file_change") return item.fileName;
  if (typeof item.input !== "object" || item.input === null) return undefined;
  const fields = item.input as Record<string, unknown>;
  const path = fields.file_path ?? fields.notebook_path ?? fields.path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

const WORKER_LAUNCH_TOOL = /^(delegate_task|studio_thread_launch|studio_thread_create)$/;

/** What a worker-launching tool call reports it started, once it has answered. */
function launchedIds(item: ActivityItem): ReadonlyArray<string> {
  if (item.type !== "dynamic_tool" || !WORKER_LAUNCH_TOOL.test(bareToolName(item.toolName ?? "")))
    return [];
  if (typeof item.output !== "object" || item.output === null) return [];
  // The wire keeps a compact result ({ taskId, threadId }); a full one nests it.
  const output = item.output as Record<string, unknown>;
  const nested = output.structuredContent;
  return [output, typeof nested === "object" && nested !== null ? nested : {}].flatMap((fields) =>
    ["taskId", "threadId", "childThreadId"].flatMap((key) => {
      const value = (fields as Record<string, unknown>)[key];
      return typeof value === "string" && value !== "" ? [value] : [];
    }),
  );
}

/**
 * The coordinator's own items, without those of a worker it watches. A worker
 * started through a Studio tool shows up twice, as the tool call and as the
 * worker the host records for it; the tool call stands for both.
 */
function ownItems(items: ReadonlyArray<ActivityItem>): ReadonlyArray<ActivityItem> {
  const own = items.filter((item) => item.parentItemId == null);
  const launched = new Set(own.flatMap(launchedIds));
  if (launched.size === 0) return own;
  return own.filter(
    (item) =>
      item.type !== "subagent" ||
      !(
        (item.subagentId !== undefined && launched.has(item.subagentId)) ||
        (item.childThreadId != null && launched.has(item.childThreadId))
      ),
  );
}

/** "Started 2 workers, ran 3 commands and read 4 files"; "Thought" for thinking alone. */
export function summarizeRunItems(items: ReadonlyArray<ActivityItem>): string | null {
  const keys = new Map<Category, Set<string>>();
  let thought = false;
  for (const item of ownItems(items)) {
    if (item.type === "reasoning") thought = true;
    const category = categorize(item);
    if (category === null) continue;
    const key = category === "read" || category === "edit" ? (filePath(item) ?? item.id) : item.id;
    const seen = keys.get(category) ?? new Set<string>();
    seen.add(key);
    keys.set(category, seen);
  }
  const phrases = CATEGORY_ORDER.flatMap((category) => {
    const count = keys.get(category)?.size;
    return count === undefined ? [] : [categoryPhrase(category, count)];
  });
  if (phrases.length === 0) return thought ? "Thought" : null;
  const sentence =
    phrases.length === 1 ? phrases[0]! : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function clip(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]!.trim();
}

function stepDetail(item: ActivityItem): string | undefined {
  let detail: string | undefined;
  switch (item.type) {
    case "command_execution":
      detail = typeof item.input === "string" ? firstLine(item.input) : undefined;
      break;
    case "file_change":
      detail = item.fileName;
      break;
    case "file_search":
      detail = item.pattern;
      break;
    case "web_search":
      detail = item.patterns?.join(", ");
      break;
    case "reasoning":
      detail = item.text?.replace(/\s+/g, " ").trim();
      break;
    case "subagent":
      detail = item.prompt === undefined ? undefined : firstLine(item.prompt);
      break;
    case "dynamic_tool":
      // What the call worked on; the tool's own name only where the label is vague.
      detail =
        toolInputDetail(item.input) ??
        (item.toolName && categorize(item) === "other" ? bareToolName(item.toolName) : undefined);
      break;
  }
  return detail ? clip(detail) : undefined;
}

/** Input fields that name what a tool call worked on, most telling first. */
const INPUT_DETAIL_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
  "title",
  "prompt",
  "description",
] as const;

function toolInputDetail(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of INPUT_DETAIL_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return firstLine(value);
  }
  return undefined;
}

/** The progress line's present-tense labels, as they read once the step is over. */
const PAST_TENSE: Record<string, string> = {
  Thinking: "Thought",
  Replying: "Replied",
  "Starting a worker": "Started a worker",
  "Passing your message to a worker": "Passed your message to a worker",
  "Checking the project's threads": "Checked the project's threads",
  "Saving to project memory": "Saved to project memory",
  "Reading project memory": "Read project memory",
  "Loading its tools": "Loaded its tools",
  "Running a command": "Ran a command",
  "Reading files": "Read files",
  "Editing files": "Edited files",
  "Searching the web": "Searched the web",
  Planning: "Planned",
  "Waiting for an answer": "Asked for an answer",
  Working: "Worked",
};
const STEP_IN_PROGRESS = new Set(["idle", "pending", "running", "waiting"]);

/** One step reads or edits one file, or searches; the progress line's wording is broader. */
const STEP_WORDING: Record<string, { readonly present: string; readonly past: string }> = {
  read: { present: "Reading a file", past: "Read a file" },
  edit: { present: "Editing a file", past: "Edited a file" },
  search: { present: "Searching code", past: "Searched code" },
};

function stepLabel(item: ActivityItem): string | null {
  const inProgress = STEP_IN_PROGRESS.has(item.status);
  const category =
    item.type === "file_change" || item.type === "file_search" || item.type === "dynamic_tool"
      ? categorize(item)
      : null;
  const wording = category === null ? undefined : STEP_WORDING[category];
  if (wording && (category === "search" || filePath(item) !== undefined))
    return inProgress ? wording.present : wording.past;
  const label =
    item.type === "dynamic_tool" && item.toolName
      ? toolLabel(item.toolName)
      : itemLabel({ ...item, toolName: item.toolName ?? null });
  if (label === null || inProgress) return label;
  return PAST_TENSE[label] ?? label;
}

const STEP_TYPES = new Set([
  "reasoning",
  "subagent",
  "dynamic_tool",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "todo_list",
  "approval_request",
  "user_input_request",
]);

export function runActivity(runId: string, items: ReadonlyArray<ActivityItem>): RunActivity | null {
  return activityOf(
    runId,
    items.filter((item) => item.runId === runId),
  );
}

/** One run's activity from its own items. */
function activityOf(runId: string, runItems: ReadonlyArray<ActivityItem>): RunActivity | null {
  const own = ownItems(runItems);
  const summary = summarizeRunItems(own);
  if (summary === null) return null;
  const steps = own
    .filter((item) => STEP_TYPES.has(item.type))
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .flatMap((item): RunActivityStep[] => {
      const label = stepLabel(item);
      if (label === null) return [];
      const detail = stepDetail(item);
      return [
        {
          id: item.id,
          label,
          ...(detail === undefined ? {} : { detail }),
          ...(detail !== undefined && item.type === "reasoning" ? { prose: true as const } : {}),
          failed:
            item.status === "failed" ||
            item.outputIndicatesFailure === true ||
            (item.exitCode !== undefined && item.exitCode !== 0),
        },
      ];
    });
  return { runId, summary, steps };
}

const EMPTY_VIEW: CoordinatorConversationView = {
  hiddenMessageIds: new Set(),
  foldedIntoMessageId: new Map(),
  activityByMessageId: new Map(),
  liveActivity: null,
};

export function coordinatorConversationView(input: {
  readonly messages: ReadonlyArray<ActivityMessage>;
  readonly turnItems: ReadonlyArray<ActivityItem>;
  readonly runs: ReadonlyArray<ActivityRun>;
  readonly detail: TimelineDetail;
}): CoordinatorConversationView {
  if (input.detail === "normal") return EMPTY_VIEW;
  // A reply that is not a notice belongs to its run; the last one is the run's answer.
  const repliesByRun = new Map<string, string[]>();
  for (const message of input.messages) {
    if (message.role !== "assistant" || message.notice || message.runId === null) continue;
    const replies = repliesByRun.get(message.runId) ?? [];
    replies.push(message.id);
    repliesByRun.set(message.runId, replies);
  }
  if (input.detail === "concise") {
    const foldedIntoMessageId = new Map<string, ReadonlyArray<string>>();
    for (const replies of repliesByRun.values()) {
      if (replies.length > 1) foldedIntoMessageId.set(replies.at(-1)!, replies.slice(0, -1));
    }
    return {
      ...EMPTY_VIEW,
      hiddenMessageIds: new Set([...foldedIntoMessageId.values()].flat()),
      foldedIntoMessageId,
    };
  }
  // One pass over the items, so a long history costs its length, not runs × items.
  const itemsByRun = new Map<string, ActivityItem[]>();
  for (const item of input.turnItems) {
    if (item.runId === null) continue;
    const runItems = itemsByRun.get(item.runId);
    if (runItems) runItems.push(item);
    else itemsByRun.set(item.runId, [item]);
  }
  const activityByMessageId = new Map<string, RunActivity>();
  let liveActivity: RunActivity | null = null;
  for (const run of input.runs) {
    const runItems = itemsByRun.get(run.id);
    if (runItems === undefined) continue;
    const live = ACTIVE_RUN.has(run.status);
    const answer = live ? undefined : repliesByRun.get(run.id)?.at(-1);
    if (!live && answer === undefined) continue;
    const activity = activityOf(run.id, runItems);
    if (activity === null) continue;
    if (live) liveActivity = activity;
    else activityByMessageId.set(answer!, activity);
  }
  return { ...EMPTY_VIEW, activityByMessageId, liveActivity };
}

/**
 * What a shown reply carries in Concise: the entries of the replies it stands
 * in for, oldest first, then its own, without repeats.
 */
export function withFoldedReplies<T>(
  view: CoordinatorConversationView,
  messageId: string,
  own: ReadonlyArray<T>,
  of: (hiddenMessageId: string) => ReadonlyArray<T>,
): ReadonlyArray<T> {
  const folded = view.foldedIntoMessageId.get(messageId);
  if (folded === undefined) return own;
  const merged = [...folded.flatMap(of), ...own];
  return merged.filter((value, index) => merged.indexOf(value) === index);
}
