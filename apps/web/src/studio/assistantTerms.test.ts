import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { assistantComposerPlaceholder, paneWords, withPinnedTopics } from "./assistantTerms";

const thread = (id: string, pinnedAt: string | null) =>
  ({ id, pinnedAt }) as unknown as EnvironmentThreadShell;

describe("paneWords", () => {
  it("says topic in the assistant", () => {
    const say = paneWords(true, "Percy");
    expect(say("Threads")).toBe("Topics");
    expect(say("Find a thread (/)")).toBe("Find a topic (/)");
    expect(say("No threads yet. Ask the coordinator to start one.")).toBe(
      "No topics yet. Ask Percy to start one.",
    );
    expect(say("1 thread is waiting on you")).toBe("1 topic is waiting on you");
  });

  it("calls the assistant by its own name, as typed", () => {
    expect(paneWords(true, "Thread Keeper")("Ask the coordinator for a thread")).toBe(
      "Ask Thread Keeper for a topic",
    );
    expect(paneWords(true, " ")("Ask the coordinator")).toBe("Ask your assistant");
    expect(paneWords(true)("Ask the coordinator")).toBe("Ask your assistant");
  });

  it("names the assistant in the composer placeholder", () => {
    expect(assistantComposerPlaceholder("Jarvis")).toBe("Ask Jarvis anything");
    expect(assistantComposerPlaceholder(undefined)).toBe("Ask your assistant anything");
  });

  it("leaves a project's words alone", () => {
    expect(paneWords(false)("Ask the coordinator for a thread")).toBe(
      "Ask the coordinator for a thread",
    );
    expect(paneWords(undefined)("Threads")).toBe("Threads");
  });
});

describe("withPinnedTopics", () => {
  it("leads with quiet pinned topics and leaves waiting ones in their group", () => {
    const groups = withPinnedTopics([
      { group: "Needs you", threads: [thread("asks", "2026-11-03")] },
      { group: "Idle", threads: [thread("errand", null), thread("taxes", "2026-11-03")] },
      { group: "Resolved", threads: [thread("health", "2026-11-03")] },
    ]);
    expect(groups.map((entry) => [entry.group, entry.threads.map(({ id }) => id)])).toEqual([
      ["Pinned", ["taxes", "health"]],
      ["Needs you", ["asks"]],
      ["Idle", ["errand"]],
      ["Resolved", []],
    ]);
  });

  it("adds no section when nothing is pinned", () => {
    const groups = withPinnedTopics([{ group: "Idle", threads: [thread("errand", null)] }]);
    expect(groups.map((entry) => entry.group)).toEqual(["Idle"]);
  });
});
