/**
 * Markdown to and from the Word editor's `OfficeDocument`. Data only: HTML in
 * the Markdown is text, except `<u>` and `<br>`, and a picture is kept only as
 * a `data:` URL.
 */
import type { DocumentBlock, DocumentRun, OfficeDocument } from "@specweave-studio/contracts";

type Marks = Omit<DocumentRun, "text">;

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const SAFE_HREF_RE = /^(https?:\/\/|mailto:|#)\S+$/i;

function sameMarks(left: Marks, right: Marks): boolean {
  return (
    !!left.bold === !!right.bold &&
    !!left.italic === !!right.italic &&
    !!left.underline === !!right.underline &&
    !!left.strike === !!right.strike &&
    !!left.code === !!right.code &&
    left.href === right.href &&
    left.color === right.color
  );
}

/** Joins neighbouring runs that carry the same marks. */
export function mergeRuns(runs: ReadonlyArray<DocumentRun>): DocumentRun[] {
  const out: DocumentRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && sameMarks(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text };
    } else {
      out.push(run);
    }
  }
  return out;
}

function withMarks(text: string, marks: Marks): DocumentRun {
  const run: { -readonly [K in keyof DocumentRun]: DocumentRun[K] } = { text };
  if (marks.bold) run.bold = true;
  if (marks.italic) run.italic = true;
  if (marks.underline) run.underline = true;
  if (marks.strike) run.strike = true;
  if (marks.code) run.code = true;
  if (marks.href) run.href = marks.href;
  return run;
}

/** Inline Markdown: bold, italic, strike, code, underline (`<u>`), links, line breaks. */
export function parseInlineMarkdown(source: string, base: Marks = {}): DocumentRun[] {
  const runs: DocumentRun[] = [];
  const marks: { -readonly [K in keyof Marks]: Marks[K] } = { ...base };
  let text = "";
  const flush = () => {
    if (text.length > 0) runs.push(withMarks(text, marks));
    text = "";
  };
  let index = 0;
  const closes = (marker: string, from: number) => source.indexOf(marker, from) >= 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index]!;
    if (char === "\\" && index + 1 < source.length && /[\\`*_{}[\]()#+\-.!~|<>]/.test(source[index + 1]!)) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index) {
        flush();
        runs.push(withMarks(source.slice(index + 1, end), { ...marks, code: true }));
        index = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = /^\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link) {
        flush();
        const href = link[2]!;
        const safe = SAFE_HREF_RE.test(href) ? href : undefined;
        runs.push(...parseInlineMarkdown(link[1]!, { ...marks, ...(safe ? { href: safe } : {}) }));
        index += link[0].length;
        continue;
      }
    }
    if (/^<br\s*\/?>/i.test(rest)) {
      text += "\n";
      index += /^<br\s*\/?>/i.exec(rest)![0].length;
      continue;
    }
    if (/^<u>/i.test(rest) && !marks.underline && /<\/u>/i.test(source.slice(index + 3))) {
      flush();
      marks.underline = true;
      index += 3;
      continue;
    }
    if (/^<\/u>/i.test(rest) && marks.underline && !base.underline) {
      flush();
      delete marks.underline;
      index += 4;
      continue;
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : null;
    if (pair !== null) {
      const key = pair === "~~" ? "strike" : "bold";
      if (marks[key] && !base[key]) {
        flush();
        delete marks[key];
        index += 2;
        continue;
      }
      if (!marks[key] && closes(pair, index + 2)) {
        flush();
        marks[key] = true;
        index += 2;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const wordInside =
        char === "_" && /\w/.test(source[index - 1] ?? "") && /\w/.test(source[index + 1] ?? "");
      if (!wordInside) {
        if (marks.italic && !base.italic) {
          flush();
          delete marks.italic;
          index += 1;
          continue;
        }
        if (!marks.italic && /\S/.test(source[index + 1] ?? "") && closes(char, index + 1)) {
          flush();
          marks.italic = true;
          index += 1;
          continue;
        }
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return mergeRuns(runs);
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Block Markdown to an `OfficeDocument`. */
export function markdownToDocument(markdown: string): OfficeDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", runs: parseInlineMarkdown(paragraph.join(" ")) });
    }
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flushParagraph();
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) {
        blocks.push({ type: "paragraph", style: "code", runs: mergeRuns([{ text: lines[index]! }]) });
        index += 1;
      }
      index += 1;
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        runs: parseInlineMarkdown(heading[2]!),
      });
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }
    const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (image) {
      flushParagraph();
      const [, alt, src] = image;
      if (DATA_IMAGE_RE.test(src!)) {
        blocks.push({ type: "image", src: src!, ...(alt ? { alt } : {}) });
      } else if (alt) {
        const href = SAFE_HREF_RE.test(src!) ? src : undefined;
        blocks.push({ type: "paragraph", runs: [{ text: alt, ...(href ? { href } : {}) }] });
      }
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      while (index < lines.length && /^\s*>/.test(lines[index]!)) {
        const text = lines[index]!.replace(/^\s*>\s?/, "");
        if (text.trim().length > 0) {
          blocks.push({ type: "paragraph", style: "quote", runs: parseInlineMarkdown(text) });
        }
        index += 1;
      }
      continue;
    }
    if (/^\s*\|/.test(line) && TABLE_SEPARATOR_RE.test(lines[index + 1] ?? "")) {
      flushParagraph();
      const header = splitRow(line);
      const rows: Array<Extract<DocumentBlock, { type: "table" }>["rows"][number]> = [
        {
          cells: header.map((cell) => ({
            header: true,
            paragraphs: cell.split(/<br\s*\/?>/i).map((part) => parseInlineMarkdown(part)),
          })),
        },
      ];
      index += 2;
      while (index < lines.length && /^\s*\|/.test(lines[index]!)) {
        rows.push({
          cells: splitRow(lines[index]!).map((cell) => ({
            paragraphs: cell.split(/<br\s*\/?>/i).map((part) => parseInlineMarkdown(part)),
          })),
        });
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      flushParagraph();
      const ordered = /\d/.test(item[2]!);
      const items: Array<{ level: number; runs: DocumentRun[] }> = [];
      const baseIndent = item[1]!.replace(/\t/g, "    ").length;
      while (index < lines.length) {
        const match = LIST_RE.exec(lines[index]!);
        if (!match) {
          // A line indented under an item continues it.
          const continuation = /^\s{2,}\S/.test(lines[index]!) && items.length > 0;
          if (!continuation) break;
          const last = items[items.length - 1]!;
          last.runs = mergeRuns([...last.runs, { text: " " }, ...parseInlineMarkdown(lines[index]!.trim())]);
          index += 1;
          continue;
        }
        const indent = Math.max(0, match[1]!.replace(/\t/g, "    ").length - baseIndent);
        const level = Math.min(8, Math.floor(indent / 2));
        if (level === 0 && /\d/.test(match[2]!) !== ordered) break;
        items.push({ level, runs: parseInlineMarkdown(match[3]!) });
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return { blocks };
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]<>|~])/g, "\\$1").replace(/\n/g, "<br>");
}

/** Inline runs as Markdown. */
export function runsToMarkdown(runs: ReadonlyArray<DocumentRun>): string {
  let out = "";
  let index = 0;
  const merged = mergeRuns(runs);
  while (index < merged.length) {
    const href = merged[index]!.href;
    let end = index;
    let inner = "";
    while (end < merged.length && merged[end]!.href === href) {
      const run = merged[end]!;
      // Spaces stay outside the markers, or Markdown would not read them.
      const lead = /^\s*/.exec(run.text)![0];
      const trail = run.text.length > lead.length ? /\s*$/.exec(run.text)![0] : "";
      const core = run.text.slice(lead.length, run.text.length - trail.length);
      let body = run.code ? `\`${core.replace(/`/g, "'")}\`` : escapeInline(core);
      if (core.length > 0) {
        if (run.bold) body = `**${body}**`;
        if (run.italic) body = `*${body}*`;
        if (run.strike) body = `~~${body}~~`;
        if (run.underline) body = `<u>${body}</u>`;
      }
      inner += lead + body + trail;
      end += 1;
      if (href === undefined) break;
    }
    out += href ? `[${inner}](${href.replace(/[()\s]/g, encodeURIComponent)})` : inner;
    index = end;
  }
  return out;
}

