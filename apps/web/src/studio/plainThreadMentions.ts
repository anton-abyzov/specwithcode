/**
 * Coordinators are told to name threads with the `threadLink` a tool returned,
 * and sometimes write the bare title instead ("Sent to the Release Chrome
 * extension worker."). This links those plain mentions to the thread, so a
 * message that names one of the project's threads always opens it.
 *
 * Only prose is touched: code, existing links, autolinks, HTML and URLs are left
 * as written. To avoid linking ordinary words, a title matches only when
 *
 * - it is unique among the project's live threads (case-insensitively),
 * - it is not a default title such as "New thread",
 * - it has two or more words and is written in the thread's exact case, or
 * - any title, in any case, is quoted or followed by "worker", "thread",
 *   "task" or "subagent" ("the auth worker", `"Docs"`).
 */
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { formatStudioThreadHref, studioThreadLinkLabel } from "./studioThreadLinks";

type MentionThread = Pick<EnvironmentThreadShell, "id" | "title"> &
  Partial<Pick<EnvironmentThreadShell, "deletedAt">>;

const DEFAULT_TITLES = new Set(["new thread", "thread", "worker", "untitled"]);
const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 120;

/**
 * Spans that are not prose, matched in this order at each position: fenced code,
 * inline code, an inline link or image, a reference link, an autolink or HTML
 * tag, and a bare URL.
 */
const PROTECTED =
  /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)|(`+)[\s\S]*?\3|!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<[^>\n]+>|\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi;

/** A letter, digit or joiner on either side means the title is part of a longer word. */
const WORD_CHAR = /[\p{L}\p{N}_\-/@.]/u;
const CUE_AFTER = /^[*_"'”’)]*\s+(?:workers?|threads?|tasks?|subagents?)\b/iu;
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’", "«": "»" };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Candidate {
  readonly id: string;
  readonly title: string;
  readonly multiWord: boolean;
}

function candidates(threads: readonly MentionThread[], exclude: ReadonlySet<string>): Candidate[] {
  const byKey = new Map<string, MentionThread[]>();
  for (const thread of threads) {
    if (thread.deletedAt) continue;
    const title = studioThreadLinkLabel(thread.title, "");
    const key = title.toLowerCase();
    if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) continue;
    if (DEFAULT_TITLES.has(key)) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), thread]);
  }
  const result: Candidate[] = [];
  for (const matches of byKey.values()) {
    if (matches.length !== 1) continue;
    const thread = matches[0]!;
    if (exclude.has(thread.id)) continue;
    const title = studioThreadLinkLabel(thread.title, "");
    result.push({ id: thread.id, title, multiWord: /\s/.test(title) });
  }
  // Longest first, so "Release Chrome extension" wins over "Chrome extension".
  return result.sort((a, b) => b.title.length - a.title.length);
}

function cued(text: string, start: number, end: number): boolean {
  if (CUE_AFTER.test(text.slice(end))) return true;
  const open = text[start - 1];
  const close = open === undefined ? undefined : QUOTE_PAIRS[open];
  return close !== undefined && text[end] === close;
}

function linkProse(prose: string, list: readonly Candidate[], pattern: RegExp): string {
  return prose.replace(pattern, (match: string, offset: number) => {
    const before = prose[offset - 1];
    const after = prose[offset + match.length];
    if (before !== undefined && WORD_CHAR.test(before)) return match;
    // A sentence's full stop may follow the title; a dotted name may not.
    if (after !== undefined && WORD_CHAR.test(after)) {
      const next = prose[offset + match.length + 1];
      if (!(after === "." && (next === undefined || /\s/.test(next)))) return match;
    }
    const thread = list.find((c) => c.title.toLowerCase() === match.toLowerCase());
    if (!thread) return match;
    const exact = match === thread.title;
    if (!(exact && thread.multiWord) && !cued(prose, offset, offset + match.length)) return match;
    return `[${match}](${formatStudioThreadHref(thread.id)})`;
  });
}

/**
 * The threads a thread's messages may name by title: the other live threads of
 * its project. None for a thread outside a project.
 */
export function projectMentionThreads<
  Thread extends MentionThread & { readonly projectId: string | null },
>(threads: readonly Thread[], projectId: string | null, selfId: string | null): Thread[] {
  if (projectId === null) return [];
  return threads.filter(
    (thread) => thread.projectId === projectId && thread.id !== selfId && !thread.deletedAt,
  );
}

/**
 * `text` with every plain mention of one of `threads` by its title turned into a
 * `studio://thread/` link. `exclude` holds threads never to link, such as the
 * coordinator whose page is already open.
 */
export function linkPlainThreadMentions(
  text: string,
  threads: readonly MentionThread[],
  exclude: ReadonlySet<string> = new Set(),
): string {
  const list = candidates(threads, exclude);
  if (list.length === 0 || text.length === 0) return text;
  const pattern = new RegExp(list.map((c) => escapeRegExp(c.title)).join("|"), "giu");
  let result = "";
  let last = 0;
  for (const span of text.matchAll(PROTECTED)) {
    // A fence's leading newline is prose; keep it outside the protected span.
    const lead = span[1] ?? "";
    const start = span.index + lead.length;
    result +=
      linkProse(text.slice(last, start), list, pattern) +
      text.slice(start, span.index + span[0].length);
    last = span.index + span[0].length;
  }
  return result + linkProse(text.slice(last), list, pattern);
}
