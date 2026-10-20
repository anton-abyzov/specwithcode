import { describe, expect, it } from "vite-plus/test";
import {
  PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  ProjectId,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeStatus,
} from "@specweave-studio/contracts";
import {
  knowledgeAccess,
  knowledgeAccessProblem,
  knowledgeAllowanceText,
  knowledgeCapacity,
  knowledgeModeText,
  knowledgeModifiedDate,
  knowledgeSearchText,
  knowledgeShouldPoll,
  knowledgeSkippedText,
  knowledgeStateText,
  knowledgeTokens,
} from "./projectKnowledgeModel";

const status = (patch: Partial<ProjectKnowledgeStatus> = {}): ProjectKnowledgeStatus => ({
  projectId: ProjectId.make("project"),
  mode: "inline",
  state: "ready",
  documents: 12,
  characters: 40_000,
  inlineCharacters: 6_000,
  inlineLimit: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  inlineReturnLimit: PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  bytes: 44_000,
  capacityBytes: PROJECT_KNOWLEDGE_MAX_BYTES,
  capacityDocuments: PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  sources: [],
  skipped: { tooLarge: 0, overCapacity: 0, unreadable: 0 },
  indexedAt: "2026-10-20T10:00:00.000Z",
  problem: null,
  ...patch,
});

