// Synthetic increment progress for the fixture's threads; no host is asked.
import type { ThreadIncrementProgress } from "@specweave-studio/contracts";

const done = (n: number, open = 0) =>
  Array.from({ length: n }, (_, index) => ({
    id: `T-0${index + 1}`,
    title: `Task ${index + 1}`,
    status: index < n - open ? "done" : "open",
    criteria: [],
    note: null,
    link: "https://github.com/example/repo/pull/1",
  }));

const progress = new Map<string, ThreadIncrementProgress>(
  (
    [
      ["matchcam", "1011", 6, 0],
      ["season", "1013", 5, 0],
      ["positions", "1012", 3, 0],
      ["setup", "1006", 10, 1],
      ["orchestrators", "0969", 15, 0],
    ] as const
  ).map(([threadId, incrementId, total, open]) => [
    threadId,
    {
      threadId,
      incrementId,
      binding: "claim",
      boundTaskId: null,
      title: null,
      status: "active",
      incrementPath: `/fixture/.specweave/increments/${incrementId}`,
      specPath: null,
      readable: true,
      tasks: done(total, open),
      criteria: [],
    } as unknown as ThreadIncrementProgress,
  ]),
);

// The machine "env-mini" answers for its own thread, as its server would: the
// Minisforum's "Build SpecOS on Linux", 12 of 26 tasks done on November 11.
const elsewhere = new Map<string, ThreadIncrementProgress>([
  [
    "specos",
    {
      threadId: "specos",
      incrementId: "0001-specos-browser-desktop-for-ai-agent-work",
      binding: "claim",
      boundTaskId: "T-13",
      title: "SpecOS: browser desktop for AI agent work",
      status: "active",
      incrementPath:
        "/home/anton/live/spec-os/.specweave/increments/0001-specos-browser-desktop-for-ai-agent-work",
      specPath: null,
      readable: true,
      tasks: done(26, 14),
      criteria: [],
    } as unknown as ThreadIncrementProgress,
  ],
]);
const none = new Map<string, ThreadIncrementProgress>();

/** Asked once per machine and project for the threads that run elsewhere. */
export function useThreadIncrementProgress(input: {
  readonly environmentId: string | null;
  readonly projectId: string | null;
  readonly threadIds: ReadonlyArray<string>;
}) {
  const asked = ((globalThis as { planQueries?: unknown[] }).planQueries ??= []);
  const key = `${input.environmentId}/${input.projectId}/${input.threadIds.join(",")}`;
  if (!asked.includes(key)) asked.push(key);
  return input.environmentId === "env-mini" && input.projectId === "project-mini"
    ? elsewhere
    : none;
}

export function useProjectThreadIncrementProgress() {
  return { progress, unplanned: new Set(["business", "audit"]), answered: true };
}
