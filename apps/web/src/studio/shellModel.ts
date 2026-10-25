import type { ProjectAttention } from "@specweave-studio/client-runtime/state/projectAttention";
/**
 * View logic for the three-pane shell: the projects and chats sidebar, the
 * orchestrator pane and the project's Threads pane. Pure, so every rule that
 * decides what a row says or where it sorts has a test.
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import { PROVIDER_DISPLAY_NAMES } from "@specweave-studio/contracts";
import { isSidebarSubagentThread, resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { isOrchestratorThreadId } from "./projectCoordinatorThreads";
import {
  projectThreadGroup,
  threadActivityAt,
  type ProjectThreadGroup,
  threadBlocker,
  threadHeldQueue,
} from "./projectWorkspaceModel";

/** The slice of a provider instance that names it; `ProviderInstanceEntry` satisfies it. */
export type ProviderNameSource = {
  readonly driverKind: string;
  readonly displayName: string;
  readonly acpRegistryAgentId?: string | undefined;
  readonly models?: ReadonlyArray<{ readonly slug: string; readonly name?: string | undefined }>;
};

const BRAND_BY_HINT: ReadonlyArray<readonly [RegExp, string]> = [
  [/copilot/i, "Copilot"],
  [/claude/i, "Claude"],
  [/codex|openai|chatgpt/i, "Codex"],
  [/grok|xai/i, "Grok"],
  [/cursor/i, "Cursor"],
  [/gemini|antigravity/i, "Gemini"],
  [/opencode/i, "OpenCode"],
  [/^pi\b/i, "Pi"],
];

function brandFromHint(value: string): string | null {
  for (const [pattern, label] of BRAND_BY_HINT) if (pattern.test(value)) return label;
  return null;
}

/** The maker's brand behind an instance: Claude, Codex, Copilot. */
function providerBrand(entry: ProviderNameSource | null, instanceId: string): string {
  if (entry) {
    if (entry.driverKind === "acpRegistry")
      return (
        brandFromHint(entry.acpRegistryAgentId ?? "") ??
        brandFromHint(entry.displayName) ??
        entry.displayName
      );
    const known = (PROVIDER_DISPLAY_NAMES as Record<string, string | undefined>)[entry.driverKind];
    if (known) return known;
    return brandFromHint(entry.displayName) ?? entry.displayName;
  }
  return brandFromHint(instanceId) ?? instanceId;
}

// "Claude" alone reads as the model's maker; the harness that runs the thread is Claude Code.
const HARNESS_BY_BRAND: Readonly<Record<string, string>> = { Claude: "Claude Code" };

/**
 * The harness that runs a thread, named so it cannot be mistaken for the model:
 * Claude Code, Codex, Copilot. A registry agent is named for the agent
 * (Copilot), never for the transport ("ACP Registry").
 */
export function providerShortLabel(entry: ProviderNameSource | null, instanceId: string): string {
  const brand = providerBrand(entry, instanceId);
  return HARNESS_BY_BRAND[brand] ?? brand;
}

const UPPERCASE_WORDS = new Set(["gpt", "xl", "ai", "oss"]);
const CLAUDE_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable"]);

