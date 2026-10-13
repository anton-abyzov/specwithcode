import { OrchestrationV2TurnItemJson } from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
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

  it("preserves every operation, rename endpoint and exact per-file patch", () => {
    const projected = projectCodexFileChanges(nativeChanges);
    expect(projected).toEqual({
      fileName: "/workspace/case.mjs",
      diffStr: nativeChanges.map((change) => change.diff).join("\n"),
      changes: [
        { operation: "update", path: "/workspace/case.mjs", diffStr: nativeChanges[0]!.diff },
        { operation: "add", path: "/workspace/extra.mjs", diffStr: nativeChanges[1]!.diff },
        { operation: "delete", path: "/workspace/removed.mjs", diffStr: nativeChanges[2]!.diff },
        {
          operation: "move",
          oldPath: "/workspace/before.mjs",
          path: "/workspace/after.mjs",
          diffStr: nativeChanges[3]!.diff,
        },
      ],
    });
    expect(projectCodexFileChanges([nativeChanges[3]!])?.fileName).toBe("/workspace/after.mjs");
    expect(projectCodexFileChanges([nativeChanges[0]!])?.diffStr).toBe(nativeChanges[0]!.diff);
  });

  it("does not truncate the structured list when an approval has more than 20 files", () => {
    const changes = Array.from({ length: 25 }, (_, index) => ({
      path: `/workspace/file-${index}.mjs`,
      kind: { type: "add" as const },
      diff: `+file ${index}\n`,
    }));
    expect(projectCodexFileChanges(changes)?.changes).toHaveLength(25);
    expect(projectCodexFileChanges(changes)?.changes?.at(-1)).toEqual({
      operation: "add",
      path: "/workspace/file-24.mjs",
      diffStr: "+file 24\n",
    });
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

  it("rejects missing scope and preserves empty patches without inventing a file", () => {
    expect(projectCodexFileChanges([])).toBeNull();
    expect(() => projectCodexFileChanges([{ ...nativeChanges[0]!, path: " " }])).toThrow(
      "valid path",
    );
    expect(() =>
      projectCodexFileChanges([{ ...nativeChanges[0]!, kind: { type: "update", move_path: " " } }]),
    ).toThrow("destination path");
    expect(
      projectCodexFileChanges([{ path: "/workspace/empty.mjs", kind: { type: "add" }, diff: "" }])
        ?.changes?.[0]?.diffStr,
    ).toBe("");
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
      { operation: "add", path: "/workspace/new.mjs", diffStr: "new\n" },
      { operation: "delete", path: "/workspace/gone.mjs", diffStr: "gone\n" },
      {
        operation: "move",
        oldPath: "/workspace/old.mjs",
        path: "/workspace/moved.mjs",
        diffStr: "@@\n-old\n+new\n",
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
