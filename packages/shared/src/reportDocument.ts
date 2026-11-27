/**
 * A worker report laid out as a document: a lead paragraph, short labeled
 * facts as properties, and longer labeled parts as sections. Workers write
 * `**Outcome:** … **Evidence:** … **Blockers:** none.` whatever model they
 * run on; this turns that into the parts a reader shows the way a document
 * viewer does, so every provider's report reads the same. Pure, so it can be
 * tested and shared.
 */

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { formatStudioThreadLink, studioThreadLinkLabel } from "./studioThreadLinks.ts";
import {
  FRONTMATTER,
  type ReportFrontmatterField,
  reportBodyAfterTitle,
  reportFrontmatter,
} from "./threadReport.ts";

export interface ReportDocumentPart {
  readonly label: string;
  /** Values shown as chips, from a frontmatter list; `markdown` is empty then. */
  readonly chips?: ReadonlyArray<string>;
  /** Markdown. */
  readonly markdown: string;
}

export interface ReportDocument {
  /** The opening paragraph(s), markdown; null when the report opens with a section. */
  readonly lead: string | null;
  /** Labeled parts short enough to read as a fact, such as `Blockers: none`. */
  readonly properties: ReadonlyArray<ReportDocumentPart>;
  readonly sections: ReadonlyArray<ReportDocumentPart>;
}

/** A labeled part this short, on one line, is a fact rather than a section. */
export const MAX_REPORT_PROPERTY_LENGTH = 60;
/** A one-paragraph section with this many sentences reads better as a list. */
export const MIN_REPORT_LIST_SENTENCES = 3;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
// `**Outcome:** text`, `**Outcome**: text`, or `Outcome: text` with a short capitalized label.
const BOLD_LABEL = /^\s*\*\*([^*\n]{1,40}?)\s*:?\s*\*\*\s*:?\s*([\s\S]*)$/;
const PLAIN_LABEL = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}):[ \t]+(\S[\s\S]*)$/;
/** Leads that name the whole result: they open the document rather than a section. */
const LEAD_LABELS = /^(outcome|result|summary|tl;?dr|answer|status|verdict)$/i;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|no|fig)|\b[A-Z])\.$/i;

function normalized(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** Paragraph blocks; a fenced code block stays whole with the blank lines inside it. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trim().length === 0) {
      if (current.length > 0) out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) out.push(current.join("\n"));
  return out;
}

