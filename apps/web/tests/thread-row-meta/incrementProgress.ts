// Synthetic increment progress for the fixture's threads; no host is asked.
import type { ThreadIncrementProgress } from "@specweave-studio/contracts";

const done = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: `T-0${index + 1}`,
    title: `Task ${index + 1}`,
    status: "done",
    criteria: [],
    note: null,
    link: "https://github.com/example/repo/pull/1",
  }));

const progress = new Map<string, ThreadIncrementProgress>(
  (
    [
      ["matchcam", "1011", 6],
      ["season", "1013", 5],
      ["positions", "1012", 3],
    ] as const
  ).map(([threadId, incrementId, total]) => [
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
      tasks: done(total),
      criteria: [],
    } as unknown as ThreadIncrementProgress,
  ]),
);

export function useProjectThreadIncrementProgress() {
  return { progress, unplanned: new Set(["business", "audit"]), answered: true };
}
