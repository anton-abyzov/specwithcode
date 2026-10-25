import { describe, expect, it } from "vite-plus/test";

import {
  allAddedPatch,
  allDeletedPatch,
  countPatchLines,
  formatStructuredPatch,
  headedPatch,
  isUnifiedPatch,
  readStructuredPatchHunks,
  splitPatchByFile,
  structuredEditResultPatch,
  unquoteGitPath,
} from "./structuredPatch.ts";

const editHunks = [
  {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " export {};"],
  },
];

describe("formatStructuredPatch", () => {
  it("writes git file headers and counted ranges from structured hunks", () => {
    expect(
      formatStructuredPatch({ oldPath: "src/a.ts", newPath: "src/a.ts", hunks: editHunks }),
    ).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,3 +10,4 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " export {};",
        "",
      ].join("\n"),
    );
  });

  it("marks a created file with /dev/null and a new file mode", () => {
    const patch = allAddedPatch("/repo/new.ts", "one\ntwo\n");
    expect(patch).toContain("new file mode 100644\n--- /dev/null\n+++ b//repo/new.ts\n");
    expect(patch).toContain("@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 0 });
  });

  it("marks a deleted file the same way", () => {
    const patch = allDeletedPatch("gone.ts", "x\n");
    expect(patch).toContain(
      "deleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    );
  });
});

describe("readStructuredPatchHunks", () => {
  it("accepts well-formed hunks and rejects anything else", () => {
    expect(readStructuredPatchHunks(editHunks)).toEqual(editHunks);
    expect(readStructuredPatchHunks([])).toEqual([]);
    expect(readStructuredPatchHunks([{ ...editHunks[0], lines: [1] }])).toBeNull();
    expect(readStructuredPatchHunks([{ ...editHunks[0], oldStart: -1 }])).toBeNull();
    expect(readStructuredPatchHunks("nope")).toBeNull();
  });
});

describe("headedPatch", () => {
  it("synthesizes headers and counted ranges for a bare Codex update hunk", () => {
    const { patch, synthesizedLineNumbers } = headedPatch({
      operation: "update",
      path: "src/a.ts",
      body: "@@\n context\n-old\n+new\n+added\n@@\n-gone\n",
    });
    expect(synthesizedLineNumbers).toBe(true);
    expect(patch).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " context",
        "-old",
        "+new",
        "+added",
        "@@ -3 +3,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 2 });
  });

  it("keeps ranges the provider did report and only adds headers", () => {
    const { patch, synthesizedLineNumbers } = headedPatch({
      operation: "update",
      path: "a.ts",
      body: "@@ -5,1 +5,1 @@\n-a\n+b\n",
    });
    expect(synthesizedLineNumbers).toBe(false);
    expect(patch).toBe(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5,1 +5,1 @@\n-a\n+b\n",
    );
  });

  it("writes a rename header for a move", () => {
    const { patch } = headedPatch({
      operation: "move",
      path: "new/a.ts",
      oldPath: "old/a.ts",
      body: "@@\n-a\n+b\n",
    });
    expect(patch).toContain(
      "diff --git a/old/a.ts b/new/a.ts\nrename from old/a.ts\nrename to new/a.ts\n--- a/old/a.ts\n+++ b/new/a.ts\n",
    );
    expect(splitPatchByFile(patch)).toEqual([
      { oldPath: "old/a.ts", newPath: "new/a.ts", text: patch },
    ]);
  });

  it("turns an add holding plain content into an all-added patch", () => {
    const { patch, synthesizedLineNumbers } = headedPatch({
      operation: "add",
      path: "a.txt",
      body: "hello\nworld",
    });
    expect(synthesizedLineNumbers).toBe(false);
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 0 });
    expect(splitPatchByFile(patch)[0]).toMatchObject({ oldPath: null, newPath: "a.txt" });
  });

  it("turns a delete holding the old content into an all-deleted patch", () => {
    const { patch } = headedPatch({ operation: "delete", path: "a.txt", body: "bye\n" });
    expect(countPatchLines(patch)).toEqual({ additions: 0, deletions: 1 });
    expect(splitPatchByFile(patch)[0]).toMatchObject({ oldPath: "a.txt", newPath: null });
  });

  it("leaves a patch that already has file headers untouched", () => {
    const body = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    expect(headedPatch({ operation: "update", path: "x", body })).toEqual({
      patch: body,
      synthesizedLineNumbers: false,
    });
  });
});

