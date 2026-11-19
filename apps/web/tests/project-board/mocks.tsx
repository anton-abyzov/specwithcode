// Stand-ins for what needs a server or a browser tab: the board and the
// increment view answer from fictional increments, filtered the way the server
// does. Variants, picked by URL parameter the way the page reads them:
// `?server=old` is a server without the detail read (no reasons, no counts),
// `?removed=<folder>` is an increment deleted while its view is open,
// `?threads=reading` is a machine whose threads have not answered yet,
// `?threads=many` is a machine with more unresolved threads than the board reads.
import type {
  ProjectBoardBlocker,
  ProjectBoardCard,
  ProjectBoardIncrement,
  ProjectBoardIncrementResult,
  ProjectBoardResult,
  ProjectId,
  ThreadIncrementCriterion,
  ThreadIncrementTask,
} from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
const OLD_SERVER = params.get("server") === "old";
// `?threads=reading`: one machine has not said yet which increments its threads work on.
const THREADS_READING = params.get("threads") === "reading";
const REMOVED = params.get("removed");

const NOW = Date.parse("2026-11-14T18:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const FETCHED_AT = ago(180);
const pull = (number: number) => `https://github.com/acme/app/pull/${number}`;
const spec = (id: string) => `/work/atlas/.specweave/increments/${id}/spec.md`;

/* Increments --------------------------------------------------------------- */

export const IDS = {
  blocked: "0030-search-index-rewrite",
  pausedBlocked: "0031-offline-message-queue",
  longReason: "0032-export-to-shared-drive",
  seven: "0033-weekly-usage-chart",
  pausedDone: "0034-keyboard-shortcuts",
  promoted: "0036-rename-threads-in-place",
  idle: "0037-notification-sounds",
  noSpec: "0038-calendar-import",
  planned: "0039-dark-theme-contrast",
  reviewTasks: "0029-retry-failed-sync",
  review: "0028-upload-progress",
  done: "0020-passkey-sign-in",
  abandoned: "0019-legacy-report-format",
} as const;

// A reason someone pasted from a log: 400 characters and no space to wrap at.
const LONG_REASON =
  `Waiting_for_the_storage_quota_raise:${"quota_request_pending_".repeat(18)}`.slice(0, 400);

interface Fixture {
  readonly card: ProjectBoardCard;
  readonly tasks: ReadonlyArray<ThreadIncrementTask>;
  readonly criteria: ReadonlyArray<ThreadIncrementCriterion>;
  readonly problem: string | null;
  readonly extra?: Partial<ProjectBoardIncrement>;
}

function task(id: number, title: string, extra: Partial<ThreadIncrementTask> = {}) {
  return {
    id: `T-${String(id).padStart(2, "0")}`,
    title,
    status: "planned",
    criteria: [],
    note: null,
    ...extra,
  } as ThreadIncrementTask;
}
const doneTasks = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) =>
    task(from + index, `Finished step ${from + index}`, {
      status: "done",
      doneAt: ago(600 + index * 30),
    }),
  );
const blockerOf = (entry: ThreadIncrementTask): ProjectBoardBlocker => ({
  taskId: entry.id,
  title: entry.title,
  note: entry.note,
  by: entry.owner ?? null,
  at: entry.changedAt ?? null,
  leased: entry.leased ?? false,
});
const criterion = (
  id: number,
  text: string,
  state: ThreadIncrementCriterion["state"],
): ThreadIncrementCriterion => ({
  id: `AC-${String(id).padStart(2, "0")}`,
  text,
  met: state === "verified" || state === "evidenced",
  state,
});

function card(
  incrementId: string,
  title: string | null,
  column: ProjectBoardCard["column"],
  tasks: ReadonlyArray<ThreadIncrementTask>,
  extra: Partial<ProjectBoardCard> = {},
): ProjectBoardCard {
  const done = tasks.filter((entry) => entry.status === "done" || entry.status === "skipped");
  const blocked = tasks.filter((entry) => entry.status === "blocked");
  const paused = extra.paused ?? false;
  return {
    incrementId,
    title,
    status: "active",
    column,
    tasks: {
      total: tasks.length,
      done: done.length,
      active: tasks.filter((entry) => entry.status === "claimed").length,
    },
    blocked: paused || blocked.length > 0,
    paused,
    pausedReason: null,
    blockedTasks: blocked.length,
    blockers: blocked.slice(0, 3).map(blockerOf),
    columnReason: "status",
    updatedAt: ago(30),
    pullRequests: [],
    specPath: spec(incrementId),
    ...extra,
  };
}

