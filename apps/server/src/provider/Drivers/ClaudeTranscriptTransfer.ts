/**
 * Two Claude instances with different config homes (two subscriptions) keep
 * their native sessions apart: Claude Code stores each one under
 * `<home>/projects/<cwd slug>/<session id>.jsonl`, plus a `<session id>/`
 * folder for subagent transcripts. Copying those into the other home lets the
 * thread resume its native session there with the whole conversation, instead
 * of starting a new session from a budgeted summary. The provider's prompt
 * cache is per account, so the first turn after the move is uncached either
 * way; nothing else is lost.
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export const CLAUDE_HOME_CONTINUATION_KEY_PREFIX = "claude:home:";

/** The config home a Claude instance's continuation key names, or null for other drivers. */
export function claudeHomeFromContinuationKey(continuationKey: string): string | null {
  if (!continuationKey.startsWith(CLAUDE_HOME_CONTINUATION_KEY_PREFIX)) return null;
  const home = continuationKey.slice(CLAUDE_HOME_CONTINUATION_KEY_PREFIX.length);
  return home.length > 0 && NodePath.isAbsolute(home) ? home : null;
}

/** Both keys name a Claude home, and they differ. */
export function claudeHomesDiffer(fromKey: string, toKey: string): boolean {
  const from = claudeHomeFromContinuationKey(fromKey);
  const to = claudeHomeFromContinuationKey(toKey);
  return from !== null && to !== null && NodePath.resolve(from) !== NodePath.resolve(to);
}

const SESSION_ID = /^[\w-]{1,128}$/;

export interface ClaudeTranscriptLocation {
  /** The project directory name Claude Code derived from the session's cwd. */
  readonly projectSlug: string;
  readonly file: string;
}

/**
 * Where `sessionId` lives under `home`. The slug is read from disk, not
 * recomputed, so the copy lands in the directory Claude Code will look in.
 */
export const findClaudeTranscript = Effect.fn("findClaudeTranscript")(function* (input: {
  readonly home: string;
  readonly sessionId: string;
}) {
  if (!SESSION_ID.test(input.sessionId)) return null;
  const fs = yield* FileSystem.FileSystem;
  const projects = NodePath.join(input.home, "projects");
  const entries = yield* fs
    .readDirectory(projects)
    .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));
  for (const entry of entries) {
    const file = NodePath.join(projects, entry, `${input.sessionId}.jsonl`);
    const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat?.type === "File") return { projectSlug: entry, file } satisfies ClaudeTranscriptLocation;
  }
  return null;
});

export type ClaudeTranscriptTransferResult =
  /** The target home now holds the newer transcript. */
  | { readonly status: "copied"; readonly file: string }
  /** The target already had a transcript at least as new; nothing was written. */
  | { readonly status: "current"; readonly file: string }
  /** The source home has no transcript for this session. */
  | { readonly status: "missing" };

const copyTree = (fs: FileSystem.FileSystem, from: string, to: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(to, { recursive: true });
    for (const entry of yield* fs.readDirectory(from)) {
      const source = NodePath.join(from, entry);
      const target = NodePath.join(to, entry);
      const stat = yield* fs.stat(source);
      if (stat.type === "Directory") yield* copyTree(fs, source, target);
      else if (stat.type === "File") yield* fs.copyFile(source, target);
    }
  });

/**
 * Copy the session's transcript (and its subagent folder) from one Claude
 * home to another when the source is newer. Switching back and forth keeps
 * working: whichever home ran the session last holds the newest file and is
 * the source next time. The transcript is published by rename, so a partial
 * copy never replaces a good one.
 */
export const transferClaudeTranscript = Effect.fn("transferClaudeTranscript")(function* (input: {
  readonly fromHome: string;
  readonly toHome: string;
  readonly sessionId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* findClaudeTranscript({ home: input.fromHome, sessionId: input.sessionId });
  if (source === null) return { status: "missing" } satisfies ClaudeTranscriptTransferResult;
  const targetDir = NodePath.join(input.toHome, "projects", source.projectSlug);
  const target = NodePath.join(targetDir, `${input.sessionId}.jsonl`);
  const sourceStat = yield* fs.stat(source.file);
  const targetStat = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(null)));
  const modifiedAt = (stat: FileSystem.File.Info) =>
    Option.getOrElse(stat.mtime, () => new Date(0)).getTime();
  if (
    targetStat?.type === "File" &&
    modifiedAt(targetStat) >= modifiedAt(sourceStat) &&
    targetStat.size >= sourceStat.size
  ) {
    return { status: "current", file: target } satisfies ClaudeTranscriptTransferResult;
  }
  yield* fs.makeDirectory(targetDir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  yield* fs.copyFile(source.file, partial);
  yield* fs.rename(partial, target);
  const subagents = NodePath.join(NodePath.dirname(source.file), input.sessionId);
  const subagentStat = yield* fs.stat(subagents).pipe(Effect.catch(() => Effect.succeed(null)));
  if (subagentStat?.type === "Directory") {
    yield* copyTree(fs, subagents, NodePath.join(targetDir, input.sessionId));
  }
  return { status: "copied", file: target } satisfies ClaudeTranscriptTransferResult;
});
