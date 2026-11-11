import { ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  importedThreadRepairCommand,
  importedThreadsToRepair,
} from "./ImportedThreadTitleRepair.ts";

const shell = (id: string, title: string, historyOrigin?: "native" | "v1_import") => ({
  id: ThreadId.make(id),
  title,
  ...(historyOrigin === undefined ? {} : { historyOrigin }),
});

describe("importedThreadsToRepair", () => {
  it("picks only imported threads whose title is harness markup", () => {
    const threads = [
      shell("import:codex:a", "<environment_context>", "v1_import"),
      shell(
        "import:claudeAgent:b",
        '<wake reason="mention" current-time="2026-10-30T04:18:',
        "v1_import",
      ),
      shell("import:claudeAgent:c", "Fix authentication", "v1_import"),
      // A person can name a thread anything; only imports are repaired.
      shell("thread:d", "<environment_context>", "native"),
      shell("thread:e", "<environment_context>"),
    ];

    expect(importedThreadsToRepair(threads).map((thread) => thread.id)).toEqual([
      "import:codex:a",
      "import:claudeAgent:b",
    ]);
  });
});

describe("importedThreadRepairCommand", () => {
  const thread = { id: ThreadId.make("import:codex:a") };

  it("renames from the first line a person typed", () => {
    expect(
      importedThreadRepairCommand(thread, [
        { role: "user", text: "<environment_context>\n<cwd>/tmp/p</cwd>\n</environment_context>" },
        { role: "assistant", text: "Ready." },
        { role: "user", text: "Add a weekly plan page\nwith a chart" },
      ]),
    ).toMatchObject({
      type: "thread.metadata.update",
      commandId: "imported-thread-title-repair:import:codex:a",
      threadId: "import:codex:a",
      title: "Add a weekly plan page",
    });
  });

  it("archives a session nobody typed in", () => {
    expect(
      importedThreadRepairCommand(thread, [
        { role: "user", text: '<wake reason="mention" current-time="2026-10-30T04:18:00Z">' },
        { role: "assistant", text: "Checked in." },
      ]),
    ).toMatchObject({
      type: "thread.archive",
      commandId: "imported-thread-title-repair:archive:import:codex:a",
      threadId: "import:codex:a",
    });
  });
});
