/**
 * A thread's report: the long final message a delegated worker writes. Studio
 * shows it as an artifact card instead of a wall of text, and saves it as a
 * markdown file beside the SpecWeave increment it belongs to. These helpers
 * are pure so the browser and the server agree on titles, keys and paths.
 */

/** Past this many words a reply reads as a document rather than an answer. */
export const MAX_REPORT_WORDS = 600;
/** A reply with this many headed sections is a document, not an answer. */
export const MAX_REPORT_HEADINGS = 3;
/** Non-blank lines well past one screen, for long code or lists with few words. */
export const MAX_REPORT_LINES = 80;
/** A report the person asked for still needs some substance to be worth a card. */
export const MIN_REQUESTED_REPORT_WORDS = 150;
/** The largest report Studio saves, well above any real agent report. */
export const MAX_SAVED_REPORT_BYTES = 512 * 1024;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const REPORT_REQUEST = /\b(?:reports?|write[- ]?ups?|documents?|audits?|memos?|white ?papers?)\b/i;

/** Whether the person's message asks for a report or a document. */
export function asksForReport(request: string | null | undefined): boolean {
  return request ? REPORT_REQUEST.test(request) : false;
}

/**
 * Whether a reply reads as a document, shown as a report card, rather than an
 * answer, shown inline. Short and direct answers stay in the chat; a reply
 * becomes a report when it has several headed sections, runs past about 600
 * words or well past a screen, or answers a request for a report.
 */
