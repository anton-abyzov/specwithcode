// Stand-ins for what needs a server or a browser tab: the board RPC answers
// from 700 fictional increments, filtered and cut the way the server does.
import type { ProjectBoardCard, ProjectBoardResult, ProjectId } from "@specweave-studio/contracts";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";

const NOW = Date.parse("2026-11-14T18:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SUBJECTS = [
  "Sign-in with a passkey",
  "Faster search over large folders",
  "Export a report as a document",
  "Copy a project to another machine",
  "Clear progress for long uploads",
  "Keyboard shortcuts for the panel",
  "Usage chart by week",
  "Retry a failed sync",
  "Dark theme contrast pass",
  "Notifications for finished runs",
  "Rename a thread in place",
  "Offline queue for messages",
];
const pull = (number: number) => `https://github.com/example/atlas/pull/${number}`;

function card(index: number, column: ProjectBoardCard["column"], order: number): ProjectBoardCard {
  const number = 1338 - index;
  const subject = SUBJECTS[index % SUBJECTS.length]!;
  const total = 3 + (index % 5);
  const done =
    column === "planned"
      ? 0
      : column === "active"
        ? index % total
        : column === "review"
          ? total
          : total;
  const incrementId = `${String(number).padStart(4, "0")}-${subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return {
    incrementId,
    title: index % 9 === 4 ? `${subject}, with the settings and the empty state reviewed` : subject,
    status:
      column === "done"
        ? "completed"
        : column === "planned"
          ? "planned"
          : column === "active" && index % 13 === 5
            ? "paused"
            : "active",
    column,
    tasks: { total, done },
    blocked: column === "active" && (index % 7 === 3 || index % 13 === 5),
    updatedAt: ago(20 + order * (column === "done" ? 190 : 75)),
    pullRequests:
      column === "planned" || index % 3 === 0
        ? []
        : index % 8 === 1
          ? [pull(400 - index), pull(399 - index)]
          : [pull(400 - index)],
    specPath: `/work/atlas/.specweave/increments/${incrementId}/spec.md`,
  };
}

const ALL: ProjectBoardCard[] = [];
let index = 0;
for (const [column, count] of [
  ["active", 71],
  ["review", 7],
  ["planned", 11],
  ["done", 611],
] as const) {
  for (let order = 0; order < count; order += 1) ALL.push(card(index++, column, order));
}

export const projectWorkspace = {
  board: (request: { input: { projectId: ProjectId; query?: string; doneLimit?: number } }) =>
    request.input,
};

// One reply per distinct input, as the real query atoms hold theirs.
const replies = new Map<string, ProjectBoardResult>();
export function useEnvironmentQuery(input: {
  projectId: ProjectId;
  query?: string;
  doneLimit?: number;
}) {
  const key = `${input.query ?? ""}|${input.doneLimit ?? 30}`;
  let data = replies.get(key);
  if (data === undefined) {
    const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matched = ALL.filter((entry) =>
      words.every((word) => `${entry.incrementId} ${entry.title}`.toLowerCase().includes(word)),
    );
    const counts = { planned: 0, active: 0, review: 0, done: 0 };
    for (const entry of matched) counts[entry.column] += 1;
    let doneLeft = input.doneLimit ?? 30;
    data = {
      projectId: input.projectId,
      cards: matched.filter((entry) => entry.column !== "done" || doneLeft-- > 0),
      counts,
    };
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
    <button type="button" className="fixture-viewer" data-viewer-path={props.path} onClick={props.onClose}>
      Viewer: {props.path}
    </button>
  );
}

// Threads on three fictional machines. This device is served by "studio"; a thread
// served there can run on another machine (it moved), and other machines serve their own.
const MACHINES = [
  { environmentId: "studio", label: "Studio", color: "violet" },
  { environmentId: "laptop", label: "Laptop", color: "teal" },
  { environmentId: "server", label: "Server", color: "amber" },
] as const;
type Machine = (typeof MACHINES)[number]["environmentId"];
const running = { runtime: { status: "running" } };
const asks = { hasPendingUserInput: true };
const resolved = { settledOverride: "settled" };
const movedTo = (machine: Machine) => ({
  source: {
    ownerMachineId: "studio",
    executionMachineId: machine,
    executionMachineLabel: MACHINES.find((entry) => entry.environmentId === machine)!.label,
  },
});
const increments = (column: ProjectBoardCard["column"]) =>
  ALL.filter((entry) => entry.column === column).map((entry) => entry.incrementId);
const ACTIVE = increments("active");
const LINKS = new Map<string, string>();
let threadCount = 0;
function thread(
  incrementId: string,
  title: string,
  environmentId: Machine,
  minutes: number,
  extra: object = {},
): EnvironmentThreadShell {
  const id = `thread-${++threadCount}`;
  LINKS.set(`${environmentId}:${id}`, incrementId);
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
  thread(ACTIVE[0]!, "Build the passkey sign-in", "studio", 3, running),
  thread(ACTIVE[1]!, "Index large folders faster", "studio", 6, { ...asks, ...movedTo("laptop") }),
  thread(ACTIVE[1]!, "Benchmark the new index", "server", 12, running),
  thread(ACTIVE[1]!, "Plan the search rewrite", "studio", 400, resolved),
  thread(ACTIVE[2]!, "Report export layout", "laptop", 9, asks),
  thread(ACTIVE[3]!, "Copy engine", "studio", 4, running),
  thread(ACTIVE[3]!, "Copy progress screen", "studio", 15, { ...running, ...movedTo("server") }),
  thread(ACTIVE[3]!, "Copy over a local network", "laptop", 30, running),
  thread(ACTIVE[3]!, "Copy review", "server", 45),
  thread(ACTIVE[3]!, "Copy plan", "studio", 900, resolved),
  thread(increments("review")[0]!, "Review before closing", "server", 5, running),
  thread(increments("done")[0]!, "Shipped and closed", "studio", 60, resolved),
];
export const FIXTURE_MACHINE_LABELS = new Map<string, string>(
  MACHINES.map((machine) => [machine.environmentId, machine.label]),
);

export function useProjectThreadIncrementProgress(
  environmentId: string,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  return progressFor(environmentId, threads);
}
const progressCache = new WeakMap<object, ReturnType<typeof buildProgress>>();
function buildProgress(environmentId: string, threads: ReadonlyArray<EnvironmentThreadShell>) {
  const progress = new Map<string, { incrementId: string }>();
  for (const entry of threads) {
    const incrementId = LINKS.get(`${entry.environmentId}:${entry.id}`);
    if (entry.environmentId === environmentId && incrementId) progress.set(entry.id, { incrementId });
  }
  return { progress, unplanned: new Set<string>(), answered: true };
}
function progressFor(environmentId: string, threads: ReadonlyArray<EnvironmentThreadShell>) {
  let held = progressCache.get(threads);
  if (!held) progressCache.set(threads, (held = buildProgress(environmentId, threads)));
  return held;
}
const plansCache = new WeakMap<object, { plans: Map<string, { label: string }>; loaders: null }>();
export function useSidebarThreadPlans(threads: ReadonlyArray<EnvironmentThreadShell>) {
  let held = plansCache.get(threads);
  if (!held) {
    const plans = new Map<string, { label: string }>();
    for (const entry of threads) {
      const label = LINKS.get(`${entry.environmentId}:${entry.id}`);
      if (label) plans.set(scopedThreadKey(scopeThreadRef(entry.environmentId, entry.id)), { label });
    }
    plansCache.set(threads, (held = { plans, loaders: null }));
  }
  return held;
}
const ENVIRONMENTS = { environments: MACHINES.map((machine) => ({ ...machine })) };
export const useEnvironments = () => ENVIRONMENTS;
const NONE: ReadonlySet<string> = new Set();
export const useUnreachableHosts = () => NONE;
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