function titleWord(word: string): string {
  if (UPPERCASE_WORDS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A model slug as people say it: `claude-opus-5-5[1m]` is "Opus 5.5",
 * `gpt-6-astra` is "GPT-6 Astra". Dates and context-window suffixes are noise
 * in a list row and are dropped.
 */
export function shortModelName(slug: string): string {
  const cleaned = slug
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^[a-z0-9.-]+\//i, "")
    .replace(/-(?:20\d{6}|latest|preview)$/i, "");
  if (!cleaned) return "Model not set";
  const parts = cleaned.split(/[-_\s]+/).filter(Boolean);
  // Adjacent bare numbers are one version: 5-5 reads 5.5.
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (/^\d+$/.test(part) && previous !== undefined && /^\d+$/.test(previous))
      merged[merged.length - 1] = `${previous}.${part}`;
    else merged.push(part);
  }
  if (merged[0]?.toLowerCase() === "claude" && merged.length > 1) {
    const rest = merged.slice(1);
    const family = rest.find((part) => CLAUDE_FAMILIES.has(part.toLowerCase()));
    const version = rest.find((part) => /^\d+(?:\.\d+)?$/.test(part));
    if (family) return version ? `${titleWord(family)} ${version}` : titleWord(family);
    return rest.map(titleWord).join(" ");
  }
  if (merged[0]?.toLowerCase() === "gpt" && merged[1] !== undefined && /^\d/.test(merged[1]))
    return [`GPT-${merged[1]}`, ...merged.slice(2).map(titleWord)].join(" ");
  return merged.map(titleWord).join(" ");
}

export type ModelLabel = {
  /** The harness that runs it: Claude Code, Codex, Copilot, Grok. */
  readonly provider: string;
  /** Which model, without repeating the provider. */
  readonly model: string;
  /** The whole thing for a tooltip or a screen reader. */
  readonly full: string;
};

/** The catalogue name wins when the host publishes one; the slug is the fallback. */
export function modelLabel(
  entry: ProviderNameSource | null,
  instanceId: string,
  slug: string,
): ModelLabel {
  const brand = providerBrand(entry, instanceId);
  const provider = HARNESS_BY_BRAND[brand] ?? brand;
  const catalogued = entry?.models?.find((model) => model.slug === slug)?.name?.trim();
  let model = catalogued || shortModelName(slug);
  // A short name drops "Claude"; through another harness the maker is the point.
  if (
    !catalogued &&
    brand !== "Claude" &&
    /^claude[-_\s]/i.test(slug.trim()) &&
    !/^claude\b/i.test(model)
  )
    model = `Claude ${model}`;
  // "Claude Code · Claude Opus 5.5" says Claude twice; Copilot keeps the maker's name.
  const prefix = new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
  // "Grok 5" keeps its name: a bare "5" is a version, not a model.
  if (prefix.test(model) && /[a-z]/i.test(model.replace(prefix, "")))
    model = model.replace(prefix, "");
  const full = model.toLowerCase().startsWith(brand.toLowerCase())
    ? model
    : `${provider} · ${model}`;
  return { provider, model, full };
}

/**
 * A machine's name for a tight line: "Anton's MacBook M4MAX (149)" reads as
 * "MacBook M4MAX (149)". Every machine is the user's own, so the owner adds
 * nothing; the full name stays for the tooltip.
 */
export function shortMachineName(label: string): string {
  const trimmed = label.trim();
  const rest = trimmed.replace(/^[^\s'’]+['’]s\s+/u, "");
  return rest === "" ? trimmed : rest;
}

// ── Chats: the sidebar's list of sessions ────────────────────────────────────

/**
 * Effort advised for a coordinator: it plans and routes rather than writes the
 * code, so Medium answers faster at the same quality. Keyed by trait id.
 */
export const COORDINATOR_RECOMMENDED_TRAITS: Readonly<Record<string, string>> = {
  effort: "medium",
  reasoningEffort: "medium",
};

export const CHAT_STATUS_FILTERS = ["all", "active", "waiting", "resolved"] as const;
export type ChatStatusFilter = (typeof CHAT_STATUS_FILTERS)[number];
export const CHAT_ACTIVITY_FILTERS = ["any", "1d", "7d", "30d"] as const;
export type ChatActivityFilter = (typeof CHAT_ACTIVITY_FILTERS)[number];
export const CHAT_GROUPINGS = ["date", "project", "status", "none"] as const;
export type ChatGrouping = (typeof CHAT_GROUPINGS)[number];
export const CHAT_SORTS = ["activity", "created", "title"] as const;
export type ChatSort = (typeof CHAT_SORTS)[number];
/** A project's own threads live in the project; the chat list can borrow them on request. */
export const CHAT_PROJECT_THREAD_CHOICES = ["hide", "show"] as const;
export type ChatProjectThreadChoice = (typeof CHAT_PROJECT_THREAD_CHOICES)[number];

export type ChatListOptions = {
  readonly status: ChatStatusFilter;
  readonly activity: ChatActivityFilter;
  readonly projectThreads: ChatProjectThreadChoice;
  readonly groupBy: ChatGrouping;
  readonly sortBy: ChatSort;
};

export const DEFAULT_CHAT_LIST_OPTIONS: ChatListOptions = {
  status: "active",
  activity: "any",
  projectThreads: "hide",
  groupBy: "date",
  sortBy: "activity",
};

export const CHAT_OPTION_LABELS = {
  status: { all: "All", active: "Active", waiting: "Waiting on you", resolved: "Resolved" },
  activity: { any: "Any time", "1d": "Last day", "7d": "Last 7 days", "30d": "Last 30 days" },
  projectThreads: { hide: "Hide", show: "Show" },
  groupBy: { date: "Date", project: "Project", status: "Status", none: "None" },
  sortBy: { activity: "Last activity", created: "Date created", title: "Name" },
} as const satisfies { [K in keyof ChatListOptions]: Record<ChatListOptions[K], string> };

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Saved options come back from storage; anything unknown falls to its default. */
export function parseChatListOptions(value: unknown): ChatListOptions {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    status: oneOf(CHAT_STATUS_FILTERS, raw.status, DEFAULT_CHAT_LIST_OPTIONS.status),
    activity: oneOf(CHAT_ACTIVITY_FILTERS, raw.activity, DEFAULT_CHAT_LIST_OPTIONS.activity),
    projectThreads: oneOf(
      CHAT_PROJECT_THREAD_CHOICES,
      raw.projectThreads,
      DEFAULT_CHAT_LIST_OPTIONS.projectThreads,
    ),
    groupBy: oneOf(CHAT_GROUPINGS, raw.groupBy, DEFAULT_CHAT_LIST_OPTIONS.groupBy),
    sortBy: oneOf(CHAT_SORTS, raw.sortBy, DEFAULT_CHAT_LIST_OPTIONS.sortBy),
  };
}