/** An `OfficeDocument` as Markdown (GitHub flavour). */
export function documentToMarkdown(document: OfficeDocument): string {
  const parts: string[] = [];
  let code: string[] | null = null;
  const flushCode = () => {
    if (code !== null) parts.push(["```", ...code, "```"].join("\n"));
    code = null;
  };
  for (const block of document.blocks) {
    if (block.type === "paragraph" && block.style === "code") {
      code ??= [];
      code.push(block.runs.map((run) => run.text).join(""));
      continue;
    }
    flushCode();
    switch (block.type) {
      case "heading":
        parts.push(`${"#".repeat(block.level)} ${runsToMarkdown(block.runs)}`);
        break;
      case "paragraph":
        parts.push(block.style === "quote" ? `> ${runsToMarkdown(block.runs)}` : runsToMarkdown(block.runs));
        break;
      case "list": {
        const counters: number[] = [];
        parts.push(
          block.items
            .map((item) => {
              counters[item.level] = (counters[item.level] ?? 0) + 1;
              counters.length = item.level + 1;
              const marker = block.ordered ? `${counters[item.level]}.` : "-";
              return `${"  ".repeat(item.level)}${marker} ${runsToMarkdown(item.runs)}`;
            })
            .join("\n"),
        );
        break;
      }
      case "table": {
        const cols = Math.max(1, ...block.rows.map((row) => row.cells.length));
        const row = (cells: ReadonlyArray<{ paragraphs: ReadonlyArray<ReadonlyArray<DocumentRun>> }>) =>
          `| ${Array.from({ length: cols }, (_, col) =>
            (cells[col]?.paragraphs ?? []).map((runs) => runsToMarkdown(runs)).join("<br>"),
          ).join(" | ")} |`;
        const [first, ...rest] = block.rows;
        if (first === undefined) break;
        parts.push(
          [row(first.cells), `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`, ...rest.map((entry) => row(entry.cells))].join("\n"),
        );
        break;
      }
      case "image":
        parts.push(`![${(block.alt ?? "").replace(/[[\]]/g, "")}](${block.src})`);
        break;
      case "divider":
        parts.push("---");
        break;
    }
  }
  flushCode();
  return `${parts.join("\n\n")}\n`;
}

/** The document's plain text, one block per line, for agents and search. */
export function documentPlainText(document: OfficeDocument): string {
  const text = (runs: ReadonlyArray<DocumentRun>) => runs.map((run) => run.text).join("");
  const lines: string[] = [];
  for (const block of document.blocks) {
    if (block.type === "heading" || block.type === "paragraph") lines.push(text(block.runs));
    else if (block.type === "list") for (const item of block.items) lines.push(text(item.runs));
    else if (block.type === "table") {
      for (const row of block.rows) {
        lines.push(row.cells.map((cell) => cell.paragraphs.map(text).join(" ")).join("\t"));
      }
    } else if (block.type === "image" && block.alt) lines.push(block.alt);
  }
  return lines.join("\n");
}
