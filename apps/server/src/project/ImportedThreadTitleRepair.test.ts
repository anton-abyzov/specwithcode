import { ThreadId, type OrchestrationV2AppThread } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  importedThreadRenameEvent,
  importedThreadRepair,
  importedThreadsToRepair,
} from "./ImportedThreadTitleRepair.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);
const importedAt = time("2026-11-11T14:00:00.000Z");
const usedAt = time("2026-10-18T02:24:00.000Z");

const shell = (id: string, title: string, historyOrigin?: "native" | "v1_import") => ({
  id: ThreadId.make(id),
  title,
  ...(historyOrigin === undefined ? {} : { historyOrigin }),
});

/** A thread as an earlier import left it: settled, stamped with the file's time. */
const imported = (title: string, changes: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id: ThreadId.make("import:codex:a"),
    title,
    updatedAt: importedAt,
    settledOverride: "settled",
    settledAt: importedAt,
    pinnedAt: null,
    archivedAt: null,
    ...changes,
  }) as OrchestrationV2AppThread;

const message = (role: "user" | "assistant", text: string, createdAt = usedAt) => ({
  role,
  text,
  createdAt,
});

const setup = "<environment_context>\n<cwd>/tmp/p</cwd>\n</environment_context>";
const wake = '<wake reason="mention" current-time="2026-10-30T04:18:00Z">Check the queue</wake>';
const idle = { hasRuns: false };

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
      // A tag no harness writes is a name a person could have typed.
      shell("import:claudeAgent:d", "<T>", "v1_import"),
      shell(
        "import:claudeAgent:e",
        "<instructions>Refactor the parser</instructions>",
        "v1_import",
      ),
      // Only imports are repaired.
      shell("thread:f", "<environment_context>", "native"),
      shell("thread:g", "<environment_context>"),
    ];

    expect(importedThreadsToRepair(threads).map((thread) => thread.id)).toEqual([
      "import:codex:a",
      "import:claudeAgent:b",
    ]);
  });
});

describe("importedThreadRepair", () => {
  it("renames from the first typed line and dates the thread by its last message", () => {
    expect(
      importedThreadRepair(
        imported("<environment_context>"),
        [
          message("user", setup, time("2026-10-18T02:20:00.000Z")),
          message("user", "Add a weekly plan page\nwith a chart", time("2026-10-18T02:21:00.000Z")),
          message("assistant", "Done."),
        ],
        idle,
      ),
    ).toEqual({ type: "rename", title: "Add a weekly plan page", updatedAt: usedAt });
  });

  it("leaves a thread a person renamed, whatever they called it", () => {
    expect(
      importedThreadRepair(
        imported("<wake> handler notes"),
        [message("user", setup), message("user", "Add a weekly plan page")],
        idle,
      ),
    ).toBeNull();
    // Renamed to another harness-looking line: still not the title the import wrote.
    expect(
      importedThreadRepair(
        imported("<system-reminder>"),
        [message("user", setup), message("user", "Add a weekly plan page")],
        idle,
      ),
    ).toBeNull();
  });

  it("archives an untouched session nobody typed in", () => {
    expect(
      importedThreadRepair(
        imported(wake),
        [message("user", wake), message("assistant", "Checked in.")],
        idle,
      ),
    ).toEqual({ type: "archive" });
  });

  it("keeps a long session whose typed line the import may have left out", () => {
    // The import stored the first message and the last 199 of a longer session.
    const messages = [
      message("user", setup),
      ...Array.from({ length: 199 }, () => message("assistant", "Working.")),
    ];
    expect(importedThreadRepair(imported("<environment_context>"), messages, idle)).toEqual({
      type: "rename",
      title: "Imported session",
      updatedAt: usedAt,
    });
  });

  it.each([
    ["pinned", imported("<environment_context>", { pinnedAt: importedAt }), idle],
    [
      "reopened",
      imported("<environment_context>", { settledOverride: "active", settledAt: null }),
      idle,
    ],
    [
      "changed after the import",
      imported("<environment_context>", { updatedAt: time("2026-11-11T15:00:00.000Z") }),
      idle,
    ],
    ["continued", imported("<environment_context>"), { hasRuns: true }],
  ])("never archives a thread someone %s, and keeps its time", (_name, thread, options) => {
    expect(importedThreadRepair(thread, [message("user", setup)], options)).toEqual({
      type: "rename",
      title: "Imported session",
      updatedAt: thread.updatedAt,
    });
  });

  it("does not move a thread's time forward", () => {
    const late = time("2026-11-12T09:00:00.000Z");
    expect(
      importedThreadRepair(
        imported("<environment_context>"),
        [message("user", setup), message("user", "Ship it", late)],
        idle,
      ),
    ).toEqual({ type: "rename", title: "Ship it", updatedAt: importedAt });
  });

  it("leaves a thread with no stored user message", () => {
    expect(
      importedThreadRepair(imported("<environment_context>"), [message("assistant", "Hi")], idle),
    ).toBeNull();
  });
});

describe("importedThreadRenameEvent", () => {
  it("renames the thread at its session's time, not now", () => {
    const thread = imported("<environment_context>");
    const event = importedThreadRenameEvent(thread, {
      type: "rename",
      title: "Add a weekly plan page",
      updatedAt: usedAt,
    });

    expect(event).toMatchObject({
      type: "thread.metadata-updated",
      threadId: "import:codex:a",
      occurredAt: usedAt,
      payload: { title: "Add a weekly plan page", updatedAt: usedAt, settledAt: usedAt },
    });
    expect(event.id).toBe(
      `imported-thread-title-repair:import:codex:a:${DateTime.toEpochMillis(importedAt)}:renamed`,
    );
  });

  it("keeps the settle time of a thread someone changed", () => {
    const changedAt = time("2026-11-11T15:00:00.000Z");
    const thread = imported("<environment_context>", { updatedAt: changedAt });
    const event = importedThreadRenameEvent(thread, {
      type: "rename",
      title: "Imported session",
      updatedAt: changedAt,
    });

    expect(event.payload).toMatchObject({ updatedAt: changedAt, settledAt: importedAt });
  });
});
