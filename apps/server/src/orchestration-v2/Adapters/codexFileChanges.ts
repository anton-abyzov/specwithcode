import type { OrchestrationV2TurnItem } from "@specweave-studio/contracts";
import type * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import { headedPatch } from "@specweave-studio/shared/structuredPatch";

type NativeChange = CodexSchema.V2ItemCompletedNotification__FileUpdateChange;
type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

/** Joins per-file patches so every file block starts on its own line. */
function joinFilePatches(patches: ReadonlyArray<string>): string {
  let joined = "";
  for (const patch of patches) {
    if (joined !== "" && !joined.endsWith("\n")) joined += "\n";
    joined += patch;
  }
  return joined;
}

/**
 * Keep every native operation and its patch; never infer a scope from prose.
 * Codex sends bare hunks (and plain content for adds and deletes), so each
 * patch gets file headers, and counted ranges where its `@@` lines have none.
 */
export function projectCodexFileChanges(
  nativeChanges: ReadonlyArray<NativeChange>,
): Pick<FileChangeItem, "fileName" | "diffStr" | "changes"> | null {
  if (nativeChanges.length === 0) return null;
  const changes = nativeChanges.map((change) => {
    if (!change.path.trim() || typeof change.diff !== "string") {
      throw new TypeError("Codex file change has no valid path or diff.");
    }
    const kind = change.kind.type;
    if (kind !== "add" && kind !== "delete" && kind !== "update") {
      throw new TypeError("Unsupported Codex file change operation.");
    }
    const movePath = change.kind.type === "update" ? change.kind.move_path : undefined;
    if (movePath != null && !movePath.trim()) {
      throw new TypeError("Codex file change has an invalid destination path.");
    }
    const operation = movePath == null ? kind : "move";
    const path = movePath ?? change.path;
    const headed = headedPatch({
      operation,
      path,
      ...(movePath == null ? {} : { oldPath: change.path }),
      body: change.diff,
    });
    return {
      operation,
      path,
      ...(movePath == null ? {} : { oldPath: change.path }),
      diffStr: headed.patch,
      ...(headed.synthesizedLineNumbers ? { diffNote: "line_numbers_synthesized" } : {}),
    };
  });
  return {
    fileName: changes[0]!.path,
    diffStr: joinFilePatches(changes.map((change) => change.diffStr)),
    changes,
  };
}

/** Older approvals include the patch themselves, before any item notification. */
export function legacyCodexFileChanges(
  fileChanges: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"],
): ReadonlyArray<NativeChange> {
  return Object.entries(fileChanges).map(([path, change]) => {
    switch (change.type) {
      case "add":
      case "delete":
        return { path, kind: { type: change.type }, diff: change.content };
      case "update":
        return {
          path,
          kind: {
            type: "update",
            ...(change.move_path === undefined ? {} : { move_path: change.move_path }),
          },
          diff: change.unified_diff,
        };
      default:
        throw new TypeError("Unsupported Codex file change operation.");
    }
  });
}

/** Describe approval scope even when Codex omits or blanks the optional reason. */
export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
  readonly fileChanges?: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"];
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map(([path, change]) => {
      const movePath = change.type === "update" ? change.move_path : undefined;
      return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}