// The blocked increment: 14 of 24 tasks, two blockers. Rebuild holds T-18 by
// its own claim inside the lease; T-21's block is old, so nobody provably holds it.
const T18_AT = ago(40);
const T15_AT = ago(20);
const blockedTasks = [
  ...doneTasks(14),
  task(15, "Measure the rewrite against the old index", {
    status: "claimed",
    owner: "agent@laptop",
    changedAt: T15_AT,
    leased: true,
    criteria: ["AC-03"],
  }),
  task(16, "Keep results stable while the index rebuilds", { criteria: ["AC-02"] }),
  task(17, "Show progress while a large folder is indexed", { criteria: ["AC-04"] }),
  task(18, "Move the index to the new storage format", {
    status: "blocked",
    note: "Waiting for the storage team to approve the larger disk quota",
    owner: "agent@desk",
    changedAt: T18_AT,
    leased: true,
    criteria: ["AC-01"],
  }),
  task(19, "Drop the old index after a week", {}),
  task(20, "Search inside archives", {}),
  task(21, "Index shared folders", {
    status: "blocked",
    note: "Shared folders need the new sharing permission first",
    owner: "agent@laptop",
    changedAt: ago(300),
    leased: false,
  }),
  task(22, "Release notes for the new search", {}),
  task(23, "Remove the search setting nobody uses", {}),
  task(24, "Close and verify", {}),
];
const pausedBlockedTasks = [
  ...doneTasks(3),
  task(4, "Queue messages while offline", {
    status: "claimed",
    owner: "agent@desk",
    changedAt: ago(400),
    leased: false,
  }),
  task(5, "Send the queue when the connection returns", {
    status: "blocked",
    note: "The retry rules wait for the decision on message order",
    owner: "agent@desk",
    changedAt: ago(500),
    leased: false,
  }),
  task(6, "Show queued messages in the thread", {}),
  task(7, "Drop a queued message", {}),
  task(8, "Limit the queue size", {}),
  task(9, "Close and verify", {}),
];
const longReasonTasks = [
  ...doneTasks(2),
  task(3, "Upload the export to the shared drive", {
    status: "blocked",
    note: LONG_REASON,
    owner: "agent@desk",
    changedAt: ago(90),
    leased: true,
  }),
  task(4, "Pick the folder on the shared drive", {}),
  task(5, "Name the export file", {}),
  task(6, "Close and verify", {}),
];
const sevenTasks = [
  ...doneTasks(5),
  ...[
    "Weekly totals per model",
    "A chart that reads in both themes",
    "Hover to see a single day",
    "Export the chart as an image",
    "Compare two weeks",
    "Empty state for a new project",
    "Close and verify",
  ].map((title, index) => task(6 + index, title)),
];

