/**
 * A thread's report: the long final message a delegated worker writes. Studio
 * shows it as an artifact card instead of a wall of text, and saves it as a
 * markdown file beside the SpecWeave increment it belongs to. These helpers
 * are pure so the browser and the server agree on titles, keys and paths.
 */

/** More non-blank lines than this reads as a wall, not a summary. */
export const MAX_REPORT_LINES = 10;
/** Roughly two dense paragraphs. */
export const MAX_REPORT_LENGTH = 1_200;
/** A report with this many headings is a document, not an answer. */
export const MAX_REPORT_HEADINGS = 3;
/** The largest report Studio saves, well above any real agent report. */
export const MAX_SAVED_REPORT_BYTES = 512 * 1024;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** Whether a message is long enough to read as a document rather than an answer. */
export function shouldCollapseReport(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_REPORT_LENGTH) return true;

  let lines = 0;
  let headings = 0;
  let inFence = false;
  for (const line of trimmed.split("\n")) {
    if (line.trim().length === 0) continue;
    lines += 1;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Any table renders as a tall block of cells.
    if (TABLE_DIVIDER.test(line)) return true;
    if (HEADING.test(line)) headings += 1;
  }
  return lines > MAX_REPORT_LINES || headings >= MAX_REPORT_HEADINGS;
}

function normalized(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** FNV-1a over UTF-16 code units, as 8 hex digits. Stable across runtimes. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Identifies one thread, so its saved reports can be found by file name. */
export function reportThreadKey(threadId: string): string {
  return fnv1a(`thread:${threadId}`).slice(0, 6);
}

/** Identifies one report of one thread; the same text always gets the same key. */
export function reportKey(threadId: string, text: string): string {
  return `${reportThreadKey(threadId)}-${fnv1a(normalized(text)).slice(0, 6)}`;
}

const MARKDOWN_NOISE = /[*_`~]|!?\[([^\]]*)\]\([^)]*\)|<[^>]+>/g;

function plain(line: string): string {
  return line
    .replace(MARKDOWN_NOISE, (match, label: string | undefined) => label ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The report's own first heading, or its first line, or the fallback. */
export function reportTitle(text: string, fallback: string): string {
  // Lines inside code fences are code: a `# comment` there is not a heading.
  let inFence = false;
  const lines = normalized(text)
    .split("\n")
    .filter((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return false;
      }
      return !inFence;
    });
  const heading = lines.find((line) => HEADING.test(line));
  const first = lines.find((line) => line.trim().length > 0);
  // A report that opens with a list or a table has no line that names it.
  const unnamed = !heading && first !== undefined && /^\s*(?:[-*+]|\d+[.)]|\|)\s/.test(first);
  const raw = heading ? heading.replace(/^\s{0,3}#{1,6}\s+/, "") : unnamed ? "" : (first ?? "");
  const title = plain(raw).replace(/[:.]$/, "");
  if (title.length === 0 || (!heading && title.length > 90)) return fallback.trim() || "Report";
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

/** The opening paragraph as plain text, for the card. */
export function reportSummary(text: string, maxLength = 280): string {
  const paragraphs = normalized(text).split(/\n\s*\n/);
  let inFence = false;
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n");
    if (lines.some((line) => FENCE.test(line))) {
      inFence = lines.filter((line) => FENCE.test(line)).length % 2 === 1 ? !inFence : inFence;
      continue;
    }
    if (inFence) continue;
    const body = lines.filter(
      (line) => !HEADING.test(line) && !TABLE_DIVIDER.test(line) && !/^\s*\|/.test(line),
    );
    const summary = plain(
      body.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")).join(" "),
    );
    if (summary.length === 0) continue;
    return summary.length > maxLength ? `${summary.slice(0, maxLength - 1).trimEnd()}…` : summary;
  }
  return "";
}

export function reportWordCount(text: string): number {
  return normalized(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** An increment folder name such as `0973-budget-vs-actuals`. */
const INCREMENT_SLUG = /(?<![\w-])(\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/gi;
/** A bare increment number, like "0973" in "Review cycle 2 of 0973". */
const INCREMENT_NUMBER = /(?<![\w.-])(\d{4})(?![\w.-])/g;
const INCREMENT_PATH = /\.specweave\/increments\/(\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)/gi;

export interface ReportIncrementCandidate {
  /** A full folder name, or a 4-digit number that must match one folder. */
  readonly kind: "folder" | "number";
  readonly value: string;
  /**
   * Named in the report body. Such a folder must exist as written (or be
   * extended by it); its leading number alone never picks a folder, since
   * text like "1500-line limit" is shaped like an increment.
   */
  readonly fromText?: true;
}

/**
 * Where a report may belong, most specific source first: the thread title,
 * then its branch, then increment folders the report itself names. Bare
 * numbers come only from the title and branch; in a report they are as
 * likely to be counts or years. The caller checks each against disk.
 */
export function reportIncrementCandidates(input: {
  readonly title: string | null;
  readonly branch: string | null;
  readonly text: string;
}): ReadonlyArray<ReportIncrementCandidate> {
  const found: ReportIncrementCandidate[] = [];
  const add = (kind: ReportIncrementCandidate["kind"], value: string, fromText = false) => {
    if (!found.some((candidate) => candidate.kind === kind && candidate.value === value)) {
      found.push(fromText ? { kind, value, fromText } : { kind, value });
    }
  };
  for (const source of [input.title ?? "", input.branch ?? ""]) {
    for (const match of source.matchAll(INCREMENT_SLUG)) add("folder", match[1]!.toLowerCase());
    for (const match of source.matchAll(INCREMENT_NUMBER)) add("number", match[1]!);
  }
  const text = normalized(input.text);
  for (const match of text.matchAll(INCREMENT_PATH)) add("folder", match[1]!.toLowerCase(), true);
  for (const match of text.matchAll(INCREMENT_SLUG)) add("folder", match[1]!.toLowerCase(), true);
  return found;
}

function slug(value: string): string {
  const words = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return words.slice(0, 48).replace(/-+$/g, "") || "report";
}

/** `2026-10-12-review-cycle-2-of-0973-1a2b3c-4d5e6f.md`: dated, readable, keyed. */
export function reportFileName(input: {
  readonly savedAt: string;
  readonly title: string;
  readonly threadId: string;
  readonly text: string;
}): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(input.savedAt)?.[0] ?? "report";
  return `${day}-${slug(input.title)}-${reportKey(input.threadId, input.text)}.md`;
}

/** The key a saved report's file name ends with, or null for any other file. */
export function reportKeyFromFileName(fileName: string): string | null {
  return /-([0-9a-f]{6}-[0-9a-f]{6})\.md$/.exec(fileName)?.[1] ?? null;
}
