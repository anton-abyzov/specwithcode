/**
 * SpecWeave's `auto-handoff` hooks run inside the Claude and Codex turns
 * Studio starts (they see `SPECWEAVE_STUDIO_THREAD_ID`) and leave one
 * checkpoint pointer per Studio thread. When the thread moves to another
 * provider, that note (increment, task, next step, diff) goes first in the
 * context handoff, so the receiving model starts from "what to do next".
 */
import * as NodeOS from "node:os";
import { nodePath as NodePath } from "../nodePath.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const SPECWEAVE_CHECKPOINT_PREFACE_MAX_CHARS = 6_000;

interface CheckpointReceipt {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  readonly savedAt: string;
  readonly docPath: string;
  readonly diffPath: string;
  readonly incrementId?: string;
}

/** Where the SpecWeave CLI publishes the newest checkpoint of a Studio thread. */
export function specweaveStudioCheckpointPath(threadId: string, home = NodeOS.homedir()): string {
  return NodePath.join(
    home,
    ".specweave",
    "checkpoints",
    "studio",
    `${threadId.replace(/[^\w.-]/g, "_")}.json`,
  );
}

function parseReceipt(text: string): CheckpointReceipt | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const receipt = value as Record<string, unknown>;
    return receipt.version === 1 &&
      typeof receipt.sessionId === "string" &&
      typeof receipt.cwd === "string" &&
      typeof receipt.savedAt === "string" &&
      typeof receipt.docPath === "string" &&
      typeof receipt.diffPath === "string"
      ? (value as CheckpointReceipt)
      : null;
  } catch {
    return null;
  }
}

/** Compare resolved paths; a thread's cwd may sit under the checkpoint's worktree. */
function inside(cwd: string, root: string): boolean {
  const relative = NodePath.relative(root, cwd);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/**
 * The SpecWeave checkpoint note for `threadId`, rendered as a handoff
 * preface, or null when none exists or it belongs to another worktree.
 * Reading never fails: a missing or malformed pointer is simply no preface.
 */
export const readSpecweaveCheckpointPreface = Effect.fn("readSpecweaveCheckpointPreface")(
  function* (input: {
    readonly threadId: string;
    readonly cwd: string | null;
    readonly home?: string;
    readonly maxChars?: number;
  }) {
    if (input.cwd === null) return null;
    const fs = yield* FileSystem.FileSystem;
    const quiet = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.catch(() => Effect.succeed<A | null>(null)));
    const text = yield* quiet(
      fs.readFileString(specweaveStudioCheckpointPath(input.threadId, input.home)),
    );
    const receipt = text === null ? null : parseReceipt(text);
    if (receipt === null) return null;
    const [cwd, root] = yield* Effect.all([
      quiet(fs.realPath(input.cwd)),
      quiet(fs.realPath(receipt.cwd)),
    ]);
    if (cwd === null || root === null || !inside(cwd, root)) return null;
    const note = yield* quiet(fs.readFileString(receipt.docPath));
    if (note === null || note.trim().length === 0) return null;
    const max = input.maxChars ?? SPECWEAVE_CHECKPOINT_PREFACE_MAX_CHARS;
    const body =
      note.length <= max
        ? note.trimEnd()
        : `${note.slice(0, max).trimEnd()}\n[... note truncated; read ${receipt.docPath}]`;
    return [
      `SpecWeave checkpoint from the previous session in this worktree (saved ${receipt.savedAt}${receipt.incrementId ? `, increment ${receipt.incrementId}` : ""}). Diff: ${receipt.diffPath}`,
      body,
    ].join("\n");
  },
);