describe("project knowledge presentation", () => {
  it("explains each mode, and that the coordinator only gets a catalog", () => {
    expect(knowledgeModeText(status({ mode: "empty" })).title).toBe("Nothing to index yet");
    // Only Claude and Codex threads are sent memory and hub artifacts in full.
    expect(knowledgeModeText(status()).detail).toBe(
      "Memory files and hub artifacts fit, so Claude and Codex worker threads receive them in full. Library folders are searched when a thread needs them. The coordinator receives a short catalog only.",
    );
    expect(knowledgeModeText(status({ mode: "search" })).detail).toBe(
      "Worker threads search all project knowledge and read the passages they need. The coordinator receives a short catalog only.",
    );
  });

  it("names a first build that failed, with its problem, instead of an empty project", () => {
    const problem = "The knowledge index could not be updated. Rebuild it.";
    const failed = status({ mode: "empty", state: "failed", indexedAt: null, problem });
    expect(knowledgeModeText(failed)).toEqual({ title: "Index not built", detail: problem });
    expect(knowledgeModeText({ ...failed, problem: null }).title).toBe("Index not built");
    // A later refresh that failed keeps the mode the last good index has.
    expect(knowledgeModeText(status({ state: "failed", problem })).title).toBe(
      "Memory sent in full",
    );
  });

  it("measures capacity by whichever limit is closer, size on disk or document count", () => {
    const bySize = knowledgeCapacity(status({ bytes: PROJECT_KNOWLEDGE_MAX_BYTES / 2 }));
    expect(bySize.share).toBe(0.5);
    expect(bySize.tone).toBe("ok");
    const byCount = knowledgeCapacity(
      status({ documents: PROJECT_KNOWLEDGE_MAX_DOCUMENTS * 0.9, bytes: 10 }),
    );
    expect(byCount.share).toBeCloseTo(0.9);
    expect(byCount.tone).toBe("warn");
    // The limits are the host's, not this app's constants.
    expect(
      knowledgeCapacity(status({ bytes: 30, capacityBytes: 100, capacityDocuments: 40 })).share,
    ).toBe(0.3);
    expect(knowledgeCapacity(status({ documents: 12, capacityDocuments: 15 })).share).toBe(0.8);
    // Extracted text never fills the bar; only bytes and documents do.
    expect(knowledgeCapacity(status({ characters: 100_000_000, bytes: 10 })).share).toBeLessThan(
      0.01,
    );
    expect(knowledgeCapacity(status({ bytes: 10 })).label).toContain("under 1% full");
    expect(knowledgeCapacity(status({ documents: 1, characters: 3_000 })).label).toBe(
      "1 document, about 1K tokens. The index is under 1% full.",
    );
  });

  it("reads a capacity the host did not report as unused, never as full", () => {
    const unknown = knowledgeCapacity(
      status({ bytes: 5_000, capacityBytes: 0, documents: 12, capacityDocuments: 0 }),
    );
    expect(unknown.share).toBe(0);
    expect(unknown.tone).toBe("ok");
    expect(unknown.label).toBe("12 documents, about 13K tokens. The index is 0% full.");
    expect(knowledgeCapacity(status({ capacityBytes: 0, documents: 10_000 })).share).toBe(0.5);
  });

  it("turns red once files are left out for capacity", () => {
    const full = knowledgeCapacity(
      status({ skipped: { tooLarge: 0, overCapacity: 3, unreadable: 0 } }),
    );
    expect(full.tone).toBe("full");
  });

  it("states the inline allowance plainly in both modes", () => {
    expect(knowledgeAllowanceText(status())).toBe(
      "Memory files and hub artifacts: about 2K tokens of the 8K threads receive in full.",
    );
    expect(knowledgeAllowanceText(status({ mode: "search", inlineCharacters: 30_000 }))).toBe(
      "Memory files and hub artifacts come to about 10K tokens, past the 8K threads receive in full. Below 6.4K they are sent in full again.",
    );
  });

  it("in search mode, claims memory is past the allowance only when it is", () => {
    // Library files alone: nothing to send in full.
    expect(knowledgeAllowanceText(status({ mode: "search", inlineCharacters: 0 }))).toBe(
      "There are no memory files or hub artifacts to send in full, so threads search the Library.",
    );
    // Back under the allowance but not yet under the lower mark: still searching, on purpose.
    const between =
      "Threads keep searching until they fall below 6.4K, so edits near the limit do not switch back and forth.";
    expect(knowledgeAllowanceText(status({ mode: "search", inlineCharacters: 22_500 }))).toBe(
      `Memory files and hub artifacts come to about 7.5K tokens. ${between}`,
    );
    expect(
      knowledgeAllowanceText(
        status({ mode: "search", inlineCharacters: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT }),
      ),
    ).toBe(`Memory files and hub artifacts come to about 8K tokens. ${between}`);
    expect(knowledgeAllowanceText(status({ mode: "search", inlineCharacters: 600 }))).toBe(
      `Memory files and hub artifacts come to about 200 tokens. ${between}`,
    );
    expect(
      knowledgeAllowanceText(
        status({ mode: "search", inlineCharacters: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT + 1 }),
      ),
    ).toContain("past the 8K threads receive in full");
    for (const inlineCharacters of [0, 600, 22_500, 24_000])
      expect(knowledgeAllowanceText(status({ mode: "search", inlineCharacters }))).not.toContain(
        "past the",
      );
  });

  it("counts left-out files by reason, or says nothing when none are", () => {
    expect(knowledgeSkippedText({ tooLarge: 0, overCapacity: 0, unreadable: 0 })).toBeNull();
    expect(knowledgeSkippedText({ tooLarge: 1, overCapacity: 0, unreadable: 0 })).toBe(
      "1 file left out: 1 over 2 MB.",
    );
    expect(knowledgeSkippedText({ tooLarge: 2, overCapacity: 1_500, unreadable: 1 })).toBe(
      "1,503 files left out: 2 over 2 MB, 1,500 past the index capacity, 1 unreadable or protected.",
    );
  });

  it("says when the index was built, that it is building, or why it failed", () => {
    const ago = () => "5m ago";
    expect(knowledgeStateText(status(), ago)).toBe("Indexed 5m ago.");
    expect(knowledgeStateText(status({ state: "indexing" }), ago)).toBe("Indexing…");
    expect(knowledgeStateText(status({ state: "unindexed" }), ago)).toBe("Not indexed yet.");
    expect(
      knowledgeStateText(status({ state: "failed", problem: "The disk is almost full." }), ago),
    ).toBe("Indexed 5m ago. The disk is almost full.");
  });

  it("never says Indexed when there is no index yet", () => {
    const ago = () => "5m ago";
    expect(knowledgeStateText(status({ indexedAt: null }), ago)).toBe("Not indexed yet.");
    expect(
      knowledgeStateText(
        status({
          mode: "empty",
          state: "failed",
          indexedAt: null,
          problem: "The knowledge index could not be updated.",
        }),
        ago,
      ),
    ).toBe("Not indexed yet. The knowledge index could not be updated.");
    expect(
      knowledgeStateText(status({ state: "failed", indexedAt: null, problem: null }), ago),
    ).toBe("Not indexed yet.");
    expect(knowledgeStateText(status({ indexedAt: "not a date" }), ago)).toBe("Not indexed yet.");
  });

  it("qualifies a search of an index still being built, and never says nothing matches", () => {
    const hit = {
      documentId: "memory:MEMORY.md",
      title: "MEMORY.md",
      location: "MEMORY.md",
      kind: "memory",
      heading: "",
      excerpt: "Storage decision.",
      offset: 0,
      modifiedAt: "2026-10-19T09:02:00.000Z",
      score: 1,
    } as const;
    const found = (
      patch: Partial<ProjectKnowledgeSearchResult> = {},
    ): ProjectKnowledgeSearchResult => ({
      projectId: ProjectId.make("project"),
      mode: "search",
      state: "ready",
      results: [],
      truncated: false,
      ...patch,
    });
    const building = "The index is still being built, so results may be incomplete.";
    expect(knowledgeSearchText(found())).toEqual({
      note: "Nothing in this project's knowledge matches.",
      summary: "Nothing matches.",
    });
    expect(knowledgeSearchText(found({ results: [hit, hit, hit] }))).toEqual({
      note: null,
      summary: "3 passages found.",
    });
    expect(knowledgeSearchText(found({ results: [hit] })).summary).toBe("1 passage found.");
    expect(knowledgeSearchText(found({ state: "indexing" }))).toEqual({
      note: `Nothing indexed so far matches. ${building}`,
      summary: `Nothing indexed so far matches. ${building}`,
    });
    expect(knowledgeSearchText(found({ state: "indexing", results: [hit] }))).toEqual({
      note: building,
      summary: `1 passage found. ${building}`,
    });
    expect(knowledgeSearchText(found({ state: "unindexed" })).note).toBe(
      `Nothing indexed so far matches. ${building}`,
    );
    expect(knowledgeSearchText(found({ state: "failed", results: [hit] })).note).toBe(
      "The index could not be updated, so results may be incomplete.",
    );
    for (const state of ["indexing", "unindexed", "failed"] as const)
      expect(knowledgeSearchText(found({ state })).note).not.toContain("knowledge matches");
  });

  it("rounds token estimates the way people read them", () => {
    expect(knowledgeTokens(90)).toBe("about 30 tokens");
    expect(knowledgeTokens(1_000)).toBe("about 330 tokens");
    expect(knowledgeTokens(8_000)).toBe("about 2.7K tokens");
    expect(knowledgeTokens(120_000)).toBe("about 40K tokens");
    expect(knowledgeTokens(3_600_000)).toBe("about 1.2M tokens");
  });

  it("polls only while the index is not built", () => {
    expect(knowledgeShouldPoll(null)).toBe(false);
    expect(knowledgeShouldPoll(status())).toBe(false);
    expect(knowledgeShouldPoll(status({ state: "indexing" }))).toBe(true);
    expect(knowledgeShouldPoll(status({ state: "unindexed" }))).toBe(true);
    expect(knowledgeShouldPoll(status({ state: "failed" }))).toBe(false);
  });

  it("asks for an update, a connection or a permission before querying", () => {
    const ready = {
      phase: "connected",
      supported: true,
      read: "granted",
      files: "granted",
    } as const;
    expect(knowledgeAccess(ready)).toBe("ready");
    expect(knowledgeAccess({ ...ready, phase: "offline" })).toBe("offline");
    expect(knowledgeAccess({ ...ready, phase: "reconnecting" })).toBe("unknown");
    expect(knowledgeAccess({ ...ready, supported: false })).toBe("update");
    expect(knowledgeAccess({ ...ready, supported: null })).toBe("unknown");
    expect(knowledgeAccess({ ...ready, files: "denied" })).toBe("permission");
    expect(knowledgeAccess({ ...ready, read: "unknown" })).toBe("unknown");
    expect(knowledgeAccessProblem("update", "Mac mini")).toBe(
      "Update SpecWithCode on Mac mini to see this project's knowledge.",
    );
    expect(knowledgeAccessProblem("permission", "Mac mini")).toContain("read files");
    expect(knowledgeAccessProblem("ready", "Mac mini")).toBeNull();
    expect(knowledgeAccessProblem("unknown", "Mac mini")).toBeNull();
  });

  it("shows a hit's date and leaves out one the host did not send", () => {
    expect(knowledgeModifiedDate("2026-10-12T12:00:00.000Z", "en-US")).toBe("Oct 12, 2026");
    expect(knowledgeModifiedDate("", "en-US")).toBe("");
  });
});