export function chatListOptionsAreDefault(options: ChatListOptions): boolean {
  return (
    options.status === DEFAULT_CHAT_LIST_OPTIONS.status &&
    options.activity === DEFAULT_CHAT_LIST_OPTIONS.activity &&
    options.projectThreads === DEFAULT_CHAT_LIST_OPTIONS.projectThreads &&
    options.groupBy === DEFAULT_CHAT_LIST_OPTIONS.groupBy &&
    options.sortBy === DEFAULT_CHAT_LIST_OPTIONS.sortBy
  );
}

/**
 * The line an empty chat list shows. When the list is empty only because the
 * threads agents started are left to their projects, it says where they went.
 */
export function chatListEmptyMessage(
  options: ChatListOptions,
  hiddenProjectThreads: number,
): string {
  if (options.projectThreads === "hide" && hiddenProjectThreads > 0)
    return "No chats yet. Threads agents started are on their project page.";
  return chatListOptionsAreDefault(options) ? "No chats yet." : "No chats match this filter.";
}

const DAY = 86_400_000;
const ACTIVITY_WINDOW: Record<Exclude<ChatActivityFilter, "any">, number> = {
  "1d": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

export { isOrchestratorThreadId } from "./projectCoordinatorThreads";

function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export const DATE_BUCKETS = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];

/** Calendar days in the viewer's own time zone, the way a person counts them. */
export function dateBucket(iso: string, now: number): DateBucket {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "Older";
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(time)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  if (days <= 30) return "Previous 30 days";
  return "Older";
}

function matchesStatus(thread: EnvironmentThreadShell, status: ChatStatusFilter): boolean {
  if (status === "all") return true;
  const group = projectThreadGroup(thread);
  if (status === "waiting") return group === "Waiting on you";
  if (status === "resolved") return group === "Resolved";
  return group !== "Resolved";
}

/** Newest work first; a turn streaming its items does not move its row. */
function compareByActivity(a: EnvironmentThreadShell, b: EnvironmentThreadShell): number {
  return (
    Date.parse(threadActivityAt(b)) - Date.parse(threadActivityAt(a)) || a.id.localeCompare(b.id)
  );
}

/**
 * "Last activity" means the last time someone asked the chat for work: it was
 * created, sent a message or given a turn. `updatedAt` moves on every streamed
 * item, tool call and status change, so sorting on it made busy rows jump.
 */
function compareChats(sortBy: ChatSort) {
  if (sortBy === "activity") return compareByActivity;
  return (a: EnvironmentThreadShell, b: EnvironmentThreadShell): number =>
    sortBy === "title"
      ? a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) ||
        a.id.localeCompare(b.id)
      : b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

export type ChatGroup = {
  readonly key: string;
  readonly label: string;
  readonly threads: readonly EnvironmentThreadShell[];
};

const STATUS_GROUP_ORDER: readonly ProjectThreadGroup[] = [
  "Waiting on you",
  "Working",
  "Idle",
  "Resolved",
];

/**
 * The sidebar's chats: live sessions that are not an orchestrator, narrowed by
 * the saved filter, sorted, then cut into the chosen groups. A group with no
 * chats is left out so the list never shows an empty heading. A thread its
 * project owns (`isProjectThread`) is opened from that project, so it stays out
 * unless the filter asks to show project threads too.
 */