describe("countPatchLines", () => {
  it("excludes file headers, even when a content line looks like one", () => {
    const patch = [
      "diff --git a/a b/a",
      "--- a/a",
      "+++ b/a",
      "@@ -1,2 +1,2 @@",
      "--- not a header",
      "+++ not a header either",
      " same",
      "diff --git a/b b/b",
      "--- a/b",
      "+++ b/b",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "\\ No newline at end of file",
    ].join("\n");
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 2 });
  });

  it("returns null for text with no hunk, such as a provider error", () => {
    expect(countPatchLines("Error: file not found")).toBeNull();
    expect(isUnifiedPatch("Error: file not found")).toBe(false);
  });

  it("counts a patch larger than the 32 KiB wire bound exactly", () => {
    const lines = Array.from({ length: 5_000 }, (_, index) => `+line ${index} ${"x".repeat(10)}`);
    const patch = `--- a/big\n+++ b/big\n@@ -0,0 +1,5000 @@\n${lines.join("\n")}\n`;
    expect(patch.length).toBeGreaterThan(32 * 1024);
    expect(countPatchLines(patch)).toEqual({ additions: 5_000, deletions: 0 });
  });
});

describe("splitPatchByFile", () => {
  it("splits at diff --git lines and joins back to the same text", () => {
    const first = "diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+b\n";
    const second =
      "diff --git a/dir with space/two b/dir with space/two\n--- a/dir with space/two\n+++ b/dir with space/two\n@@ -1 +1 @@\n-a\n+b\n";
    const binary = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    const blocks = splitPatchByFile(first + second + binary);
    expect(blocks.map((block) => block.newPath)).toEqual(["one", "dir with space/two", "img.png"]);
    expect(blocks.map((block) => block.text).join("")).toBe(first + second + binary);
  });

  it("reads paths git quoted", () => {
    expect(unquoteGitPath('"a/\\303\\251t\\303\\251.txt"')).toBe("a/été.txt");
    expect(unquoteGitPath('"a/tab\\there"')).toBe("a/tab\there");
    expect(unquoteGitPath('"a/😀 \\"q\\""')).toBe('a/😀 "q"');
    expect(unquoteGitPath("plain")).toBe("plain");
    const patch =
      'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\n--- "a/\\303\\251.txt"\n+++ "b/\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n';
    expect(splitPatchByFile(patch)[0]).toMatchObject({ oldPath: "é.txt", newPath: "é.txt" });
  });
});

describe("structuredEditResultPatch", () => {
  const editResult = {
    filePath: "/repo/src/a.ts",
    oldString: "const b = 2;",
    newString: "const b = 3;\nconst c = 4;",
    originalFile: "…",
    structuredPatch: editHunks,
    userModified: false,
    replaceAll: false,
    gitDiff: { patch: "@@ -1 +1 @@\n-whole\n+file\n" },
  };

  it("renders Claude's hunks first, with real line numbers and no note", () => {
    const result = structuredEditResultPatch(editResult);
    expect(result?.diffNote).toBeUndefined();
    expect(result?.patch).toContain("@@ -10,3 +10,4 @@");
    expect(result?.patch).toContain("--- a//repo/src/a.ts\n+++ b//repo/src/a.ts\n");
  });

  it("reads the JSON text older items stored as diffStr", () => {
    expect(structuredEditResultPatch(JSON.stringify(editResult))).toEqual(
      structuredEditResultPatch(editResult),
    );
    expect(structuredEditResultPatch("The file was updated.")).toBeNull();
    expect(structuredEditResultPatch("{not json")).toBeNull();
  });

  it("falls back to the git patch, labelled, when there are no hunks", () => {
    const result = structuredEditResultPatch({ ...editResult, structuredPatch: [] });
    expect(result).toMatchObject({ diffNote: "git_patch" });
    expect(result?.patch).toContain("--- a//repo/src/a.ts\n+++ b//repo/src/a.ts\n@@ -1 +1 @@\n");
  });

  it("renders a Write create as all added lines", () => {
    const result = structuredEditResultPatch({
      type: "create",
      filePath: "/repo/new.ts",
      content: "a\nb\n",
      structuredPatch: [],
      originalFile: null,
    });
    expect(result?.patch).toContain("--- /dev/null");
    expect(countPatchLines(result!.patch!)).toEqual({ additions: 2, deletions: 0 });
  });

  it("says a Write update without hunks has no diff from the provider", () => {
    expect(
      structuredEditResultPatch({
        type: "update",
        filePath: "/repo/a.ts",
        content: "x",
        structuredPatch: [],
        originalFile: null,
      }),
    ).toEqual({ diffNote: "overwrite_without_diff" });
  });

  it("uses the fallback path when the result names none", () => {
    expect(
      structuredEditResultPatch({ structuredPatch: editHunks }, "/repo/src/a.ts")?.patch,
    ).toContain("diff --git a//repo/src/a.ts b//repo/src/a.ts");
    expect(structuredEditResultPatch({ structuredPatch: editHunks })).toBeNull();
  });
});