const FIXTURES: Fixture[] = [
  {
    card: card(IDS.blocked, "Search index rewrite", "active", blockedTasks, {
      status: "planned",
      columnReason: "ledger",
      updatedAt: ago(35),
      pullRequests: [pull(812), pull(807)],
    }),
    tasks: blockedTasks,
    criteria: [
      criterion(1, "Search answers within a second in a folder of 100,000 files", "verified"),
      criterion(2, "Results do not change while the index rebuilds", "verified"),
      criterion(3, "The new index is measured against the old one", "evidenced"),
      criterion(4, "A large folder shows its indexing progress", "open"),
      criterion(5, "Archives are searched like folders", "uncovered"),
    ],
    problem:
      "Search slows down badly in folders with more than 50,000 files, and the index is rebuilt from scratch after every update. People wait for results and see old ones while the rebuild runs.\n\nThe rewrite keeps one index per folder, updates it in place and moves it to a storage format that can grow.",
  },
  {
    card: card(IDS.pausedBlocked, "Offline message queue", "active", pausedBlockedTasks, {
      status: "paused",
      paused: true,
      pausedReason: "Paused until the design review on Thursday settles the message order",
      updatedAt: ago(500),
    }),
    tasks: pausedBlockedTasks,
    criteria: [
      criterion(1, "A message written offline is sent when the connection returns", "open"),
    ],
    problem: "Messages typed without a connection are lost.",
  },
  {
    card: card(IDS.longReason, "Export a report to the shared drive", "active", longReasonTasks, {
      updatedAt: ago(90),
      pullRequests: [pull(790)],
    }),
    tasks: longReasonTasks,
    criteria: [],
    problem: "Reports can only be saved to this machine.",
  },
  {
    card: card(IDS.seven, "Weekly usage chart", "active", sevenTasks, { updatedAt: ago(4) }),
    tasks: sevenTasks,
    criteria: [criterion(1, "The chart shows a week of usage per model", "open")],
    problem: "Nobody can tell how usage changes from week to week.",
  },
  {
    card: card(IDS.pausedDone, "Keyboard shortcuts for the panel", "active", doneTasks(6), {
      status: "paused",
      paused: true,
      pausedReason: "Holding the release until the store review clears",
      updatedAt: ago(1500),
    }),
    tasks: doneTasks(6),
    criteria: [criterion(1, "Every panel action has a shortcut", "evidenced")],
    problem: "The panel can only be used with the mouse.",
  },
  {
    card: card(
      IDS.promoted,
      "Rename a thread in place",
      "planned",
      [1, 2, 3, 4].map((id) => task(id, `Rename step ${id}`)),
      { status: "planned", updatedAt: ago(200) },
    ),
    tasks: [1, 2, 3, 4].map((id) => task(id, `Rename step ${id}`)),
    criteria: [],
    problem: "Renaming a thread opens a dialog for one word.",
  },
  {
    card: card(
      IDS.idle,
      "Notification sounds",
      "planned",
      [1, 2, 3].map((id) => task(id, `Sound step ${id}`)),
      { status: "planned", updatedAt: ago(2000) },
    ),
    tasks: [1, 2, 3].map((id) => task(id, `Sound step ${id}`)),
    criteria: [],
    problem: "A finished run makes no sound.",
  },
  {
    card: card(IDS.noSpec, "Calendar import", "planned", [], {
      status: "planned",
      specPath: null,
      updatedAt: ago(3000),
    }),
    tasks: [],
    criteria: [],
    problem: null,
    extra: { readable: false },
  },
  {
    card: card(
      IDS.planned,
      "Dark theme contrast pass",
      "planned",
      [1, 2].map((id) => task(id, `Contrast step ${id}`)),
      {
        status: "planned",
        updatedAt: ago(4000),
        // Planned in a thread's worktree, not yet in the project folder.
        source: { kind: "worktree", name: "fix-1407-init-rerun-safety" },
      },
    ),
    tasks: [1, 2].map((id) => task(id, `Contrast step ${id}`)),
    criteria: [],
    problem: "Some muted text is hard to read in the dark theme.",
  },
  {
    card: card(IDS.reviewTasks, "Retry a failed sync", "review", doneTasks(5), {
      columnReason: "tasks",
      updatedAt: ago(70),
      pullRequests: [pull(801)],
    }),
    tasks: doneTasks(5),
    criteria: [criterion(1, "A failed sync retries three times", "evidenced")],
    problem: "A sync that fails once stays failed until someone notices.",
  },
  {
    card: card(IDS.review, "Upload progress", "review", doneTasks(3), {
      status: "review",
      updatedAt: ago(400),
      // Merged to the default branch while the project folder lags.
      source: { kind: "remote", name: "origin/main", fetchedAt: FETCHED_AT },
    }),
    tasks: doneTasks(3),
    criteria: [],
    problem: "Long uploads show no progress.",
  },
  {
    card: card(IDS.done, "Sign-in with a passkey", "done", doneTasks(8), {
      status: "completed",
      updatedAt: ago(2900),
      pullRequests: [pull(760), pull(755)],
    }),
    tasks: doneTasks(8),
    criteria: [
      criterion(1, "A person can sign in with a passkey", "verified"),
      criterion(2, "A lost passkey can be replaced", "verified"),
    ],
    problem: "Passwords are the only way to sign in.",
    extra: {
      verify: { ok: true, ranAt: "2026-11-12T16:20:00Z" },
      review: {
        policy: null,
        latest: {
          model: "reviewer-model",
          family: "other",
          head: "abc1234",
          verdict: "ship",
          at: "2026-11-12T15:00:00Z",
          reportPath: "/work/atlas/.specweave/increments/0020-passkey-sign-in/reports/review.md",
        },
        authorFamily: null,
        policySatisfied: null,
      },
      closedAt: "2026-11-12T17:00:00Z",
      reports: [
        {
          path: "/work/atlas/.specweave/increments/0020-passkey-sign-in/reports/review.md",
          name: "review.md",
        },
      ],
    },
  },
  ...[
    "Faster folder listing",
    "Copy a project to another machine",
    "Clearer error for a full disk",
    "Rename a machine",
    "Pin a thread",
  ].map((title, index) => {
    const id = `00${String(18 - index).padStart(2, "0")}-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
    return {
      card: card(id, title, "done", doneTasks(4), {
        status: "completed",
        updatedAt: ago(4000 + index * 900),
      }),
      tasks: doneTasks(4),
      criteria: [],
      problem: null,
    };
  }),
];
// Off the board: only a link that names it opens its view.
const ABANDONED: Fixture = {
  card: card(
    IDS.abandoned,
    "Legacy report format",
    "done",
    [...doneTasks(2), task(3, "Convert old reports")],
    {
      status: "abandoned",
      updatedAt: ago(9000),
    },
  ),
  tasks: [...doneTasks(2), task(3, "Convert old reports")],
  criteria: [],
  problem: "Old reports use a format nothing reads any more.",
  extra: {
    abandoned: true,
    abandonedReason: "Replaced by the export to the shared drive.",
    closedAt: "2026-11-08T12:00:00Z",
  },
};

/** What a server from before the blocked state sends: no reasons, counts or column reason. */
function oldCard(entry: ProjectBoardCard): ProjectBoardCard {
  const {
    paused: _paused,
    pausedReason: _reason,
    blockedTasks: _blocked,
    blockers: _blockers,
    columnReason,
    source: _source,
    ...rest
  } = entry;
  const { active: _active, ...tasks } = entry.tasks;
  return { ...rest, tasks, column: columnReason === "ledger" ? "planned" : entry.column };
}
const ALL: ProjectBoardCard[] = FIXTURES.map((entry) =>
  OLD_SERVER ? oldCard(entry.card) : entry.card,
);

/* The RPC stand-ins -------------------------------------------------------- */

type BoardRequest = { projectId: ProjectId; query?: string; doneLimit?: number };
type IncrementRequest = { projectId: ProjectId; incrementId: string; includeDone?: boolean };
export const projectWorkspace = {
  board: (request: { input: BoardRequest }) => ({ kind: "board" as const, input: request.input }),
  boardIncrement: (request: { input: IncrementRequest }) => ({
    kind: "increment" as const,
    input: request.input,
  }),
};
type Request =
  | ReturnType<typeof projectWorkspace.board>
  | ReturnType<typeof projectWorkspace.boardIncrement>;

function boardReply(input: BoardRequest): ProjectBoardResult {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = ALL.filter((entry) =>
    words.every((word) => `${entry.incrementId} ${entry.title}`.toLowerCase().includes(word)),
  );
  const counts = { planned: 0, active: 0, review: 0, done: 0 };
  for (const entry of matched) counts[entry.column] += 1;
  let doneLeft = input.doneLimit ?? 30;
  return {
    projectId: input.projectId,
    cards: matched.filter((entry) => entry.column !== "done" || doneLeft-- > 0),
    counts,
    ...(OLD_SERVER
      ? {}
      : {
          detail: true,
          // The whole project's, whatever the query.
          notDone: ALL.filter((entry) => entry.column !== "done").length,
          behind: { ref: "origin/main", count: 61, fetchedAt: FETCHED_AT },
        }),
  };
}

function incrementReply(input: IncrementRequest): ProjectBoardIncrementResult {
  const found = [...FIXTURES, ABANDONED].find(
    (entry) => entry.card.incrementId === input.incrementId,
  );
  if (!found || REMOVED === input.incrementId)
    return { projectId: input.projectId, incrementId: input.incrementId, increment: null };
  const closed = (entry: ThreadIncrementTask) =>
    entry.status === "done" || entry.status === "skipped";
  return {
    projectId: input.projectId,
    incrementId: input.incrementId,
    increment: {
      card: found.card,
      problem: found.problem,
      readable: true,
      tasks: input.includeDone ? found.tasks : found.tasks.filter((entry) => !closed(entry)),
      doneTasks: found.tasks.filter(closed).length,
      blockers: found.tasks.filter((entry) => entry.status === "blocked").map(blockerOf),
      criteria: found.criteria,
      verify: null,
      review: null,
      abandoned: false,
      abandonedReason: null,
      closedAt: null,
      reports: [],
      ...found.extra,
    },
  };
}

// A check can change the board under the page, as a refresh would:
// `fixtureBoard.block(id)` gives a card a blocked task, `fixtureBoard.remove(id)` takes it away.
let boardVersion = 0;
const boardListeners = new Set<() => void>();
const subscribeBoard = (listener: () => void) => {
  boardListeners.add(listener);
  return () => void boardListeners.delete(listener);
};
const changeBoard = (change: () => void) => {
  change();
  boardVersion += 1;
  for (const listener of boardListeners) listener();
};
(window as unknown as { fixtureBoard: unknown }).fixtureBoard = {
  block: (id: string) =>
    changeBoard(() => {
      const at = ALL.findIndex((entry) => entry.incrementId === id);
      if (at !== -1) ALL[at] = { ...ALL[at]!, blocked: true, blockedTasks: 1 };
    }),
  remove: (id: string) =>
    changeBoard(() => {
      const at = ALL.findIndex((entry) => entry.incrementId === id);
      if (at !== -1) ALL.splice(at, 1);
    }),
};

// One reply per distinct input, as the real query atoms hold theirs.
const replies = new Map<string, unknown>();
const NO_DATA = { data: undefined, error: null, isPending: false, refresh: () => undefined };
export function useEnvironmentQuery(request: Request | null) {
  const version = useSyncExternalStore(subscribeBoard, () => boardVersion);
  if (request === null) return NO_DATA;
  const key =
    request.kind === "board"
      ? `board|${version}|${request.input.query ?? ""}|${request.input.doneLimit ?? 30}`
      : `increment|${request.input.incrementId}|${request.input.includeDone === true}`;
  let data = replies.get(key);
  if (data === undefined) {
    data = request.kind === "board" ? boardReply(request.input) : incrementReply(request.input);
    replies.set(key, data);
  }
  return { data, error: null, isPending: false, refresh };
}
const refresh = () => undefined;

export function useOpenLink() {
  return async (url: string) => {
    document.body.dataset.openedLink = url;
  };
}

export function LibraryFileViewer(props: { path: string; onClose: () => void }) {
  return (
    <button
      type="button"
      className="fixture-viewer"
      data-viewer-path={props.path}
      onClick={props.onClose}
    >
      Viewer: {props.path}
    </button>
  );
}

/* Threads ------------------------------------------------------------------ */

// This device is served by "desk"; a thread served there can run on another
// machine (it moved). "spare" cannot be reached, so its threads are offline.
const MACHINES = [
  { environmentId: "desk", label: "Desk", color: "violet" },
  { environmentId: "laptop", label: "Laptop", color: "teal" },
  { environmentId: "spare", label: "Spare", color: "amber" },
] as const;
type Machine = (typeof MACHINES)[number]["environmentId"];
const running = { runtime: { status: "running" } };
const asks = { hasPendingUserInput: true };
const resolved = { settledOverride: "settled" };
const movedTo = (machine: Machine) => ({
  source: {
    ownerMachineId: "desk",
    executionMachineId: machine,
    executionMachineLabel: MACHINES.find((entry) => entry.environmentId === machine)!.label,
  },
});
interface Link {
  incrementId: string;
  binding: string;
  boundTaskId: string | null;
  boundAt: string | null;
}
const LINKS = new Map<string, Link>();
let threadCount = 0;
function thread(
  incrementId: string,
  title: string,
  environmentId: Machine,
  minutes: number,
  extra: object = {},
  claim: { taskId: string; at: string } | null = null,
): EnvironmentThreadShell {
  const id = `thread-${++threadCount}`;
  LINKS.set(`${environmentId}:${id}`, {
    incrementId,
    binding: claim ? "claim" : "branch",
    boundTaskId: claim?.taskId ?? null,
    boundAt: claim?.at ?? null,
  });
  return {
    id,
    environmentId,
    projectId: "atlas",
    title,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    pullRequests: [],
    modelSelection: { instanceId: "agent", model: "model" },
    updatedAt: ago(minutes),
    createdAt: ago(minutes + 90),
    settledOverride: null,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...extra,
  } as unknown as EnvironmentThreadShell;
}
export const FIXTURE_THREADS: EnvironmentThreadShell[] = [
  // The blocked increment: one waiting, one working that holds T-18, one moved to the laptop.
  thread(IDS.blocked, "Rebuild the search index", "desk", 3, running, {
    taskId: "T-18",
    at: T18_AT,
  }),
  thread(IDS.blocked, "Answer the index format question", "desk", 6, asks),
  thread(
    IDS.blocked,
    "Measure the rewrite",
    "desk",
    12,
    { ...running, ...movedTo("laptop") },
    {
      taskId: "T-15",
      at: T15_AT,
    },
  ),
  // Seven threads: six on two machines and one on a machine that cannot be reached.
  thread(IDS.seven, "Chart layout", "desk", 2, running),
  thread(IDS.seven, "Chart colors in both themes", "laptop", 5, running),
  thread(IDS.seven, "Week picker", "desk", 8, asks),
  thread(IDS.seven, "Export as image", "laptop", 14, running),
  thread(IDS.seven, "Compare two weeks", "desk", 30),
  thread(IDS.seven, "Empty state copy", "laptop", 45),
  thread(IDS.seven, "Usage numbers check", "desk", 80, movedTo("spare")),
  // A planned card a working thread moves to Active, and one whose thread is idle.
  thread(IDS.promoted, "Inline rename field", "laptop", 4, running),
  thread(IDS.idle, "Pick notification sounds", "desk", 600),
  thread(IDS.reviewTasks, "Review the retry rules", "laptop", 9, running),
  // Only a thread that cannot be reached: it may still hold the work.
  thread(IDS.planned, "Check contrast in the dark theme", "desk", 200, movedTo("spare")),
  // Only a resolved thread: nobody holds the work. It read one pull request
  // of the blocked increment from the host and only linked the other.
  thread(IDS.longReason, "Export to the shared drive", "desk", 900, {
    ...resolved,
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/app",
        number: 812,
        url: pull(812),
        source: "linked",
        linkedAt: ago(400),
        snapshot: { state: "open", isDraft: false, title: "Search index rewrite" },
      },
      {
        host: "github.com",
        repository: "acme/app",
        number: 807,
        url: pull(807),
        source: "linked",
        linkedAt: ago(500),
      },
    ],
  }),
  thread(IDS.done, "Passkey sign-in", "desk", 3000, resolved),
];
// Old threads of no increment, past what one machine's pages hold: the list is cut.
if (params.get("threads") === "many")
  for (let index = 0; index < 801; index += 1) {
    const extra = thread(IDS.idle, `Side note ${index + 1}`, "desk", 5000 + index);
    LINKS.delete(`desk:${extra.id}`);
    FIXTURE_THREADS.push(extra);
  }
export const FIXTURE_MACHINE_LABELS = new Map<string, string>(
  MACHINES.map((machine) => [machine.environmentId, machine.label]),
);

// One answer per distinct page of threads, as the real query atoms hold theirs.
const pageStates = new Map<string, unknown>();
export function useThreadIncrementState(input: {
  environmentId: string;
  threadIds: ReadonlyArray<string>;
}) {
  const key = `${input.environmentId}|${input.threadIds.join(",")}`;
  let state = pageStates.get(key);
  if (!state) {
    // A read still under way holds nothing yet, as the real one does.
    const reading = THREADS_READING && input.environmentId === "laptop";
    const progress = new Map<string, Link>();
    if (!reading)
      for (const id of input.threadIds) {
        const link = LINKS.get(`${input.environmentId}:${id}`);
        if (link) progress.set(id, link);
      }
    pageStates.set(key, (state = { progress, unplanned: new Set<string>(), answered: !reading }));
  }
  return state;
}
const ENVIRONMENTS = { environments: MACHINES.map((machine) => ({ ...machine })) };
export const useEnvironments = () => ENVIRONMENTS;
const UNREACHABLE: ReadonlySet<string> = new Set(["spare"]);
export const useUnreachableHosts = () => UNREACHABLE;
// No machine judged yet: the threads list reads its machines as they are.
const NO_REACH_STATES = new Map<string, never>();
export const useHostReachStates = () => NO_REACH_STATES;
export const useHostDownNotes = () => NO_REACH_STATES;
const nickname = (environmentId: string, fallbackLabel?: string | null) =>
  MACHINES.find((machine) => machine.environmentId === environmentId)?.label ??
  fallbackLabel ??
  environmentId;
export const useMachineNicknames = () => nickname;
const identity = (environmentId: string) => ({
  environmentId,
  name: nickname(environmentId),
  color: MACHINES.find((machine) => machine.environmentId === environmentId)?.color ?? "slate",
});
export const useMachineIdentities = () => identity;