export function buildChatGroups(
  threads: readonly EnvironmentThreadShell[],
  options: ChatListOptions,
  input: {
    readonly now: number;
    readonly query?: string;
    readonly projectLabel: (thread: EnvironmentThreadShell) => string;
    readonly isProjectThread?: (thread: EnvironmentThreadShell) => boolean;
  },
): ChatGroup[] {
  const query = input.query?.trim().toLowerCase() ?? "";
  const ownedByProject = options.projectThreads === "hide" ? (input.isProjectThread ?? null) : null;
  const since = options.activity === "any" ? null : input.now - ACTIVITY_WINDOW[options.activity];
  const rows = threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        !isOrchestratorThreadId(thread.id) &&
        // A subagent belongs to its parent's conversation, not to the list of chats.
        !isSidebarSubagentThread(thread) &&
        (ownedByProject === null || !ownedByProject(thread)) &&
        matchesStatus(thread, options.status) &&
        (since === null || Date.parse(threadActivityAt(thread)) >= since) &&
        (query === "" || thread.title.toLowerCase().includes(query)),
    )
    .sort(compareChats(options.sortBy));
  if (options.groupBy === "none")
    return rows.length ? [{ key: "all", label: "All chats", threads: rows }] : [];
  const buckets = new Map<string, EnvironmentThreadShell[]>();
  const order: string[] = [];
  const keyOf = (thread: EnvironmentThreadShell): string =>
    options.groupBy === "date"
      ? dateBucket(
          options.sortBy === "created" ? thread.createdAt : threadActivityAt(thread),
          input.now,
        )
      : options.groupBy === "status"
        ? projectThreadGroup(thread)
        : input.projectLabel(thread);
  for (const thread of rows) {
    const key = keyOf(thread);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(thread);
    else {
      buckets.set(key, [thread]);
      order.push(key);
    }
  }
  const fixed: readonly string[] | null =
    options.groupBy === "date"
      ? DATE_BUCKETS
      : options.groupBy === "status"
        ? STATUS_GROUP_ORDER
        : null;
  const keys = fixed
    ? fixed.filter((key) => buckets.has(key))
    : [...order].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return keys.map((key) => ({ key, label: key, threads: buckets.get(key)! }));
}

// ── Threads pane: a project's workers ────────────────────────────────────────

export const THREAD_SORTS = ["activity", "title", "created", "model"] as const;
export type ThreadSort = (typeof THREAD_SORTS)[number];
export const THREAD_SORT_LABELS: Record<ThreadSort, string> = {
  activity: "Last activity",
  title: "Name",
  created: "Date created",
  model: "Model",
};
export const parseThreadSort = (value: unknown): ThreadSort =>
  oneOf(THREAD_SORTS, value, "activity");

/** Rows shown under a heading before "Show more"; each press adds a page. */
export const THREAD_GROUP_PAGE = 5;
export const THREAD_GROUP_PAGE_STEP = 10;

export type ThreadPaneGroup = {
  readonly group: ProjectThreadGroup;
  readonly threads: readonly EnvironmentThreadShell[];
};

/** Keep the lifecycle discoverable, including empty resolved history. */
export function buildThreadPaneGroups(
  threads: readonly EnvironmentThreadShell[],
  sortBy: ThreadSort,
  query = "",
  /** Working subagents per `environmentId:threadId`: an idle thread with one is still working. */
  runningSubagents?: ReadonlyMap<string, number>,
  /** Hosts that cannot be reached now; their threads are listed as idle. */
  unreachable?: ReadonlySet<string>,
  attention?: ProjectAttention,
): ThreadPaneGroup[] {
  const groupOf = (thread: EnvironmentThreadShell) => {
    const root = attention?.roots.find(
      (r) => r.thread.environmentId === thread.environmentId && r.thread.id === thread.id,
    );
    if (root && root.freshness !== "live") return "Unavailable";
    if (root?.actions.length) return "Waiting on you";
    if (root?.working) return "Working";
    const group = projectThreadGroup(thread, unreachable?.has(thread.environmentId) ?? false);
    return group === "Idle" &&
      (runningSubagents?.get(`${thread.environmentId}:${thread.id}`) ?? 0) > 0
      ? "Working"
      : group;
  };
  const needle = query.trim().toLowerCase();
  const compare =
    sortBy === "model"
      ? (a: EnvironmentThreadShell, b: EnvironmentThreadShell) =>
          a.modelSelection.instanceId.localeCompare(b.modelSelection.instanceId) ||
          a.modelSelection.model.localeCompare(b.modelSelection.model) ||
          compareByActivity(a, b)
      : sortBy === "activity"
        ? compareByActivity
        : compareChats(sortBy);
  const groups: ThreadPaneGroup[] = [];
  for (const group of ["Waiting on you", "Working", "Unavailable", "Idle", "Resolved"] as const) {
    const rows = threads
      .filter(
        (thread) =>
          groupOf(thread) === group &&
          (needle === "" || thread.title.toLowerCase().includes(needle)),
      )
      .sort(compare);
    groups.push({ group, threads: rows });
  }
  return groups;
}