function labelOf(block: string): { label: string; body: string; heading?: true } | null {
  if (FENCE.test(block)) return null;
  const heading = HEADING.exec(block.split("\n")[0]!);
  if (heading) {
    return {
      label: heading[2]!.replace(/[*_`]/g, "").replace(/:$/, "").trim(),
      body: block.split("\n").slice(1).join("\n").trim(),
      heading: true,
    };
  }
  const bold = BOLD_LABEL.exec(block);
  if (bold) return { label: bold[1]!.replace(/:$/, "").trim(), body: bold[2]!.trim() };
  const plain = PLAIN_LABEL.exec(block);
  if (plain && !/^https?$/i.test(plain[1]!)) return { label: plain[1]!, body: plain[2]!.trim() };
  return null;
}

/**
 * Splits prose into sentences at `. ` and `; ` outside code spans and links,
 * where the next sentence starts with a capital, a digit, a code span or a quote.
 */
export function reportSentences(paragraph: string): string[] {
  const text = paragraph.replace(/\s*\n\s*/g, " ").trim();
  const out: string[] = [];
  let start = 0;
  let code = false;
  let bracket = 0;
  let paren = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "`") code = !code;
    if (code) continue;
    if (char === "[") bracket += 1;
    else if (char === "]") bracket = Math.max(0, bracket - 1);
    else if (char === "(") paren += 1;
    else if (char === ")") paren = Math.max(0, paren - 1);
    if ((char !== "." && char !== ";") || bracket > 0 || paren > 0) continue;
    if (text[index + 1] !== " " || !/[A-Z0-9`"“'*]/.test(text[index + 2] ?? "")) continue;
    const sentence = text.slice(start, index + 1).trim();
    if (char === "." && ABBREVIATION.test(sentence)) continue;
    out.push(sentence);
    start = index + 2;
  }
  const rest = text.slice(start).trim();
  if (rest.length > 0) out.push(rest);
  return out;
}

function plainLength(markdown: string): number {
  return markdown.replace(/[*_`]/g, "").trim().length;
}

function asList(body: string): string {
  if (body.includes("\n") || FENCE.test(body) || LIST_LINE.test(body)) return body;
  const sentences = reportSentences(body);
  if (sentences.length < MIN_REPORT_LIST_SENTENCES) return body;
  return sentences.map((sentence) => `- ${capitalized(sentence.replace(/;$/, ""))}`).join("\n");
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function asValue(body: string): string {
  return capitalized(body.replace(/\.$/, ""));
}

/**
 * The report as a document, or null when it has no labeled parts and is best
 * shown as written. The words the title came from are dropped; the reader
 * shows the title.
 */
export function reportDocument(text: string): ReportDocument | null {
  const frontmatter = reportFrontmatter(text);
  const body = reportBodyAfterTitle(text);
  const all = blocks(body);
  const frontmatterTitle = frontmatter.fields.find((field) => field.label === "Title")?.value;
  // Without a frontmatter title, a marked-up opening H1 supplies the displayed title.
  const opening = all[0];
  if (
    (typeof frontmatterTitle !== "string" || frontmatterTitle.trim() === "") &&
    body === frontmatter.body &&
    opening !== undefined &&
    /^\s{0,3}#\s/.test(opening) &&
    !opening.includes("\n")
  ) {
    all.shift();
  }

  const leadBlocks: string[] = [];
  const parts: Array<{ label: string; body: string[]; heading: boolean }> = [];
  for (const block of all) {
    const labeled = labelOf(block);
    if (labeled) {
      parts.push({
        label: labeled.label,
        body: labeled.body ? [labeled.body] : [],
        heading: labeled.heading === true,
      });
    } else if (parts.length === 0) {
      leadBlocks.push(block);
    } else {
      parts.at(-1)!.body.push(block);
    }
  }
  if (parts.length === 0 && frontmatter.fields.length === 0) return null;

  let lead = leadBlocks.length > 0 ? leadBlocks.join("\n\n") : null;
  const properties: ReportDocumentPart[] = [
    ...frontmatterProperties(frontmatter.fields.filter((field) => field.label !== "Title")),
  ];
  const sections: ReportDocumentPart[] = [];
  parts.forEach((part, index) => {
    const body = part.body.join("\n\n").trim();
    if (lead === null && index === 0 && LEAD_LABELS.test(part.label) && body.length > 0) {
      lead = body;
      return;
    }
    if (!part.heading && !body.includes("\n") && plainLength(body) <= MAX_REPORT_PROPERTY_LENGTH) {
      if (body.length > 0) properties.push({ label: part.label, markdown: asValue(body) });
      return;
    }
    sections.push({ label: part.label, markdown: asList(body) });
  });
  return { lead, properties, sections };
}

/** How dates read in a property table; the reader's locale and zone by default. */
export interface FrontmatterPropertyOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/**
 * A thread ID this app mints: `thread:…` (delegated and fleet threads) or one
 * holding a UUID (`project-coordinator-<uuid>`, a bare UUID). A slug, a URL or
 * a forum thread's name stays text.
 */
const THREAD_ID_TOKEN = /^[^\s[\]()<>`*/]{6,}$/;
const THREAD_ID_SHAPE = /^thread:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * An ISO date or timestamp as a person reads it, `November 24, 2026` or
 * `November 24, 2026 at 4:16 PM`; anything else comes back unchanged. A bare
 * date names a day, so no zone moves it.
 */
export function readableFrontmatterDate(
  value: string,
  options: FrontmatterPropertyOptions = {},
): string {
  const trimmed = value.trim();
  const isTimestamp = ISO_TIMESTAMP.test(trimmed);
  if (!ISO_DATE.test(trimmed) && !isTimestamp) return value;
  // Engines can roll an impossible day (February 31) forward; such a value stays as written.
  const day = trimmed.slice(0, 10);
  const midnight = DateTime.make(`${day}T00:00:00.000Z`);
  if (Option.isNone(midnight)) return value;
  const parts = DateTime.toPartsUtc(midnight.value);
  if (parts.month !== Number(day.slice(5, 7)) || parts.day !== Number(day.slice(8, 10))) {
    return value;
  }
  try {
    if (!isTimestamp) {
      return new Intl.DateTimeFormat(options.locale, { dateStyle: "long", timeZone: "UTC" }).format(
        DateTime.toEpochMillis(midnight.value),
      );
    }
    const millis = Date.parse(trimmed.replace(" ", "T"));
    if (Number.isNaN(millis)) return value;
    return new Intl.DateTimeFormat(options.locale, {
      dateStyle: "long",
      timeStyle: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(millis);
  } catch {
    return value;
  }
}

/**
 * Frontmatter fields as the property table shows them: lists as chips, ISO
 * dates as words, and a thread ID with its title as one link to the thread
 * (`thread` + `threadTitle` from a saved report) instead of a raw ID row and
 * a title row.
 */
export function frontmatterProperties(
  fields: ReadonlyArray<ReportFrontmatterField>,
  options: FrontmatterPropertyOptions = {},
): ReportDocumentPart[] {
  const threadField = fields.find(
    (field) =>
      field.label === "Thread" &&
      typeof field.value === "string" &&
      THREAD_ID_TOKEN.test(field.value.trim()) &&
      THREAD_ID_SHAPE.test(field.value.trim()),
  );
  const titleField = threadField
    ? fields.find((field) => field.label === "Thread title" && typeof field.value === "string")
    : undefined;
  const parts: ReportDocumentPart[] = [];
  for (const field of fields) {
    if (field === titleField) continue;
    if (field === threadField) {
      const title = typeof titleField?.value === "string" ? titleField.value : "";
      parts.push({
        label: field.label,
        markdown: formatStudioThreadLink(
          (field.value as string).trim(),
          studioThreadLinkLabel(title, "Open thread"),
        ),
      });
      continue;
    }
    parts.push(
      typeof field.value === "string"
        ? { label: field.label, markdown: readableFrontmatterDate(field.value, options) }
        : { label: field.label, markdown: "", chips: field.value },
    );
  }
  return parts;
}

/** A Markdown file laid out as a page: its title, its facts, then its body as written. */
export interface MarkdownDocument {
  /** Plain text; null when the file names itself nowhere. */
  readonly title: string | null;
  readonly properties: ReadonlyArray<ReportDocumentPart>;
  /** Markdown, everything after the frontmatter and the opening `# title`. */
  readonly body: string;
}

// CommonMark: a closing `#` run counts only after a space, so `# Learn C#` keeps its `#`.
const OPENING_TITLE = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*(?:\n|$)/;
/** Longer than any heading; a line past this is not one a reader takes as a title. */
const OPENING_LINE_CHARS = 400;
const YAML_KEY_LINE = /^[A-Za-z_][\w -]{0,40}:(?:[ \t]|$)/;

/**
 * A heading's text as written, minus the Markdown around it: emphasis that
 * wraps words, code spans, links and escapes. `my_module`, `Vec<T>` and
 * `C#` stay as they are.
 */
export function headingText(markdown: string): string {
  // Past a heading's length the markup scan costs more than it is worth, and nothing is cut.
  if (markdown.length > OPENING_LINE_CHARS) return markdown.replace(/\s+/g, " ").trim();
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[\s(])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,:;!?])/g, "$1$3")
    .replace(/(^|[\s(])([*_])(?=\S)(.+?)(?<=\S)\2(?=$|[\s).,:;!?])/g, "$1$3")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drops the blank lines a body opens with, never the indentation of its first line. */
function withoutLeadingBlankLines(markdown: string): string {
  return markdown.replace(/^(?:[ \t]*\n)+/, "");
}

/** The heading on a body's first line; one past any heading's length is not worth scanning. */
function openingHeading(body: string): RegExpExecArray | null {
  const end = body.indexOf("\n");
  const firstLine = end === -1 ? body : body.slice(0, end);
  return firstLine.length > OPENING_LINE_CHARS ? null : OPENING_TITLE.exec(firstLine);
}

/** The heading a file opens with, on its first line and outside any fence. */
export function markdownOpeningTitle(markdown: string): string | null {
  const firstLine = /^\uFEFF?(?:[ \t]*\r?\n)*([^\r\n]*)/.exec(markdown)?.[1] ?? "";
  const opening = openingHeading(firstLine);
  return opening ? headingText(opening[1]!) : null;
}

/**
 * A Markdown file as a document viewer shows it: flat frontmatter becomes the
 * property table under the title instead of a paragraph of `key: value` text,
 * and the opening `# heading` becomes the title instead of a second one. The
 * body is never restructured. Frontmatter too rich for a table stays visible,
 * as a YAML block, rather than turning into a rule and a heading. A file with
 * no frontmatter, or one that opens with a `---` rule around prose, comes
 * back as written.
 */
export function markdownDocument(text: string): MarkdownDocument {
  const source = text.replace(/\r\n?/g, "\n").trim();
  const match = FRONTMATTER.exec(source);
  // Frontmatter starts with a key on the line after `---`; anything else is a rule.
  if (!match || !YAML_KEY_LINE.test(match[1]!.split("\n")[0]!)) {
    return { title: null, properties: [], body: text };
  }
  const rest = withoutLeadingBlankLines(source.slice(match[0].length));
  const { fields } = reportFrontmatter(source);
  if (fields.length === 0) {
    return { title: null, properties: [], body: `~~~~yaml\n${match[1]!}\n~~~~\n\n${rest}` };
  }
  let body = rest;
  const named = fields.find((field) => field.label === "Title")?.value;
  let title =
    typeof named === "string" && headingText(named).length > 0 ? headingText(named) : null;
  const opening = openingHeading(body);
  if (opening) {
    const heading = headingText(opening[1]!);
    if (title === null || heading.toLowerCase() === title.toLowerCase()) {
      title = heading;
      body = withoutLeadingBlankLines(body.slice(opening[0].length));
    }
  }
  const properties = frontmatterProperties(
    fields.filter((field) => field.label !== "Title" || typeof field.value !== "string"),
  );
  return { title, properties, body };
}

/** Parts that say what stops the work, whatever a model calls them. */
const BLOCKER_LABELS =
  /^(blockers?|blocked(?: on| by)?|decision needed|needs? from you|question for you)$/i;
/**
 * An opening clause that says nothing blocks the work. The verdict comes from
 * the opening clause alone: `none. I also fixed X` is a report with notes, not
 * a blocker, however long the notes run, and `No access to staging` is one.
 */
const NO_BLOCKER =
  /^(?:none|no|nothing|n\/?a|-+|—|not blocked|unblocked|no(?: (?:open|outstanding|known|remaining|current|new))? blockers?(?: (?:remain(?:ing)?|left|here|now|found))?|none (?:remain(?:ing)?|left|so far|now|here)|nothing (?:blocking|blocks)(?: (?:it|this|the work))?)$/i;
/** Where a blocker part's opening clause ends. */
const CLAUSE_END = /[.;:,!?()\u2014\u2013]|\s-\s/;
/** Long enough to read in a tooltip and a row, short enough to never be a wall. */
export const MAX_REPORT_BLOCKER_LENGTH = 400;

/**
 * What a report says stops the work, as plain text, or null when it reports
 * no blocker. A thread whose last report names one is blocked on the reader.
 */
export function reportBlocker(text: string): string | null {
  const frontmatter = reportFrontmatter(text);
  const field = frontmatter.fields.find((entry) => BLOCKER_LABELS.test(entry.label));
  let value: string | null =
    field === undefined
      ? null
      : typeof field.value === "string"
        ? field.value
        : field.value.join("; ");
  if (value === null) {
    // The part runs from its label to the next labeled part, as in the reader.
    let part: string[] | null = null;
    for (const block of blocks(frontmatter.body)) {
      const labeled = labelOf(block);
      if (labeled) {
        if (part !== null) break;
        if (BLOCKER_LABELS.test(labeled.label)) part = labeled.body ? [labeled.body] : [];
      } else if (part !== null) {
        part.push(block);
      }
    }
    if (part !== null) value = part.join(" ");
  }
  if (value === null) return null;
  const plain = value
    .replace(/[*_`]/g, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0 || NO_BLOCKER.test(openingClause(plain))) return null;
  return plain.length > MAX_REPORT_BLOCKER_LENGTH
    ? `${plain.slice(0, MAX_REPORT_BLOCKER_LENGTH - 1).trimEnd()}…`
    : plain;
}

/** The words before a blocker part's first clause break; a lone dash stays itself. */
function openingClause(plain: string): string {
  if (/^[-—]+$/.test(plain)) return plain;
  const end = CLAUSE_END.exec(plain);
  return (end === null ? plain : plain.slice(0, end.index)).trim();
}

/** Explicit dependency waits are informational, never a request for the reader. */
export type ReportWaitReason =
  | "Waiting for CI"
  | "Waiting for review"
  | "Waiting for PR merge"
  | "Waiting for subagents";

export function reportWaitReason(text: string): ReportWaitReason | null {
  // Only the final prose paragraph describes the current disposition. Do not
  // infer a wait from an old quote, a code sample or an evidence inventory.
  const prose =
    text
      .replace(/```[\s\S]*?```/g, "")
      .split(/\n\s*\n/)
      .at(-1)
      ?.trim() ?? "";
  if (
    /^>|\?|\b(?:you|your|anton|approve|approval|permission|decision|sign[ -]?in|license|credential)\b/i.test(
      prose,
    )
  )
    return null;
  const plain = prose.replace(/[*_`]/g, "");
  const wait =
    /(?:^|[.!]\s+)(?:(?:blockers?|blocked)\s*:\s*)?(?:now\s+)?(?:waiting (?:on|for)|wait for|blocked (?:on|by))\s+(.+)/i.exec(
      plain,
    );
  if (!wait) return null;
  const dependency = wait[1]!;
  if (/^(?:the\s+)?(?:CI|checks?|builds?|tests?)(?:\b|$)/i.test(dependency))
    return "Waiting for CI";
  if (/^(?:a\s+|the\s+|fresh\s+)*(?:review|reviewer)(?:\b|$)/i.test(dependency))
    return "Waiting for review";
  if (
    /^(?:(?:the|a)\s+)?(?:PRs?|pull requests?)(?:\b|$)|^(?:the\s+)?merge\b|^#[0-9]+.*\bmerg/i.test(
      dependency,
    )
  )
    return "Waiting for PR merge";
  if (/^(?:the\s+|my\s+)?(?:subagents?|agents?|workers?)(?:\b|$)/i.test(dependency))
    return "Waiting for subagents";
  return null;
}
