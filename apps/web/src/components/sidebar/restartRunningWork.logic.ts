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
