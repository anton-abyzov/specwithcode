import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";

/** What one thread still has going when an update restart would cut it off. */
export interface RunningWorkThread {
  readonly threadId: string | null;
  readonly title: string;
  readonly running: number;
  readonly queued: number;
  readonly questions: number;
}

/** A project's share of the running work, its threads busiest first. */
export interface RunningWorkProject {
  readonly projectId: string | null;
  readonly title: string;
  readonly running: number;
  readonly queued: number;
  readonly questions: number;
  readonly threads: ReadonlyArray<RunningWorkThread>;
}

const RUNNING_KINDS: ReadonlySet<ServiceUpdateBlocker["kind"]> = new Set([
  "run",
  "effect",
  "session",
]);

function busiestFirst<
  T extends { running: number; queued: number; questions: number; title: string },
>(a: T, b: T): number {
  return (
    b.running - a.running ||
    b.queued + b.questions - (a.queued + a.questions) ||
    a.title.localeCompare(b.title)
  );
}

/**
 * Groups what the service reports as running by project, then thread. Work
 * the service cannot tie to a thread lands in an "Other work" group.
 */
export function groupRunningWork(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
): ReadonlyArray<RunningWorkProject> {
  type MutableThread = { -readonly [K in keyof RunningWorkThread]: RunningWorkThread[K] };
  const projects = new Map<
    string,
    { projectId: string | null; title: string; threads: Map<string, MutableThread> }
  >();
  for (const blocker of blockers) {
    if (blocker.count <= 0) continue;
    const projectKey = blocker.projectId ?? "";
    let project = projects.get(projectKey);
    if (project === undefined) {
      project = {
        projectId: blocker.projectId,
        title: blocker.projectTitle ?? (blocker.projectId === null ? "Other work" : "Project"),
        threads: new Map(),
      };
      projects.set(projectKey, project);
    }
    const threadKey = blocker.threadId ?? `untracked:${blocker.kind}`;
    let thread = project.threads.get(threadKey);
    if (thread === undefined) {
      thread = {
        threadId: blocker.threadId,
        title: blocker.threadTitle ?? "Background work",
        running: 0,
        queued: 0,
        questions: 0,
      };
      project.threads.set(threadKey, thread);
    }
    if (RUNNING_KINDS.has(blocker.kind)) thread.running += blocker.count;
    else if (blocker.kind === "queued") thread.queued += blocker.count;
    else thread.questions += blocker.count;
  }
  return [...projects.values()]
    .map((project) => {
      const threads = [...project.threads.values()].sort(busiestFirst);
      return {
        projectId: project.projectId,
        title: project.title,
        running: threads.reduce((total, thread) => total + thread.running, 0),
        queued: threads.reduce((total, thread) => total + thread.queued, 0),
        questions: threads.reduce((total, thread) => total + thread.questions, 0),
        threads,
      };
    })
    .sort((a, b) =>
      // Untied work goes last whatever its size.
      a.projectId === null ? 1 : b.projectId === null ? -1 : busiestFirst(a, b),
    );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line: how much runs and how widely, e.g. "5 running, 7 queued in 5 threads across 2 projects". */
export function summarizeRunningWork(groups: ReadonlyArray<RunningWorkProject>): string {
  const running = groups.reduce((total, group) => total + group.running, 0);
  const queued = groups.reduce((total, group) => total + group.queued, 0);
  const questions = groups.reduce((total, group) => total + group.questions, 0);
  const threads = groups.reduce(
    (total, group) => total + group.threads.filter((thread) => thread.threadId !== null).length,
    0,
  );
  const projects = groups.filter((group) => group.projectId !== null).length;
  const what = [
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
    questions > 0 ? plural(questions, "question waiting", "questions waiting") : null,
  ].filter(Boolean);
  const where = [
    threads > 0 ? `in ${plural(threads, "thread", "threads")}` : null,
    projects > 1 ? `across ${projects} projects` : null,
  ].filter(Boolean);
  return [what.join(", "), ...where].join(" ");
}

/** Counts for a row, e.g. "2 running · 1 queued". */
export function runningWorkCounts(work: {
  readonly running: number;
  readonly queued: number;
  readonly questions: number;
}): string {
  return [
    work.running > 0 ? `${work.running} running` : null,
    work.queued > 0 ? `${work.queued} queued` : null,
    work.questions > 0 ? plural(work.questions, "question", "questions") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What a restart would cut off in one thread: one row of the restart dialog's list. */
export interface RestartWorkRow {
  readonly key: string;
  readonly threadId: string | null;
  /** The machine the thread lives on, to open it; null when the list cannot tell. */
  readonly environmentId: string | null;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly state: "running" | "queued" | "question";
  /** What it is doing now: its current command or tool, else what the service reports. */
  readonly now: string;
  /** Where it runs ("M4", "M4 → Minis"); null when unknown. */
  readonly machine: string | null;
  readonly machineDescription: string | null;
}

/** What the client knows about a listed thread beyond what the service reports. */
export interface RestartWorkThreadInfo {
  readonly environmentId: string;
  /** The active run's newest unfinished command, tool or subagent. */
  readonly activeWork: string | null;
  readonly machine: string | null;
  readonly machineDescription: string | null;
}

function nowFor(thread: RunningWorkThread, activeWork: string | null): string {
  if (thread.running > 0) {
    if (activeWork !== null && activeWork.trim() !== "") return activeWork.trim();
    return thread.running === 1 ? "Working" : `${thread.running} running`;
  }
  if (thread.queued > 0)
    return thread.queued === 1 ? "1 message queued" : `${thread.queued} queued`;
  return thread.questions === 1
    ? "Waiting for your answer"
    : `${thread.questions} questions waiting`;
}

/**
 * The rows of the restart dialog: one per thread, busiest first, each with its
 * current step and machine when the client knows the thread.
 */
export function restartWorkRows(
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  info: (threadId: string) => RestartWorkThreadInfo | null,
  fallbackMachine: { readonly environmentId: string | null; readonly name: string | null } = {
    environmentId: null,
    name: null,
  },
): ReadonlyArray<RestartWorkRow> {
  const rows: Array<RestartWorkRow & { readonly weight: RunningWorkThread }> = [];
  for (const project of groupRunningWork(blockers)) {
    for (const thread of project.threads) {
      const known = thread.threadId === null ? null : info(thread.threadId);
      rows.push({
        key: `${project.projectId ?? ""}\u0000${thread.threadId ?? thread.title}`,
        threadId: thread.threadId,
        environmentId: known?.environmentId ?? fallbackMachine.environmentId,
        title: thread.title,
        projectTitle: project.projectId === null ? null : project.title,
        state: thread.running > 0 ? "running" : thread.queued > 0 ? "queued" : "question",
        now: nowFor(thread, known?.activeWork ?? null),
        machine: known?.machine ?? fallbackMachine.name,
        machineDescription: known?.machineDescription ?? null,
        weight: thread,
      });
    }
  }
  return rows
    .sort((a, b) =>
      a.threadId === null ? 1 : b.threadId === null ? -1 : busiestFirst(a.weight, b.weight),
    )
    .map(({ weight: _weight, ...row }) => row);
}

/** The count above the list: "3 threads running", "1 thread waiting", or "All quiet". */
export function restartWorkCount(rows: ReadonlyArray<RestartWorkRow>): string {
  if (rows.length === 0) return "All quiet";
  const running = rows.filter((row) => row.state === "running").length;
  const threads = plural(rows.length, "thread", "threads");
  if (running === rows.length) return `${threads} running`;
  if (running === 0) return `${threads} waiting`;
  return `${threads}: ${running} running`;
}

/** The default choice of every restart or update question that would cut off work. */
export const WAIT_UNTIL_QUIET = "Wait until quiet";

/**
 * The question above the live list: one title and one short line. `continues`
 * is true when every listed thread continues on its own after the restart.
 */
export function describeListedRestart(input: {
  readonly title: string;
  readonly continues: boolean;
  readonly folderCopies?: number;
  readonly openTerminals?: number;
}): string {
  const copies = input.folderCopies ?? 0;
  const terminals = input.openTerminals ?? 0;
  const line = [
    input.continues
      ? "Work cut off continues after the restart."
      : "Work cut off can be continued after the restart.",
    terminals > 0 ? `${plural(terminals, "terminal closes", "terminals close")}.` : null,
    copies > 0 ? `${plural(copies, "folder copy", "folder copies")} may need Retry.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `${input.title}\n${line}`;
}
