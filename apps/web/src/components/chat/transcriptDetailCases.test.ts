import { MessageId, RunId, type TimelineDetail } from "@specweave-studio/contracts";
import cases from "@specweave-studio/shared/transcriptDetail.cases.json";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";

// The shared transcript detail rule (docs/transcript-detail.md), checked on the
// web and desktop timeline. iOS runs the same cases in TranscriptDetailCasesTests.

type CaseRow = { id: string; kind: string; running?: boolean };
type DetailCase = {
  name: string;
  running: boolean;
  platforms?: string[];
  rows: CaseRow[];
  normal: string[];
  concise: string[];
};

const base = Date.parse("2026-11-07T21:00:00.000Z");

function entriesFor(testCase: DetailCase): { entries: TimelineEntry[]; latestRunId: RunId } {
  let turn = 0;
  let runId = RunId.make("run-0");
  const entries = testCase.rows.map((row, index): TimelineEntry => {
    const createdAt = new Date(base + index * 1000).toISOString();
    if (row.kind === "user") {
      turn += 1;
      runId = RunId.make(`run-${turn}`);
    }
    if (row.kind === "user" || row.kind === "note" || row.kind === "reply") {
      return {
        id: row.id,
        kind: "message",
        createdAt,
        message: {
          id: MessageId.make(row.id),
          role: row.kind === "user" ? "user" : "assistant",
          text: `${row.kind} ${row.id}`,
          runId: row.kind === "user" ? null : runId,
          createdAt,
          updatedAt: createdAt,
          streaming: false,
        },
      };
    }
    const status = row.running ? "inProgress" : row.kind === "failed" ? "failed" : "completed";
    const shared = { id: row.id, createdAt, runId, toolLifecycleStatus: status } as const;
    const entry =
      row.kind === "thinking"
        ? { ...shared, label: "Thinking", tone: "thinking", itemType: "reasoning", detail: "hmm" }
        : row.kind === "tool"
          ? {
              ...shared,
              label: "mcp__studio-code__chrome_snapshot",
              tone: "tool",
              itemType: "dynamic_tool",
              toolTitle: "mcp__studio-code__chrome_snapshot",
              detail: "ok",
            }
          : {
              ...shared,
              label: "Ran command",
              tone: row.kind === "failed" ? "error" : "tool",
              itemType: "command_execution",
              command: "ls",
              detail: row.kind === "failed" ? "exit 1" : "ok",
              ...(row.kind === "failed" ? { exitCode: 1 } : {}),
            };
    return { id: row.id, kind: "work", createdAt, entry } as TimelineEntry;
  });
  return { entries, latestRunId: runId };
}

function tokens(rows: ReadonlyArray<MessagesTimelineRow>): string[] {
  return rows.flatMap((row): string[] => {
    switch (row.kind) {
      case "message":
        return [row.message.id];
      case "work-live":
        return [row.expanded ? "live-open" : "live"];
      case "work-toggle":
        return [row.expanded ? "fold-open" : "fold"];
      case "turn-fold":
      case "attempt-fold":
        return ["fold"];
      case "work":
        // A run of one step shows as that step.
        return row.groupedEntries.length === 1
          ? [row.groupedEntries[0]!.id]
          : [`work:${row.groupedEntries.map((entry) => entry.id).join("+")}`];
      case "working":
        return [];
      default:
        return [row.kind];
    }
  });
}

const runs = (cases as { cases: DetailCase[] }).cases
  .filter((testCase) => !testCase.platforms || testCase.platforms.includes("web"))
  .flatMap((testCase) =>
    (["normal", "concise"] as const satisfies TimelineDetail[]).map((detail) => ({
      detail,
      testCase,
    })),
  );

describe("shared transcript detail cases", () => {
  it.each(runs)("$detail: $testCase.name", ({ detail, testCase }) => {
    const { entries, latestRunId } = entriesFor(testCase);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId: latestRunId,
        status: testCase.running ? "running" : "completed",
        startedAt: entries[0]!.createdAt,
        completedAt: testCase.running ? null : entries.at(-1)!.createdAt,
      },
      runningRunId: testCase.running ? latestRunId : null,
      isWorking: testCase.running,
      activeTurnStartedAt: testCase.running ? entries[0]!.createdAt : null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      timelineDetail: detail,
    });
    expect(tokens(rows)).toEqual(testCase[detail]);
  });
});
