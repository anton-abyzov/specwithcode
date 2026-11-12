import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { paneWords, withPinnedTopics } from "./assistantTerms";

const thread = (id: string, pinnedAt: string | null) =>
  ({ id, pinnedAt }) as unknown as EnvironmentThreadShell;

describe("paneWords", () => {
  it("says topic in the assistant", () => {
    const say = paneWords(true);
    expect(say("Threads")).toBe("Topics");
    expect(say("Find a thread (/)")).toBe("Find a topic (/)");
    expect(say("No threads yet. Ask the coordinator to start one.")).toBe(
      "No topics yet. Ask Aide to start one.",
    );
    expect(say("1 thread is waiting on you")).toBe("1 topic is waiting on you");
    expect(say("The coordinator runs on this model.")).toBe("Aide runs on this model.");
    expect(say("Close thread pane")).toBe("Close topic pane");
  });

  it("leaves tool names and other words alone", () => {
    const say = paneWords(true);
    expect(say("Ask with studio_thread_send")).toBe("Ask with studio_thread_send");
    expect(say("Open pull request")).toBe("Open pull request");
    expect(say("Coordinator model")).toBe("Coordinator model");
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
