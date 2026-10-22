/**
 * Where a native agent keeps one session's transcript on this machine. Only
 * file names are listed and stat'ed; transcript contents are never read here.
 *
 * - Claude Code: `<home>/projects/<cwd slug>/<session id>.jsonl`
 * - Codex: `<home>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`, or
 *   `<home>/archived_sessions/rollout-…-<thread id>.jsonl[.zst]` once archived
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { nodePath as NodePath } from "../nodePath.ts";
import { findClaudeTranscript } from "../provider/Drivers/ClaudeTranscriptTransfer.ts";

const SESSION_ID = /^[\w-]{1,128}$/;
/** Directory reads and stats one lookup may spend walking a Codex home. */
const MAX_CODEX_LOOKUP_OPERATIONS = 1_500;

export const findClaudeSessionFile = Effect.fn("findClaudeSessionFile")(function* (input: {
  readonly home: string;
  readonly sessionId: string;
}) {
  return (yield* findClaudeTranscript(input))?.file ?? null;
});

/**
 * Codex thread ids are UUIDv7, so the id names the day its rollout file was
 * created. The day directory is local time; check the neighbouring days, then
 * walk the rest newest-first within a bounded number of operations.
 */
export function codexSessionDayHints(
  sessionId: string,
  timeZone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): ReadonlyArray<string> {
  const hex = sessionId.replaceAll("-", "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/i.test(hex) || sessionId.charAt(14) !== "7") return [];
  const createdAt = Number.parseInt(hex, 16);
  return [0, -1, 1].map((offset) => {
    const day = DateTime.toParts(
      DateTime.makeZonedUnsafe(createdAt + offset * 86_400_000, { timeZone }),
    );
    return NodePath.join(
      String(day.year),
      String(day.month).padStart(2, "0"),
      String(day.day).padStart(2, "0"),
    );
  });
}

export const findCodexSessionFile = Effect.fn("findCodexSessionFile")(function* (input: {
  readonly home: string;
  readonly sessionId: string;
}) {
  if (!SESSION_ID.test(input.sessionId)) return null;
  const fs = yield* FileSystem.FileSystem;
  const sessions = NodePath.join(input.home, "sessions");
  const suffix = `-${input.sessionId}.jsonl`;
  let operations = MAX_CODEX_LOOKUP_OPERATIONS;
  const list = (directory: string) => {
    operations -= 1;
    return fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  };
  const inDay = Effect.fnUntraced(function* (day: string) {
    const directory = NodePath.join(sessions, day);
    const match = (yield* list(directory)).find(
      (entry) => entry.startsWith("rollout-") && entry.endsWith(suffix),
    );
    return match === undefined ? null : NodePath.join(directory, match);
  });
  // Archived threads move to one flat folder, sometimes zstd-compressed.
  const archived = NodePath.join(input.home, "archived_sessions");
  const archivedMatch = (yield* list(archived)).find(
    (entry) =>
      entry.startsWith("rollout-") && (entry.endsWith(suffix) || entry.endsWith(`${suffix}.zst`)),
  );
  const hinted = codexSessionDayHints(input.sessionId);
  for (const day of hinted) {
    const found = yield* inDay(day);
    if (found !== null) return found;
  }
  if (archivedMatch !== undefined) return NodePath.join(archived, archivedMatch);
  const newestFirst = (entries: ReadonlyArray<string>) => entries.toSorted().toReversed();
  for (const year of newestFirst(yield* list(sessions))) {
    for (const month of newestFirst(yield* list(NodePath.join(sessions, year)))) {
      for (const day of newestFirst(yield* list(NodePath.join(sessions, year, month)))) {
        if (operations <= 0) return null;
        const relative = NodePath.join(year, month, day);
        if (hinted.includes(relative)) continue;
        const found = yield* inDay(relative);
        if (found !== null) return found;
      }
    }
  }
  return null;
});
