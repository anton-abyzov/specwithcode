import { RunId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const runId = RunId.make("run-1");
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

function message(id: string, text: string, role: "user" | "assistant" = "assistant") {
  const createdAt = at();
  return {
    id: `${id}-entry`,
    kind: "message" as const,
    createdAt,
    message: {
      id: id as never,
      role,
      text,
      runId: role === "assistant" ? runId : null,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    },
  };
}

function command(id: string, status: "completed" | "failed" = "completed") {
  const createdAt = at();
  return {
    id: `${id}-entry`,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      createdAt,
      runId,
      label: "Ran command",
      command: `echo ${id}`,
      tone: "tool" as const,
      itemType: "command_execution" as const,
      toolLifecycleStatus: status,
    },
  };
}

function read(id: string) {
  const createdAt = at();
  return {
    id: `${id}-entry`,
    kind: "work" as const,
    createdAt,
    entry: {
      id,
      createdAt,
      runId,
      label: "Read file",
      tone: "tool" as const,
      requestKind: "file-read" as const,
      toolLifecycleStatus: "completed" as const,
    },
  };
}

function rowsFor(
  timelineEntries: ReadonlyArray<unknown>,
  options: {
    expandedWorkGroupIds?: ReadonlySet<string>;
    expandedRunIds?: ReadonlySet<RunId>;
    timelineDetail?: "concise" | "normal" | "verbose";
  } = {},
): MessagesTimelineRow[] {
  return deriveMessagesTimelineRows({
    timelineEntries: timelineEntries as never,
    latestRun: {
      runId,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T01:00:00.000Z",
    },
    // The turn is open so its work is visible, as in a running worker or an expanded fold.
    expandedRunIds: new Set([runId]),
    isWorking: false,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    ...options,
  });
}

const narratedWork = () => [
  message("prompt", "Fix the contrast", "user"),
  message("intro", "I'll start by scanning the theme."),
  command("c1"),
  command("c2"),
  message("note-1", "Found the palette; reading the tokens."),
  read("r1"),
  message("note-2", "Running the scan again."),
  command("c3", "failed"),
  message("final", "Done: the contrast is fixed."),
];

describe("tool activity summary", () => {
  it("folds alternating tool groups and narration into one summary row", () => {
    const rows = rowsFor(narratedWork());
    const summary = rows.find((row) => row.kind === "tool-activity");

    expect(summary).toMatchObject({
      kind: "tool-activity",
      expanded: false,
      toolCount: 4,
      noteCount: 2,
      noteMessageIds: ["note-1", "note-2"],
      failedCount: 1,
    });
    expect(summary?.kind === "tool-activity" && summary.categories.map((c) => c.kind)).toEqual([
      "command",
      "read",
    ]);
    const messageIds = rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
    // The opening narration and the final reply frame the summary; step notes fold into it.
    expect(messageIds).toEqual(["prompt", "intro", "final"]);
    expect(rows.findIndex((row) => row.kind === "tool-activity")).toBe(
      rows.findIndex((row) => row.kind === "message" && row.message.id === "intro") + 1,
    );
  });

  it("shows the original rows indented when the summary is open", () => {
    const groupId = rowsFor(narratedWork()).find((row) => row.kind === "tool-activity")!.id;
    const rows = rowsFor(narratedWork(), { expandedWorkGroupIds: new Set([groupId]) });

    expect(rows.find((row) => row.kind === "tool-activity")?.expanded).toBe(true);
    const nested = rows.filter((row) => row.withinToolActivity);
    expect(nested.map((row) => (row.kind === "message" ? row.message.id : row.kind))).toEqual([
      "work-toggle",
      "note-1",
      "work",
      "note-2",
      "work",
    ]);
  });

  it("keeps long or code-bearing narration visible as a boundary", () => {
    const entries = [
      message("prompt", "Fix it", "user"),
      command("c1"),
      message("long", `Findings:\n\n${"detail ".repeat(100)}`),
      command("c2"),
      message("code", "Patch:\n```ts\nconst a = 1;\n```"),
      command("c3"),
      message("final", "Done."),
    ];
    const rows = rowsFor(entries);

    expect(rows.some((row) => row.kind === "tool-activity")).toBe(false);
    expect(rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []))).toEqual([
      "prompt",
      "long",
      "code",
      "final",
    ]);
  });

  it("leaves verbose detail unfolded", () => {
    // Verbose opens every turn; a listed run is one the reader closed.
    const rows = rowsFor(narratedWork(), {
      timelineDetail: "verbose",
      expandedRunIds: new Set(),
    });

    expect(rows.some((row) => row.kind === "tool-activity")).toBe(false);
    expect(rows.some((row) => row.kind === "message" && row.message.id === "note-1")).toBe(true);
  });

  it("does not fold a single tool row", () => {
    const rows = rowsFor([
      message("prompt", "Check", "user"),
      read("r1"),
      message("final", "Looks fine."),
    ]);

    expect(rows.some((row) => row.kind === "tool-activity")).toBe(false);
  });
});
