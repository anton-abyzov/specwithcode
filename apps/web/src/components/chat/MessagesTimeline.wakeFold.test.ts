import { RunId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { mergeWakeNoticesIntoTurnFolds } from "./MessagesTimeline.wakeFold";

const run = RunId.make("run-1");
const createdAt = "2026-11-27T00:00:00.000Z";

function notice(
  outcome: string,
  runId: RunId | null = run,
  source: object = { kind: "background_task" },
): MessagesTimelineRow {
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
        structuredPayload: { type: "notification", outcome, source } as never,
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

  it("leaves the notice on its own row above an open fold", () => {
    expect(shape(mergeWakeNoticesIntoTurnFolds([notice("updated"), fold(true)]))).toEqual([
      "work",
      "fold",
    ]);
  });

  it("keeps the delegated task's thread one click away on the fold", () => {
    const child = ThreadId.make("child-thread");
    const [merged] = mergeWakeNoticesIntoTurnFolds([
      notice("completed", run, { kind: "delegated_task", childThreadId: child }),
      fold(false),
    ]);
    expect(merged?.kind === "turn-fold" ? merged.wake : undefined).toEqual({
      label: 'Delegated task "Docs" finished',
      childThreadId: child,
    });
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
