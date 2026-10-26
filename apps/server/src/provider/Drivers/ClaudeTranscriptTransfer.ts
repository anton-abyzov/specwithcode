import * as DateTime from "effect/DateTime";
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
import { nodePath as NodePath } from "../../nodePath.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Option from "effect/Option";
import { encodeClaudeProjectDir } from "../../usage/projectFolderSessions.ts";

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

/** Whether `sessionId` has the shape of a Claude Code session id (safe to use as a file name). */
export const isClaudeSessionId = (sessionId: string): boolean => SESSION_ID.test(sessionId);

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
    if (stat?.type === "File")
      return { projectSlug: entry, file } satisfies ClaudeTranscriptLocation;
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

const copyTree = (
  fs: FileSystem.FileSystem,
  from: string,
  to: string,
): Effect.Effect<void, PlatformError.PlatformError> =>
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

const modifiedAt = (stat: FileSystem.File.Info) =>
  Option.getOrElse(stat.mtime, () => DateTime.toDateUtc(DateTime.makeUnsafe(0))).getTime();

/**
 * Copy one transcript and its subagent folder into `targetDir` unless the copy
 * there is at least as new. The transcript is published by rename, so a partial
 * copy never replaces a good one.
 */
const copyTranscriptInto = Effect.fn("copyClaudeTranscriptInto")(function* (input: {
  readonly source: ClaudeTranscriptLocation;
  readonly targetDir: string;
  readonly sessionId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const target = NodePath.join(input.targetDir, `${input.sessionId}.jsonl`);
  const sourceStat = yield* fs.stat(input.source.file);
  const targetStat = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(null)));
  if (
    targetStat?.type === "File" &&
    modifiedAt(targetStat) >= modifiedAt(sourceStat) &&
    targetStat.size >= sourceStat.size
  ) {
    return { status: "current", file: target } satisfies ClaudeTranscriptTransferResult;
  }
  yield* fs.makeDirectory(input.targetDir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  yield* fs.copyFile(input.source.file, partial);
  yield* fs.rename(partial, target);
  const subagents = NodePath.join(NodePath.dirname(input.source.file), input.sessionId);
  const subagentStat = yield* fs.stat(subagents).pipe(Effect.catch(() => Effect.succeed(null)));
  if (subagentStat?.type === "Directory") {
    yield* copyTree(fs, subagents, NodePath.join(input.targetDir, input.sessionId));
  }
  return { status: "copied", file: target } satisfies ClaudeTranscriptTransferResult;
});

/**
 * Copy the session's transcript (and its subagent folder) from one Claude
 * home to another when the source is newer. Switching back and forth keeps
 * working: whichever home ran the session last holds the newest file and is
 * the source next time.
 */
export const transferClaudeTranscript = Effect.fn("transferClaudeTranscript")(function* (input: {
  readonly fromHome: string;
  readonly toHome: string;
  readonly sessionId: string;
}) {
  const source = yield* findClaudeTranscript({ home: input.fromHome, sessionId: input.sessionId });
  if (source === null) return { status: "missing" } satisfies ClaudeTranscriptTransferResult;
  return yield* copyTranscriptInto({
    source,
    targetDir: NodePath.join(input.toHome, "projects", source.projectSlug),
    sessionId: input.sessionId,
  });
});

/**
 * Claude Code looks a session up under the directory named after the cwd it
 * runs in. When a thread's folder changes, copy the session into the new
 * folder's directory in the same home so the next turn still resumes it. The
 * old copy stays, so nothing is lost if the folder changes back.
 */
export const relocateClaudeTranscript = Effect.fn("relocateClaudeTranscript")(function* (input: {
  readonly home: string;
  readonly sessionId: string;
  readonly toCwd: string;
}) {
  const source = yield* findClaudeTranscript({ home: input.home, sessionId: input.sessionId });
  if (source === null) return { status: "missing" } satisfies ClaudeTranscriptTransferResult;
  const projectSlug = encodeClaudeProjectDir(input.toCwd);
  if (source.projectSlug === projectSlug)
    return { status: "current", file: source.file } satisfies ClaudeTranscriptTransferResult;
  return yield* copyTranscriptInto({
    source,
    targetDir: NodePath.join(input.home, "projects", projectSlug),
    sessionId: input.sessionId,
  });
});
