import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({ classify: 0, failureScan: 0 }));

vi.mock("@specweave-studio/shared/toolActivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@specweave-studio/shared/toolActivity")>();
  return {
    ...actual,
    classifyToolActivity: (...args: Parameters<typeof actual.classifyToolActivity>) => {
      calls.classify += 1;
      return actual.classifyToolActivity(...args);
    },
  };
});

vi.mock("@specweave-studio/shared/toolOutput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@specweave-studio/shared/toolOutput")>();
  return {
    ...actual,
    toolOutputIndicatesFailure: (...args: Parameters<typeof actual.toolOutputIndicatesFailure>) => {
      calls.failureScan += 1;
      return actual.toolOutputIndicatesFailure(...args);
    },
  };
});

import {
  toolGroupAction,
  workEntryDisplayIndicatesToolFailure,
  workEntryFailureKind,
  workEntryIndicatesToolFailure,
  type WorkLogPresentationEntry,
} from "./presentation.ts";

function commandEntry(id: string, detail: string): WorkLogPresentationEntry {
  return {
    id,
    createdAt: "2026-11-14T12:00:00.000Z",
    label: "Ran command",
    tone: "tool",
    itemType: "command_execution",
    command: "pnpm test",
    detail,
    toolLifecycleStatus: "completed",
  } as WorkLogPresentationEntry;
}

/** One timeline update: every row of the log is re-derived. */
function deriveRows(entries: readonly WorkLogPresentationEntry[]) {
  return entries.map((entry) => ({
    action: toolGroupAction(entry),
    failed: workEntryIndicatesToolFailure(entry),
    displayFailed: workEntryDisplayIndicatesToolFailure(entry),
    failureKind: workEntryFailureKind(entry),
  }));
}

describe("work-row derivation per entry", () => {
  beforeEach(() => {
    calls.classify = 0;
    calls.failureScan = 0;
  });

  it("derives an unchanged entry once across stream ticks", () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      commandEntry(`entry-${index}`, index % 4 === 0 ? "sh: tsc: command not found" : "ok"),
    );
    const first = deriveRows(entries);
    const afterFirst = { ...calls };
    expect(afterFirst.classify).toBe(entries.length);

    for (let tick = 0; tick < 50; tick += 1) {
      expect(deriveRows(entries)).toEqual(first);
    }
    expect(calls).toEqual(afterFirst);
  });

  it("derives a replaced entry again", () => {
    const entry = commandEntry("entry", "ok");
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    const replaced = commandEntry("entry", "sh: tsc: command not found");
    expect(workEntryIndicatesToolFailure(replaced)).toBe(true);
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(toolGroupAction(replaced)).toBe("command");
  });
});
