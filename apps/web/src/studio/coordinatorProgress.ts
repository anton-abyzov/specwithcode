/**
 * What the project coordinator is doing right now, in the words the project
 * pane shows under the conversation while a turn runs. A send is answered by
 * this line within a second, so the person never stares at a silent pane while
 * the coordinator boots, thinks and starts workers.
 *
 * @module coordinatorProgress
 */
import { epochMillis } from "./projectThreadMentions";
import { limitContinuationKind } from "./runIdentity";

type ProgressRun = {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly requestedAt: unknown;
  readonly userMessageId?: string | null;
};

export type ProgressItem = {
  readonly runId: string | null;
  readonly ordinal: number;
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null;
};

export type CoordinatorProgress = {
  /** One short phrase, without a trailing ellipsis. */
  readonly label: string;
  /** When this turn was asked for, as an ISO string; the pane counts up from it. Null hides the count. */
  readonly since: string | null;
  /** Blocked on someone's answer rather than working. */
  readonly waiting: boolean;
};

const ACTIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const EXECUTING = new Set(["preparing", "starting", "running", "waiting"]);
const ANSWER_LABEL = "Waiting for an answer";

export function toolLabel(name: string): string {
  const tool = name.replace(/^mcp__.+?__/, "");
  if (/^(delegate_task|studio_thread_launch|studio_thread_create)/.test(tool))
    return "Starting a worker";
  if (/^studio_thread_send/.test(tool)) return "Passing your message to a worker";
  if (/^studio_thread_(list|read|wait)/.test(tool) || tool === "task_status")
    return "Checking the project's threads";
  if (/^studio_project_memory_write/.test(tool)) return "Saving to project memory";
  if (/^studio_project_memory/.test(tool)) return "Reading project memory";
  if (tool === "ToolSearch") return "Loading its tools";
  if (tool === "Bash") return "Running a command";
  if (/^(Read|Grep|Glob|LS)$/.test(tool)) return "Reading files";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return "Editing files";
  if (/^Web(Search|Fetch)$/.test(tool)) return "Searching the web";
  if (tool === "TodoWrite") return "Planning";
  if (/^(Task|Agent)$/.test(tool)) return "Starting a worker";
  return "Working";
}

export function itemLabel(item: ProgressItem): string | null {
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "assistant_message":
      return "Replying";
    case "subagent":
      return "Starting a worker";
    case "dynamic_tool":
      return item.toolName ? toolLabel(item.toolName) : "Working";
    case "command_execution":
      return "Running a command";
    case "file_change":
      return "Editing files";
    case "file_search":
      return "Reading files";
    case "web_search":
      return "Searching the web";
    case "todo_list":
    case "proposed_plan":
      return "Planning";
    case "approval_request":
    case "user_input_request":
      return ANSWER_LABEL;
    default:
      // Messages in, checkpoints, notices and bookkeeping say nothing about the work.
      return null;
  }
}

/**
 * The latest step among a turn's items, in the pane's words, or null when the
 * items say nothing yet. Items arrive out of order, so the highest ordinal wins.
 */
export function latestWorkStep(items: ReadonlyArray<ProgressItem>): string | null {
  return (
    items
      .toSorted((left, right) => right.ordinal - left.ordinal)
      .map(itemLabel)
      .find((label) => label !== null) ?? null
  );
}

export function coordinatorProgress(projection: {
  readonly runs?: ReadonlyArray<ProgressRun>;
  readonly turnItems?: ReadonlyArray<ProgressItem>;
}): CoordinatorProgress | null {
  const active = (projection.runs ?? [])
    .filter((run) => ACTIVE.has(run.status))
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const run = active.find((candidate) => EXECUTING.has(candidate.status)) ?? active[0];
  if (run === undefined) return null;
  const sinceOf = (candidate: ProgressRun) => {
    const requested = epochMillis(candidate.requestedAt);
    return requested === null ? null : new Date(requested).toISOString();
  };
  const since = sinceOf(run);
  const at = (label: string) => ({ label, since, waiting: false });
  // A usage limit moved the turn on by itself: say so, not that a new message came in.
  const continued = startLabelOf(run);
  if (run.status === "queued") return at(continued ?? "Starting the coordinator");
  if (run.status === "waiting") {
    // A "waiting" run has finished its turn and is saving its checkpoint; the next message
    // starts only after that, so name the hold-up and count from the message that waits on it.
    const next = active.find((candidate) => candidate.status === "queued");
    if (next !== undefined)
      return { label: "Finishing the previous turn", since: sinceOf(next), waiting: false };
    return at("Finishing the turn");
  }
  const latest = latestWorkStep(
    (projection.turnItems ?? []).filter((item) => item.runId === run.id),
  );
  if (latest !== null) return { label: latest, since, waiting: latest === ANSWER_LABEL };
  if (continued !== null) return at(continued);
  // A turn can be woken by a worker's report as well as by the person, so say neither.
  return at(run.status === "running" ? "Reading the new message" : "Starting the coordinator");
}

function startLabelOf(run: ProgressRun): string | null {
  switch (limitContinuationKind(run.userMessageId ?? "")) {
    case "fallback":
      return "Usage limit reached, continuing on the next model";
    case "provider-fallback":
      return "Provider could not start, continuing on the next model";
    case "reset":
    case "return":
      return "Usage limit reset, continuing";
    case "credits":
    case "api":
      return "Usage limit reached, continuing with credits";
    case null:
      return null;
  }
}

/** "8s", "1m 05s": short enough to count up beside the label every second. */
export function formatProgressElapsed(since: string, nowMs: number): string {
  const start = Date.parse(since);
  const seconds = Number.isFinite(start) ? Math.max(0, Math.floor((nowMs - start) / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