export function waitingCount(
  threads: readonly EnvironmentThreadShell[],
  unreachable?: ReadonlySet<string>,
): number {
  return threads.filter(
    (thread) =>
      projectThreadGroup(thread, unreachable?.has(thread.environmentId) ?? false) ===
      "Waiting on you",
  ).length;
}

/** The header line under "Welcome back": what needs the person, then what is moving. */
export function threadsSummary(
  threads: readonly EnvironmentThreadShell[],
  /** Workers this project runs on other machines, which are not threads here. */
  remoteWorkers = 0,
  unreachable?: ReadonlySet<string>,
  runningSubagents?: ReadonlyMap<string, number>,
  attention?: ProjectAttention,
): string {
  if (attention)
    return `${attention.complete && attention.count === 0 ? "Nothing is waiting on you" : attention.label}${attention.working > 0 ? ` · ${attention.working} working` : ""}${attention.staleCount > 0 ? ` · ${attention.staleCount} last observed` : ""}.`;
  const waiting = waitingCount(threads, unreachable);
  const working = threads.filter(
    (thread) =>
      projectThreadGroup(thread, unreachable?.has(thread.environmentId) ?? false) === "Working" ||
      (!unreachable?.has(thread.environmentId) &&
        (runningSubagents?.get(`${thread.environmentId}:${thread.id}`) ?? 0) > 0),
  ).length;
  if (threads.length === 0)
    return remoteWorkers > 0
      ? `${remoteWorkers === 1 ? "One worker runs" : `${remoteWorkers} workers run`} on another machine.`
      : "No threads yet. Ask the coordinator to start one.";
  const parts = [
    waiting === 0
      ? unreachable?.size
        ? "Attention unavailable on disconnected hosts"
        : "Nothing is waiting on you"
      : waiting === 1
        ? "1 thread is waiting on you"
        : `${waiting} threads are waiting on you`,
    working === 0 ? null : `${working} working`,
  ].filter((part): part is string => part !== null);
  return `${parts.join(" · ")}.`;
}

/** Groups a person has dealt with stay folded until they ask for them. */
export const THREAD_GROUPS_FOLDED_BY_DEFAULT: readonly ProjectThreadGroup[] = ["Resolved"];

export type ThreadTone = "waiting" | "working" | "failed" | "resolved" | "idle";

/** What a row's status dot says; failed is called out so it is not read as a question. */
export function threadTone(thread: EnvironmentThreadShell, hostOffline = false): ThreadTone {
  const status = resolveSidebarThreadStatus(thread);
  const group = projectThreadGroup(thread, hostOffline);
  if (group === "Resolved") return "resolved";
  if (hostOffline) return "idle";
  if (status === "failed") return "failed";
  if (group === "Waiting on you") return "waiting";
  if (group === "Working" || threadRuntimeIsActive(thread.runtime)) return "working";
  return "idle";
}

/**
 * The word a row leads its second line with when the thread wants something
 * or is busy; a quiet thread says nothing and lets its model speak.
 */
export function threadStatusWord(
  thread: EnvironmentThreadShell,
  hostOffline = false,
): string | null {
  if (threadTone(thread, hostOffline) === "resolved") return null;
  // Its last known state is stale; "Blocked" or "Working" would be a guess.
  if (hostOffline) return "Host offline";
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return "Approval requested";
  if (status === "input") return "Answer needed";
  if (status === "limited") return "Usage limit reached";
  if (status === "failed") return "Needs review";
  if (threadHeldQueue(thread) !== null) return "Queue held";
  if (threadBlocker(thread) !== null) return "Blocked";
  const tone = threadTone(thread);
  if (tone === "waiting") return thread.hasActionableProposedPlan ? "Plan ready" : "Waiting on you";
  return tone === "working" ? "Working" : null;
}

export const THREAD_TONE_LABELS: Record<ThreadTone, string> = {
  waiting: "Waiting on you",
  working: "Working",
  failed: "Needs review",
  resolved: "Resolved",
  idle: "Idle",
};

/**
 * useNowMinute hands out UTC wall time with no zone ("2026-10-10T15:47"), which
 * Date.parse would read as local time and shift every age by the UTC offset.
 */
export function nowFromMinute(minute: string): number {
  return Date.parse(`${minute}:00.000Z`);
}

/** "now", "5m", "3h", "2d", "4w": short enough for a list row's last column. */
export function compactAge(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}
