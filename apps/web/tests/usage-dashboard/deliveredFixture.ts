// Synthetic Delivered report (1456). Illustrative numbers only; no store is read.
import type { UsageDeliveredReport } from "@specweave-studio/contracts";

import {
  cost,
  group,
  increment,
  model,
  report,
} from "../../src/components/usage/delivered/deliveredFixtures";

const thread = (
  id: string,
  title: string,
  binding: "claim" | "branch" | "name" | "parent" | "manual" | null,
  usd: number,
  driver = "claudeAgent",
  name = "claude-opus-5-5",
) => ({
  threadId: id,
  title,
  binding,
  cost: cost(usd, 3, 0, Math.round(usd * 40_000)),
  byModel: [model(driver, name, usd)],
});

export function deliveredFixtureReport(): UsageDeliveredReport {
  return report({
    projects: [
      { projectId: "p1", title: "specweave", specweave: true },
      { projectId: "p2", title: "sample-app", specweave: true },
    ],
    increments: [
      increment({
        incrementId: "1390-rethink-copies-sync-and-handing-off-work",
        title: "Rethink copies, sync and handing off work",
        state: "merged",
        mergedAt: "2026-11-21T15:00:00.000Z",
        createdAt: "2026-10-12T09:00:00.000Z",
        tasks: { total: 24, done: 21, doneInRange: 9 },
        byModel: [
          model("claudeAgent", "claude-opus-5-5", 2104.4, "claude"),
          model("codex", "gpt-6.2-sol", 305.78, "codex"),
        ],
        threads: [
          thread("t1", "Rethink copies, sync and handing off work", "claim", 1622.1),
          thread("t2", "Adversarial review: sync, Sol", "parent", 305.78, "codex", "gpt-6.2-sol"),
          thread("t3", "Hand off progress bar", "branch", 482.3),
        ],
        threadCount: 14,
      }),
      increment({
        incrementId: "1357-usage-by-machine",
        title: "Usage by machine",
        state: "closed",
        closedAt: "2026-11-20T19:57:00.000Z",
        tasks: { total: 8, done: 8, doneInRange: 8 },
        byModel: [
          model("claudeAgent", "claude-opus-5-5", 1604.22, "claude"),
          model("claudeAgent", "claude-sonnet-5-5", 121.06, "claude"),
          model("codex", "gpt-6.2-sol", 137.12, "codex"),
        ],
        threads: [
          thread("t4", "Usage by machine (1357) build", "claim", 1210.8),
          thread(
            "t5",
            "Adversarial review: usage by machine, Sol",
            "parent",
            137.12,
            "codex",
            "gpt-6.2-sol",
          ),
          thread("t6", "Outside estimate fix", "name", 214.51),
        ],
        threadCount: 11,
      }),
      increment({
        incrementId: "1455-acp-registry-per-agent-rows",
        title: "ACP Registry per-agent rows and Effectiveness fix",
        state: "merged",
        mergedAt: "2026-11-24T05:10:00.000Z",
        tasks: { total: 6, done: 6, doneInRange: 6 },
        byModel: [model("claudeAgent", "claude-opus-5-5", 988.03, "claude")],
        threadCount: 9,
      }),
      increment({
        incrementId: "1448-link-personal-assistant",
        title: "Link the personal assistant",
        tasks: { total: 14, done: 12, doneInRange: 12 },
        byModel: [
          {
            ...model("claudeAgent", "claude-fable-5-2", 744.9, "claude"),
            unpricedRecords: 1,
            records: 4,
          },
        ],
        cost: cost(744.9, 4, 1),
        threadCount: 7,
      }),
      increment({
        incrementId: "0412-match-schedule-export",
        projectId: "p2",
        title: "Calendar export",
        state: "closed",
        closedAt: "2026-11-18T12:00:00.000Z",
        tasks: { total: 3, done: 3, doneInRange: 3 },
        byModel: [model("codex", "gpt-6.2-sol", 212.77, "codex")],
        threadCount: 5,
      }),
      increment({
        incrementId: "1447-machine-filter-includes-remote-workers",
        title: "Machine filter includes remote workers",
        state: "merged",
        mergedAt: "2026-11-23T08:06:00.000Z",
        tasks: { total: 2, done: 2, doneInRange: 2 },
        byModel: [model("copilot", "gemini-4-neon", 96.4)],
        threadCount: 3,
      }),
    ],
    coordinators: group(2281.1, "claudeAgent", 6),
    otherThreads: {
      ...group(9883.51, "claudeAgent", 170),
      threads: [
        thread("o1", "Release notes draft", null, 1690.2),
        thread("o2", "Docs site refresh", null, 1672.4),
        thread("o3", "Dependency upgrades", null, 1110.9),
      ],
    },
    outsideApp: { ...group(3945.3, "claudeAgent", 0), threads: [] },
  });
}
