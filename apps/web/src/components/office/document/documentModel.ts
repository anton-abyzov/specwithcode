/**
 * The Word editor's Tiptap content to and from `OfficeDocument`, the model the
 * server reads from and writes to `.docx`.
 *
 * Rules where the two differ:
 * - A list in the model is flat with levels; in the editor it nests. A nested
 *   list takes its top list's kind (Word numbers a list one way), and a level
 *   that jumps more than one step comes in one step deeper than its parent.
 * - Quote and code paragraphs gather into one blockquote and one code block;
 *   a code block's lines go back as one code paragraph each, without marks.
 * - A hard break is a "\n" inside a run's text; "left" alignment is no alignment.
 * - Runs longer than the model's limit are split.
 */
import {
  DOCUMENT_LIMITS,
  type DocumentAlign,
  type DocumentBlock,
  type DocumentRun,
  type OfficeDocument,
} from "@specweave-studio/contracts";
import type { JSONContent } from "@tiptap/core";

type Mark = NonNullable<JSONContent["marks"]>[number];
type MutableRun = { -readonly [K in keyof DocumentRun]: DocumentRun[K] };

const ALIGNS: ReadonlySet<string> = new Set(["center", "right", "justify"]);

function alignOf(attrs: Record<string, unknown> | undefined): DocumentAlign | undefined {
  const value = attrs?.textAlign;
  return typeof value === "string" && ALIGNS.has(value) ? (value as DocumentAlign) : undefined;
}

function alignAttrs(align: DocumentAlign | undefined): { textAlign: string | null } {
  return { textAlign: align === undefined || align === "left" ? null : align };
}

function bookmarkOf(attrs: Record<string, unknown> | undefined): string | undefined {
  const value = attrs?.bookmark;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── Model to editor ──────────────────────────────────────────────────────────

function marksOf(run: DocumentRun): Mark[] {
  const marks: Mark[] = [];
  if (run.bold) marks.push({ type: "bold" });
  if (run.italic) marks.push({ type: "italic" });
  if (run.underline) marks.push({ type: "underline" });
  if (run.strike) marks.push({ type: "strike" });
  if (run.code) marks.push({ type: "code" });
  if (run.color) marks.push({ type: "textColor", attrs: { color: run.color } });
  if (run.href) marks.push({ type: "link", attrs: { href: run.href } });
  return marks;
}

export function runsToInline(runs: ReadonlyArray<DocumentRun>): JSONContent[] {
  const out: JSONContent[] = [];
  for (const run of runs) {
    const marks = marksOf(run);
    const parts = run.text.replace(/\r\n?/g, "\n").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) out.push({ type: "hardBreak" });
      if (part.length > 0) out.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
    });
  }
  return out;
}

function paragraphNode(
  runs: ReadonlyArray<DocumentRun>,
  attrs: Record<string, unknown> = {},
): JSONContent {
  const content = runsToInline(runs);
  return { type: "paragraph", attrs, ...(content.length ? { content } : {}) };
}

function listToNodes(block: Extract<DocumentBlock, { type: "list" }>): JSONContent {
  const type = block.ordered ? "orderedList" : "bulletList";
  const root: JSONContent = { type, content: [] };
  // The open list at each depth, and its last item.
  const stack: Array<{ list: JSONContent; item: JSONContent | null }> = [{ list: root, item: null }];
  for (const entry of block.items) {
    let level = Math.min(entry.level, stack.length - 1 + (stack[stack.length - 1]!.item ? 1 : 0));
    level = Math.max(0, level);
    while (stack.length - 1 > level) stack.pop();
    if (stack.length - 1 < level) {
      const parent = stack[stack.length - 1]!;
      const nested: JSONContent = { type, content: [] };
      parent.item!.content!.push(nested);
      stack.push({ list: nested, item: null });
    }
    const item: JSONContent = { type: "listItem", content: [paragraphNode(entry.runs)] };
    const top = stack[stack.length - 1]!;
    top.list.content!.push(item);
    top.item = item;
  }
  return root;
}

