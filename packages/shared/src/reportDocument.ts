/**
 * A worker report laid out as a document: a lead paragraph, short labeled
 * facts as properties, and longer labeled parts as sections. Workers write
 * `**Outcome:** … **Evidence:** … **Blockers:** none.` whatever model they
 * run on; this turns that into the parts a reader shows the way a document
 * viewer does, so every provider's report reads the same. Pure, so it can be
 * tested and shared.
 */

import { reportFrontmatter } from "./threadReport.ts";

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
 * shown as written. A leading `# Title` is dropped; the reader shows the title.
 */
export function reportDocument(text: string): ReportDocument | null {
  const frontmatter = reportFrontmatter(text);
  const all = blocks(frontmatter.body);
  if (all.length > 0 && /^\s{0,3}#\s/.test(all[0]!) && !all[0]!.includes("\n")) all.shift();

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
  const properties: ReportDocumentPart[] = frontmatter.fields
    .filter((field) => field.label !== "Title")
    .map((field) =>
      typeof field.value === "string"
        ? { label: field.label, markdown: field.value }
        : { label: field.label, markdown: "", chips: field.value },
    );
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

/** Parts that say what stops the work, whatever a model calls them. */
const BLOCKER_LABELS =
  /^(blockers?|blocked(?: on| by)?|decision needed|needs? from you|question for you)$/i;
/** A blocker part that says there is none. */
const NO_BLOCKER =
  /^(?:none|no(?:ne)?(?: blockers?)?|n\/?a|nothing|-|—|not blocked|no blockers? remain(?:ing)?)\b[\s\S]{0,80}$/i;
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
  if (plain.length === 0 || NO_BLOCKER.test(plain.replace(/[.;,]$/, ""))) return null;
  return plain.length > MAX_REPORT_BLOCKER_LENGTH
    ? `${plain.slice(0, MAX_REPORT_BLOCKER_LENGTH - 1).trimEnd()}…`
    : plain;
}
