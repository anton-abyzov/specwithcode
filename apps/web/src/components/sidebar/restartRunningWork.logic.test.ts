import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupRunningWork,
  runningWorkCounts,
  summarizeRunningWork,
} from "./restartRunningWork.logic";

const blocker = (
  kind: ServiceUpdateBlocker["kind"],
  count: number,
  thread: string | null,
  project: string | null,
) =>
  ({
    kind,
    count,
    threadId: thread === null ? null : `thread-${thread}`,
    threadTitle: thread,
    projectId: project === null ? null : `project-${project}`,
    projectTitle: project,
  }) as unknown as ServiceUpdateBlocker;

describe("groupRunningWork", () => {
  it("groups by project, busiest first, threads busiest first", () => {
    const groups = groupRunningWork([
      blocker("queued", 3, "Docs", "specweave"),
      blocker("run", 1, "Ship recording", "EasyChamp"),
      blocker("run", 1, "Audit", "specweave"),
      blocker("session", 1, "Audit", "specweave"),
      blocker("request", 1, "Logo", "specweave"),
      blocker("effect", 1, null, null),
    ]);
    expect(
      groups.map((group) => [group.title, group.running, group.queued, group.questions]),
    ).toEqual([
      ["specweave", 2, 3, 1],
      ["EasyChamp", 1, 0, 0],
      ["Other work", 1, 0, 0],
    ]);
    expect(groups[0]!.threads.map((thread) => thread.title)).toEqual(["Audit", "Docs", "Logo"]);
    expect(groups[2]!.threads[0]).toMatchObject({ threadId: null, title: "Background work" });
  });

  it("summarizes in one line and counts each row", () => {
    const groups = groupRunningWork([
      blocker("run", 5, "A", "specweave"),
      blocker("queued", 7, "B", "EasyChamp"),
    ]);
    expect(summarizeRunningWork(groups)).toBe("5 running, 7 queued in 2 threads across 2 projects");
    expect(runningWorkCounts({ running: 2, queued: 1, questions: 1 })).toBe(
      "2 running · 1 queued · 1 question",
    );
  });

  it("is empty when nothing runs", () => {
    expect(groupRunningWork([blocker("run", 0, "A", "p")])).toEqual([]);
  });
});