export function documentToContent(document: OfficeDocument): JSONContent {
  const content: JSONContent[] = [];
  const blocks = document.blocks;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    switch (block.type) {
      case "paragraph": {
        if (block.style === "quote") {
          const quoted: JSONContent[] = [];
          while (index < blocks.length) {
            const next = blocks[index]!;
            if (next.type !== "paragraph" || next.style !== "quote") break;
            quoted.push(
              paragraphNode(next.runs, { ...alignAttrs(next.align), bookmark: next.id ?? null }),
            );
            index += 1;
          }
          index -= 1;
          content.push({ type: "blockquote", content: quoted });
        } else if (block.style === "code") {
          const lines: string[] = [];
          while (index < blocks.length) {
            const next = blocks[index]!;
            if (next.type !== "paragraph" || next.style !== "code") break;
            lines.push(next.runs.map((run) => run.text).join(""));
            index += 1;
          }
          index -= 1;
          const text = lines.join("\n");
          content.push({ type: "codeBlock", ...(text ? { content: [{ type: "text", text }] } : {}) });
        } else {
          content.push(
            paragraphNode(block.runs, { ...alignAttrs(block.align), bookmark: block.id ?? null }),
          );
        }
        break;
      }
      case "heading": {
        const inline = runsToInline(block.runs);
        content.push({
          type: "heading",
          attrs: { level: block.level, ...alignAttrs(block.align), bookmark: block.id ?? null },
          ...(inline.length ? { content: inline } : {}),
        });
        break;
      }
      case "list":
        content.push(listToNodes(block));
        break;
      case "table": {
        const cols = Math.max(1, ...block.rows.map((row) => row.cells.length));
        content.push({
          type: "table",
          content: block.rows.map((row) => ({
            type: "tableRow",
            content: Array.from({ length: cols }, (_, col) => {
              const cell = row.cells[col];
              const paragraphs = cell?.paragraphs.length ? cell.paragraphs : [[]];
              return {
                type: cell?.header ? "tableHeader" : "tableCell",
                content: paragraphs.map((runs) => paragraphNode(runs)),
              };
            }),
          })),
        });
        break;
      }
      case "image":
        content.push({
          type: "image",
          attrs: {
            src: block.src,
            alt: block.alt ?? null,
            width: block.width ?? null,
            height: block.height ?? null,
            asset: block.asset ?? null,
            align: block.align ?? null,
          },
        });
        break;
      case "divider":
        content.push({ type: "horizontalRule" });
        break;
    }
  }
  if (content.length === 0) content.push({ type: "paragraph" });
  return { type: "doc", content };
}

// ── Editor to model ─────────────────────────────────────────────────────────

function runFromText(node: JSONContent): DocumentRun {
  const run: MutableRun = { text: node.text ?? "" };
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") run.bold = true;
    else if (mark.type === "italic") run.italic = true;
    else if (mark.type === "underline") run.underline = true;
    else if (mark.type === "strike") run.strike = true;
    else if (mark.type === "code") run.code = true;
    else if (mark.type === "link" && typeof mark.attrs?.href === "string" && mark.attrs.href) {
      run.href = mark.attrs.href.slice(0, DOCUMENT_LIMITS.hrefChars);
    } else if (
      mark.type === "textColor" &&
      typeof mark.attrs?.color === "string" &&
      /^#[0-9A-Fa-f]{6}$/.test(mark.attrs.color)
    ) {
      run.color = mark.attrs.color;
    }
  }
  return run;
}