export function shouldCollapseReport(
  text: string,
  options: { readonly requested?: boolean } = {},
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const words = reportWordCount(trimmed);
  if (words > MAX_REPORT_WORDS) return true;
  if (options.requested === true && words >= MIN_REQUESTED_REPORT_WORDS) return true;

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

export interface ReportFrontmatterField {
  /** Humanized: `review_cycle` reads "Review cycle". */
  readonly label: string;
  /** A list value (`- a` lines or `[a, b]`) is shown as chips. */
  readonly value: string | ReadonlyArray<string>;
}

/** A leading `---` block, whatever it holds. */
export const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const FRONTMATTER_KEY = /^([A-Za-z][\w -]{0,40}):(?:[ \t]+(.*))?$/;

function unquoted(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * A flat YAML frontmatter block, the subset document viewers show as a
 * property table: `key: value` lines and lists as `- a` lines or `[a, b]`.
 * Anything richer (nesting, block text) is left in the body as written.
 */
export function reportFrontmatter(text: string): {
  readonly fields: ReadonlyArray<ReportFrontmatterField>;
  readonly body: string;
} {
  const source = normalized(text);
  const match = FRONTMATTER.exec(source);
  if (!match) return { fields: [], body: source };
  const fields: Array<{ key: string; value: string | string[] }> = [];
  for (const line of match[1]!.split("\n")) {
    if (line.trim().length === 0) continue;
    const item = /^\s+-\s+(.+)$|^-\s+(.+)$/.exec(line);
    const last = fields.at(-1);
    if (item && last && Array.isArray(last.value)) {
      last.value.push(unquoted(item[1] ?? item[2]!));
      continue;
    }
    const key = FRONTMATTER_KEY.exec(line);
    if (!key) return { fields: [], body: source };
    const raw = (key[2] ?? "").trim();
    if (/^[|>]/.test(raw)) return { fields: [], body: source };
    const value =
      raw.length === 0
        ? []
        : /^\[.*\]$/.test(raw)
          ? raw
              .slice(1, -1)
              .split(",")
              .map(unquoted)
              .filter((entry) => entry.length > 0)
          : unquoted(raw);
    fields.push({ key: key[1]!.trim(), value });
  }
  return {
    fields: fields
      .filter((field) => field.value.length > 0)
      .map((field) => {
        const words = field.key.replace(/[-_]+/g, " ").trim();
        return { label: words.charAt(0).toUpperCase() + words.slice(1), value: field.value };
      }),
    body: source.slice(match[0].length).trim(),
  };
}

const LABELED_LINE = /^\s*(?:\*\*[^*\n]{1,40}?:?\*\*:?|[A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}:)\s/;

/** The report's own first heading, or its first line, or the fallback. */
export function reportTitle(text: string, fallback: string): string {
  const { fields, body } = reportFrontmatter(text);
  const named = fields.find((field) => field.label === "Title")?.value;
  if (typeof named === "string" && named.trim().length > 0) {
    const title = plain(named);
    return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
  }
  // Lines inside code fences are code: a `# comment` there is not a heading.
  let inFence = false;
  const lines = body.split("\n").filter((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return false;
    }
    return !inFence;
  });
  const heading = lines.find((line) => HEADING.test(line));
  const first = lines.find((line) => line.trim().length > 0);
  // A report that opens with a list or a table has no line that names it.
  // Nor does one that opens with a labeled part such as `**Outcome:** …`.
  const unnamed =
    !heading &&
    first !== undefined &&
    (/^\s*(?:[-*+]|\d+[.)]|\|)\s/.test(first) || LABELED_LINE.test(first));
  const raw = heading ? heading.replace(/^\s{0,3}#{1,6}\s+/, "") : unnamed ? "" : (first ?? "");
  const title = plain(raw).replace(/[:.]$/, "");
  if (title.length === 0 || (!heading && title.length > 90)) return fallback.trim() || "Report";
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

/** The opening paragraph as plain text, for the card. */
export function reportSummary(text: string, maxLength = 280): string {
  const paragraphs = reportFrontmatter(text).body.split(/\n\s*\n/);
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

/** An increment folder name such as `0973-budget-vs-actuals`, `0657E-followup`, or past 9999 `10001-export`. */
const INCREMENT_SLUG = /(?<![\w-])(\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/gi;
/** A bare increment number, like "0973" in "Review cycle 2 of 0973", or "10001". */
const INCREMENT_NUMBER = /(?<![\w.-])(\d{4,})(?![\w.-])/g;
const INCREMENT_PATH = /\.specweave\/increments\/(\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*)/gi;

export interface ReportIncrementCandidate {
  /** A full folder name, or a number of 4 or more digits that must match one folder. */
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

/**
 * Prose whose words run together ("Owneranswersresolvedidentity; no
 * renewedquestion"). Models under length pressure sometimes write a report
 * this way, and no reader can follow it. Nothing in the app strips spaces, and
 * the spaces cannot be put back reliably, so the text is refused where an agent
 * sends it and the agent rewrites it.
 *
 * A paragraph counts as run together when its words average at least
 * `LETTERS_PER_WORD` letters and it holds at least `RUNS` lowercase runs of
 * `RUN_LETTERS` or more. English averages about 5 letters a word and dense
 * German under 9; the run test keeps identifiers (`ProjectCoordinatorService`)
 * and file paths, whose lowercase runs are short, from counting. Code, URLs,
 * link targets and absolute paths are left out before measuring.
 */

const RUN_LETTERS = 16;
const RUNS = 2;
const LETTERS_PER_WORD = 10;
/** Too little prose to judge. */
const MIN_LETTERS = 40;
const MAX_SAMPLES = 3;
const SAMPLE_CHARACTERS = 40;

const FENCED = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
const CODE_SPAN = /`[^`\n]*`/g;
const LINK_TARGET = /\]\([^)\s]*\)/g;
/** `[label]: target`, a Markdown reference definition. */
const LINK_DEFINITION = /^ {0,3}\[[^\n]+\]:[ \t][^\n]*$/gm;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** `/Users/…`, `~/…`, `./…`, `../…`, `C:\…` and `#anchor`. */
const ABSOLUTE_PATH = /^(?:(?:~|\.{1,2}|[A-Za-z]:)?[/\\]|#)/;
const LETTER = /[A-Za-z]/g;
const RUN = new RegExp(`[a-z]{${RUN_LETTERS},}`, "g");

export interface SquashedText {
  /** Run-together words as written, at most three, to quote back to the sender. */
  readonly samples: readonly string[];
}

/** Null when the text reads as separate words. */
export function findSquashedText(text: string): SquashedText | null {
  const prose = text
    .replace(FENCED, "\n\n")
    .replace(LINK_DEFINITION, " ")
    .replace(CODE_SPAN, " ")
    .replace(LINK_TARGET, "]")
    .replace(URL, " ");
  const samples: string[] = [];
  for (const paragraph of prose.split(/\n[ \t]*\n/)) {
    const words = paragraph
      .split(/\s+/)
      .filter((word) => word !== "" && !ABSOLUTE_PATH.test(word) && /[A-Za-z]/.test(word));
    let letters = 0;
    let runs = 0;
    const glued: string[] = [];
    for (const word of words) {
      letters += word.match(LETTER)?.length ?? 0;
      // Words use many letters; hex (0xfffffffcn) and filler (aaaaaaaa) use few.
      const found = word.match(RUN)?.filter((run) => new Set(run).size >= 6).length ?? 0;
      runs += found;
      if (found > 0) glued.push(word);
    }
    if (letters < MIN_LETTERS || runs < RUNS) continue;
    if (letters / words.length < LETTERS_PER_WORD) continue;
    for (const word of glued) {
      if (samples.length === MAX_SAMPLES) break;
      const bare = word.replace(/^\W+|\W+$/g, "");
      samples.push(bare.length > SAMPLE_CHARACTERS ? `${bare.slice(0, SAMPLE_CHARACTERS)}…` : bare);
    }
  }
  return samples.length === 0 ? null : { samples };
}

/** What an agent is told when its message is refused, so it can rewrite it. */
export function squashedTextMessage(found: SquashedText): string {
  const quoted = found.samples.map((sample) => `"${sample}"`).join(", ");
  return `Not sent: the message runs words together without spaces (${quoted}). Rewrite it as plain sentences with a space between every word and full words instead of abbreviations, then send it again. If the detail does not fit a few sentences, put it in a file and send its path.`;
}
