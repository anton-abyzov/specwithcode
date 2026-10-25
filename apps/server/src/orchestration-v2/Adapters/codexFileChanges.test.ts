import { OrchestrationV2TurnItemJson } from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import { countPatchLines, splitPatchByFile } from "@specweave-studio/shared/structuredPatch";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { legacyCodexFileChanges, projectCodexFileChanges } from "./codexFileChanges.ts";

type NativeChange = CodexSchema.V2ItemCompletedNotification__FileUpdateChange;
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);

const nativeChanges: ReadonlyArray<NativeChange> = [
  { path: "/workspace/case.mjs", kind: { type: "update" }, diff: "@@\n-old case\n+new case\n" },
  { path: "/workspace/extra.mjs", kind: { type: "add" }, diff: "+extra file\n" },
  { path: "/workspace/removed.mjs", kind: { type: "delete" }, diff: "-removed file\n" },
  {
    path: "/workspace/before.mjs",
    kind: { type: "update", move_path: "/workspace/after.mjs" },
    diff: "@@\n-before\n+after\n",
  },
];

describe("Codex file change projection", () => {
  it.each([null, "/workspace", undefined])(
    "preserves approval grantRoot %s on the wire without inventing null",
    (grantRoot) => {
      const approval = {
        id: "approval-files",
        type: "approval_request",
        threadId: "thread-files",
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: "2026-10-13T00:00:00.000Z",
        requestId: "request-files",
        requestKind: "file-change",
        prompt: "Only case.mjs is changed",
        ...(grantRoot === undefined ? {} : { grantRoot }),
      };
      const decoded = decodeTurnItemJson(approval);
      expect(encodeTurnItemJson(decoded)).toStrictEqual(approval);
    },
  );

  it("heads an add's plain content as an all-added new file", () => {
    const projected = projectCodexFileChanges([
      { path: "/workspace/extra.mjs", kind: { type: "add" }, diff: "export const a = 1;\nb();\n" },
    ]);
    expect(projected?.changes).toEqual([
      {
        operation: "add",
        path: "/workspace/extra.mjs",
        diffStr: [
          "diff --git a//workspace/extra.mjs b//workspace/extra.mjs",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b//workspace/extra.mjs",
          "@@ -0,0 +1,2 @@",
          "+export const a = 1;",
          "+b();",
          "",
        ].join("\n"),
      },
    ]);
    expect(countPatchLines(projected!.changes![0]!.diffStr!)).toEqual({
      additions: 2,
      deletions: 0,
    });
  });

  it("heads a delete's plain content as an all-deleted file", () => {
    const projected = projectCodexFileChanges([
      { path: "/workspace/removed.mjs", kind: { type: "delete" }, diff: "gone();\n" },
    ]);
    expect(projected?.changes).toEqual([
      {
        operation: "delete",
        path: "/workspace/removed.mjs",
        diffStr: [
          "diff --git a//workspace/removed.mjs b//workspace/removed.mjs",
          "deleted file mode 100644",
          "--- a//workspace/removed.mjs",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-gone();",
          "",
        ].join("\n"),
      },
    ]);
  });

  it("heads an update and flags ranges it had to count", () => {
    const projected = projectCodexFileChanges([nativeChanges[0]!]);
    expect(projected).toEqual({
      fileName: "/workspace/case.mjs",
      diffStr: projected!.changes![0]!.diffStr,
      changes: [
        {
          operation: "update",
          path: "/workspace/case.mjs",
          diffStr: [
            "diff --git a//workspace/case.mjs b//workspace/case.mjs",
            "--- a//workspace/case.mjs",
            "+++ b//workspace/case.mjs",
            "@@ -1 +1 @@",
            "-old case",
            "+new case",
            "",
          ].join("\n"),
          diffNote: "line_numbers_synthesized",
        },
      ],
    });
    // Ranges the provider reported are kept as they are, with no note.
    const ranged = "@@ -10,2 +10,2 @@\n context\n-old\n+new\n";
    expect(
      projectCodexFileChanges([
        { path: "/workspace/case.mjs", kind: { type: "update" }, diff: ranged },
      ])?.changes,
    ).toEqual([
      {
        operation: "update",
        path: "/workspace/case.mjs",
        diffStr: `diff --git a//workspace/case.mjs b//workspace/case.mjs\n--- a//workspace/case.mjs\n+++ b//workspace/case.mjs\n${ranged}`,
      },
    ]);
  });

  it("heads a move with rename lines from the old path to the destination", () => {
    const projected = projectCodexFileChanges([nativeChanges[3]!]);
    expect(projected?.fileName).toBe("/workspace/after.mjs");
    expect(projected?.changes).toEqual([
      {
        operation: "move",
        oldPath: "/workspace/before.mjs",
        path: "/workspace/after.mjs",
        diffStr: [
          "diff --git a//workspace/before.mjs b//workspace/after.mjs",
          "rename from /workspace/before.mjs",
          "rename to /workspace/after.mjs",
          "--- a//workspace/before.mjs",
          "+++ b//workspace/after.mjs",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "",
        ].join("\n"),
        diffNote: "line_numbers_synthesized",
      },
    ]);
  });

  it("keeps every operation and joins the headed patches into one splittable item patch", () => {
    const projected = projectCodexFileChanges(nativeChanges);
    expect(
      projected?.changes?.map(({ operation, path, oldPath }) => ({ operation, path, oldPath })),
    ).toEqual([
      { operation: "update", path: "/workspace/case.mjs", oldPath: undefined },
      { operation: "add", path: "/workspace/extra.mjs", oldPath: undefined },
      { operation: "delete", path: "/workspace/removed.mjs", oldPath: undefined },
      { operation: "move", path: "/workspace/after.mjs", oldPath: "/workspace/before.mjs" },
    ]);
    expect(projected?.diffStr).toBe(projected?.changes?.map((change) => change.diffStr).join(""));
    expect(splitPatchByFile(projected!.diffStr!)).toEqual(
      projected!.changes!.map((change) => ({
        oldPath: change.operation === "add" ? null : (change.oldPath ?? change.path),
        newPath: change.operation === "delete" ? null : change.path,
        text: change.diffStr,
      })),
    );
  });

  it("does not truncate the structured list when an approval has more than 20 files", () => {
    const changes = Array.from({ length: 25 }, (_, index) => ({
      path: `/workspace/file-${index}.mjs`,
      kind: { type: "add" as const },
      diff: `file ${index}\n`,
    }));
    expect(projectCodexFileChanges(changes)?.changes).toHaveLength(25);
    expect(projectCodexFileChanges(changes)?.changes?.at(-1)).toMatchObject({
      operation: "add",
      path: "/workspace/file-24.mjs",
    });
    expect(projectCodexFileChanges(changes)?.changes?.at(-1)?.diffStr).toContain("+file 24\n");
  });

  it("rejects an unknown operation instead of returning a misleading partial list", () => {
    const unknown = {
      path: "/workspace/hidden.mjs",
      kind: { type: "copy" },
      diff: "+hidden\n",
    } as unknown as NativeChange;
    expect(() => projectCodexFileChanges([nativeChanges[0]!, unknown])).toThrow(
      "Unsupported Codex file change operation",
    );
    expect(() =>
      legacyCodexFileChanges({
        "/workspace/case.mjs": { type: "add", content: "case" },
        "/workspace/hidden.mjs": { type: "copy", content: "hidden" },
      } as unknown as CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"]),
    ).toThrow("Unsupported Codex file change operation");
  });

  it("rejects missing scope and heads an empty add without inventing lines", () => {
    expect(projectCodexFileChanges([])).toBeNull();
    expect(() => projectCodexFileChanges([{ ...nativeChanges[0]!, path: " " }])).toThrow(
      "valid path",
    );
    expect(() =>
      projectCodexFileChanges([{ ...nativeChanges[0]!, kind: { type: "update", move_path: " " } }]),
    ).toThrow("destination path");
    const empty = projectCodexFileChanges([
      { path: "/workspace/empty.mjs", kind: { type: "add" }, diff: "" },
    ])?.changes?.[0]?.diffStr;
    expect(empty).toBe(
      "diff --git a//workspace/empty.mjs b//workspace/empty.mjs\nnew file mode 100644\n--- /dev/null\n+++ b//workspace/empty.mjs\n",
    );
    expect(countPatchLines(empty!)).toBeNull();
  });

  it("converts every legacy approval entry without losing deleted content or moved paths", () => {
    expect(
      projectCodexFileChanges(
        legacyCodexFileChanges({
          "/workspace/new.mjs": { type: "add", content: "new\n" },
          "/workspace/gone.mjs": { type: "delete", content: "gone\n" },
          "/workspace/old.mjs": {
            type: "update",
            unified_diff: "@@\n-old\n+new\n",
            move_path: "/workspace/moved.mjs",
          },
        }),
      )?.changes,
    ).toEqual([
      {
        operation: "add",
        path: "/workspace/new.mjs",
        diffStr: expect.stringMatching(/\n--- \/dev\/null\n.*@@ -0,0 \+1 @@\n\+new\n$/s),
      },
      {
        operation: "delete",
        path: "/workspace/gone.mjs",
        diffStr: expect.stringMatching(/\n\+\+\+ \/dev\/null\n@@ -1 \+0,0 @@\n-gone\n$/),
      },
      {
        operation: "move",
        oldPath: "/workspace/old.mjs",
        path: "/workspace/moved.mjs",
        diffStr: expect.stringMatching(
          /\nrename to \/workspace\/moved\.mjs\n.*@@ -1 \+1 @@\n-old\n\+new\n$/s,
        ),
        diffNote: "line_numbers_synthesized",
      },
    ]);
  });

  it("round-trips exact per-file patches on the wire while accepting existing patchless details", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
    const encode = Schema.encodeSync(OrchestrationV2TurnItemJson);
    const base = {
      id: "item-files",
      type: "file_change",
      threadId: "thread-files",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-10-13T00:00:00.000Z",
      ...projectCodexFileChanges(nativeChanges),
    };
    expect(encode(decode(base))).toEqual(base);
    const legacy = { ...base, changes: [{ operation: "update", path: "/workspace/case.mjs" }] };
    expect(encode(decode(legacy))).toEqual(legacy);
  });
});