function sameMarks(left: DocumentRun, right: DocumentRun): boolean {
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

/** Inline content as runs: a hard break joins the run beside it, and long runs are split. */
export function inlineToRuns(content: ReadonlyArray<JSONContent> | undefined): DocumentRun[] {
  const merged: MutableRun[] = [];
  for (const node of content ?? []) {
    let run: DocumentRun;
    if (node.type === "text") run = runFromText(node);
    else if (node.type === "hardBreak") {
      // A break takes the marks of the text before it, so it never stands alone.
      const before = merged[merged.length - 1];
      run = before ? { ...before, text: "\n" } : { text: "\n" };
    } else continue;
    if (run.text.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last !== undefined && sameMarks(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  const out: DocumentRun[] = [];
  for (const run of merged) {
    for (let at = 0; at < run.text.length; at += DOCUMENT_LIMITS.runChars) {
      out.push({ ...run, text: run.text.slice(at, at + DOCUMENT_LIMITS.runChars) });
    }
  }
  return out;
}

function textOf(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(textOf).join("");
}

function flattenList(
  list: JSONContent,
  level: number,
  items: Array<{ level: number; runs: DocumentRun[] }>,
): void {
  for (const item of list.content ?? []) {
    if (item.type !== "listItem" && item.type !== "taskItem") continue;
    let runs: DocumentRun[] | null = null;
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        if (runs !== null) items.push({ level, runs });
        runs = null;
        flattenList(child, Math.min(8, level + 1), items);
      } else {
        const childRuns = child.type === "paragraph" || child.type === "heading"
          ? inlineToRuns(child.content)
          : [{ text: textOf(child) }].filter((run) => run.text.length > 0);
        // A second paragraph in one item joins the first on a new line.
        runs = runs === null ? childRuns : [...runs, { text: "\n" }, ...childRuns];
      }
    }
    if (runs !== null) items.push({ level, runs: inlineToRunsFromRuns(runs) });
  }
}

/** Runs merged again after a join. */
function inlineToRunsFromRuns(runs: ReadonlyArray<DocumentRun>): DocumentRun[] {
  const merged: MutableRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && sameMarks(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  return merged;
}

function cellParagraphs(cell: JSONContent): DocumentRun[][] {
  const paragraphs: DocumentRun[][] = [];
  for (const child of cell.content ?? []) {
    if (child.type === "paragraph" || child.type === "heading") {
      paragraphs.push(inlineToRuns(child.content));
    } else if (child.type === "bulletList" || child.type === "orderedList") {
      const items: Array<{ level: number; runs: DocumentRun[] }> = [];
      flattenList(child, 0, items);
      for (const item of items) paragraphs.push(item.runs);
    } else {
      const text = textOf(child);
      paragraphs.push(text ? [{ text }] : []);
    }
  }
  return paragraphs.length > 0 ? paragraphs : [[]];
}

function withId<T extends object>(block: T, id: string | undefined): T {
  return id === undefined ? block : { ...block, id };
}

function withAlign<T extends object>(block: T, align: DocumentAlign | undefined): T {
  return align === undefined ? block : { ...block, align };
}

export interface ContentToDocumentOptions {
  /**
   * Send pictures read from the file as `asset:<hash>`, so a save over that
   * file does not carry their bytes again.
   */
  readonly assetReferences?: boolean;
}

export function contentToDocument(
  doc: JSONContent,
  options: ContentToDocumentOptions = {},
): OfficeDocument {
  const blocks: DocumentBlock[] = [];
  nodesToBlocks(doc.content ?? [], options, blocks);
  return { blocks };
}

function nodesToBlocks(
  nodes: ReadonlyArray<JSONContent>,
  options: ContentToDocumentOptions,
  blocks: DocumentBlock[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        blocks.push(
          withId(
            withAlign({ type: "paragraph", runs: inlineToRuns(node.content) }, alignOf(node.attrs)),
            bookmarkOf(node.attrs),
          ),
        );
        break;
      case "heading": {
        const raw = Number(node.attrs?.level);
        const level = (raw >= 1 && raw <= 6 ? raw : 1) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push(
          withId(
            withAlign({ type: "heading", level, runs: inlineToRuns(node.content) }, alignOf(node.attrs)),
            bookmarkOf(node.attrs),
          ),
        );
        break;
      }
      case "blockquote":
        for (const child of node.content ?? []) {
          if (child.type === "paragraph") {
            blocks.push(
              withId(
                withAlign(
                  { type: "paragraph", style: "quote", runs: inlineToRuns(child.content) },
                  alignOf(child.attrs),
                ),
                bookmarkOf(child.attrs),
              ),
            );
          } else {
            // Word quotes paragraphs only: a heading, list or table keeps its own kind.
            nodesToBlocks([child], options, blocks);
          }
        }
        break;
      case "codeBlock":
        for (const line of textOf(node).split("\n")) {
          const runs: DocumentRun[] = [];
          for (let at = 0; at < line.length; at += DOCUMENT_LIMITS.runChars) {
            runs.push({ text: line.slice(at, at + DOCUMENT_LIMITS.runChars) });
          }
          blocks.push({ type: "paragraph", style: "code", runs });
        }
        break;
      case "bulletList":
      case "orderedList":
      case "taskList": {
        const items: Array<{ level: number; runs: DocumentRun[] }> = [];
        flattenList(node, 0, items);
        blocks.push({ type: "list", ordered: node.type === "orderedList", items });
        break;
      }
      case "table":
        blocks.push({
          type: "table",
          rows: (node.content ?? []).map((row) => ({
            cells: (row.content ?? []).map((cell) => ({
              ...(cell.type === "tableHeader" ? { header: true } : {}),
              paragraphs: cellParagraphs(cell),
            })),
          })),
        });
        break;
      case "image": {
        const attrs = node.attrs ?? {};
        const src = typeof attrs.src === "string" ? attrs.src : "";
        const asset =
          typeof attrs.asset === "string" && /^[a-f0-9]{64}$/.test(attrs.asset) ? attrs.asset : undefined;
        const isData = /^data:image\/(png|jpeg|gif|webp);base64,/.test(src);
        // A picture from anywhere but the file or a pasted file is not kept.
        if (!isData && !(asset && src.startsWith("asset:"))) break;
        const width = Number(attrs.width);
        const height = Number(attrs.height);
        const align = typeof attrs.align === "string" && ALIGNS.has(attrs.align) ? attrs.align : undefined;
        blocks.push({
          type: "image",
          src: asset && options.assetReferences ? `asset:${asset}` : src,
          ...(asset ? { asset } : {}),
          ...(typeof attrs.alt === "string" && attrs.alt ? { alt: attrs.alt.slice(0, 1_000) } : {}),
          ...(width >= 1 && height >= 1 ? { width, height } : {}),
          ...(align ? { align: align as DocumentAlign } : {}),
        });
        break;
      }
      case "horizontalRule":
        blocks.push({ type: "divider" });
        break;
      default: {
        const text = textOf(node);
        if (text) blocks.push({ type: "paragraph", runs: [{ text }] });
      }
    }
  }
}
