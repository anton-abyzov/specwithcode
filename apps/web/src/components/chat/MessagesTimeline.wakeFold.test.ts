import { RunId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { mergeWakeNoticesIntoTurnFolds } from "./MessagesTimeline.wakeFold";

const run = RunId.make("run-1");
const createdAt = "2026-11-27T00:00:00.000Z";

function notice(outcome: string, runId: RunId | null = run): MessagesTimelineRow {
  return {
    kind: "work",
    id: `notice-${outcome}`,
    createdAt,
    isExpandedToolGroup: false,
    groupedEntries: [
      {
        id: `notice-${outcome}`,
        createdAt,
        runId,
        label: 'Delegated task "Docs" finished',
        tone: "info",
        itemType: "notification",
        structuredPayload: { type: "notification", outcome } as never,
      },
    ],
  } as MessagesTimelineRow;
}

function fold(expanded: boolean, runId: RunId = run): MessagesTimelineRow {
  return {
    kind: "turn-fold",
    id: `turn-fold:${runId}`,
    createdAt,
    runId,
    label: "Worked for 20s",
    expanded,
    failedCount: 0,
  } as unknown as MessagesTimelineRow;
}

const shape = (rows: ReadonlyArray<MessagesTimelineRow>) =>
  rows.map((row) =>
    row.kind === "turn-fold" ? `fold${row.wake ? `+${row.wake.label}` : ""}` : row.kind,
  );

describe("mergeWakeNoticesIntoTurnFolds", () => {
  it("leads a collapsed fold with the notice that started its run", () => {
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice("completed"), fold(false)]))).toEqual([
      'fold+Delegated task "Docs" finished',
    ]);
  });

  it("shows the notice as the first row of an open fold", () => {
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice("updated"), fold(true)]))).toEqual([
      'fold+Delegated task "Docs" finished',
      "work",
    ]);
  });

  it.each(["failed", "cancelled"])("keeps a %s notice on its own row", (outcome) => {
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice(outcome), fold(false)]))).toEqual([
      "work",
      "fold",
    ]);
  });

  it("keeps a notice whose run has no fold under it", () => {
    const other = fold(false, RunId.make("run-2"));
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice("completed"), other]))).toEqual([
      "work",
      "fold",
    ]);
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice("completed")]))).toEqual(["work"]);
  });
});
