/**
 * A `.docx` opened for editing: the preview parser's editing read turned into
 * the editor's `OfficeDocument`, with what a save would drop said up front.
 */
import type {
  DesignPreviewDocumentResult,
  DocumentBlock,
  DocumentRun,
  DocxPreviewRun,
  OfficeDocument,
} from "@specweave-studio/contracts";

import { readDocxDocument } from "./docxImport.ts";
import { bodySectionXml } from "./docxExport.ts";
import { DEFAULT_OOXML_LIMITS, openOoxmlArchive } from "./ooxmlZip.ts";

export interface EditableDocx {
  readonly document: OfficeDocument;
  readonly lossOnSave: ReadonlyArray<string>;
  readonly keptNotShown: ReadonlyArray<string>;
}

/** Parser notes for parts a save copies unchanged. */
const KEPT_FEATURES: Readonly<Record<string, string>> = {
  "Headers/footers": "Headers and footers",
};

/** Parser notes in the parser's words, as a person reads them before saving. */
const LOSS_WORDING: Readonly<Record<string, string>> = {
  "Footnotes/endnotes": "Footnote and endnote marks",
  "Images inside tables": "Pictures inside tables",
  "Nested tables (flattened into cell text)": "Tables inside tables (kept as text)",
  "Links to places the preview does not show (shown as text)": "Links to places the editor does not show",
};

function run(source: DocxPreviewRun): DocumentRun {
  const href = source.href ?? (source.anchor ? `#${source.anchor}` : undefined);
  return {
    text: source.text,
    ...(source.bold ? { bold: true } : {}),
    ...(source.italic ? { italic: true } : {}),
    ...(source.underline ? { underline: true } : {}),
    ...(source.strike ? { strike: true } : {}),
    ...(source.code ? { code: true } : {}),
    ...(source.color && /^#[0-9A-Fa-f]{6}$/.test(source.color) ? { color: source.color } : {}),
    ...(href ? { href } : {}),
  };
}

/** A table cell's runs, split back into its paragraphs at the parser's lone line breaks. */
function cellParagraphs(runs: ReadonlyArray<DocxPreviewRun>): DocumentRun[][] {
  const paragraphs: DocumentRun[][] = [[]];
  for (const entry of runs) {
    const plain =
      entry.text === "\n" &&
      !entry.bold &&
      !entry.italic &&
      !entry.underline &&
      !entry.strike &&
      !entry.code &&
      entry.href === undefined &&
      entry.anchor === undefined;
    if (plain) paragraphs.push([]);
    else paragraphs[paragraphs.length - 1]!.push(run(entry));
  }
  return paragraphs;
}

export function previewToDocument(preview: DesignPreviewDocumentResult): {
  readonly document: OfficeDocument;
  readonly missingImages: number;
} {
  const blocks: DocumentBlock[] = [];
  let missingImages = 0;
  for (const block of preview.blocks) {
    switch (block.type) {
      case "heading":
        blocks.push({
          type: "heading",
          level: block.level,
          ...(block.id ? { id: block.id } : {}),
          ...(block.align ? { align: block.align } : {}),
          runs: block.runs.map(run),
        });
        break;
      case "paragraph":
        blocks.push({
          type: "paragraph",
          ...(block.id ? { id: block.id } : {}),
          ...(block.align ? { align: block.align } : {}),
          ...(block.style ? { style: block.style } : {}),
          runs: block.runs.map(run),
        });
        break;
      case "list":
        blocks.push({
          type: "list",
          ordered: block.ordered,
          items: block.items.map((item) => ({
            level: Math.min(8, item.level ?? 0),
            runs: item.runs.map(run),
          })),
        });
        break;
      case "table":
        blocks.push({
          type: "table",
          rows: block.rows.map((row) => ({
            cells: row.cells.map((cell) => ({
              ...(cell.header ? { header: true } : {}),
              paragraphs: cellParagraphs(cell.runs),
            })),
          })),
        });
        break;
      case "image": {
        const src = preview.images[block.asset];
        const match = src === undefined ? null : /^data:image\/(png|jpeg|gif|webp);base64,/.exec(src);
        if (src === undefined || match === null) {
          missingImages += 1;
          break;
        }
        const hash = /^([a-f0-9]{64})\./.exec(block.asset)?.[1];
        blocks.push({
          type: "image",
          src,
          ...(hash ? { asset: hash } : {}),
          ...(block.alt ? { alt: block.alt.slice(0, 1_000) } : {}),
          ...(block.width !== undefined && block.height !== undefined
            ? { width: block.width, height: block.height }
            : {}),
          ...(block.align ? { align: block.align } : {}),
        });
        break;
      }
      case "divider":
        blocks.push({ type: "divider" });
        break;
    }
  }
  return { document: { blocks }, missingImages };
}

/** Reads `.docx` bytes for the editor. Throws `OoxmlPreviewError` on a file it refuses. */
export async function openDocxForEditing(bytes: Uint8Array): Promise<EditableDocx> {
  const preview = await readDocxDocument(bytes, { forEditing: true });
  const { document, missingImages } = previewToDocument(preview);
  const loss = new Set<string>();
  const kept = new Set<string>();
  for (const feature of preview.unsupportedFeatures) {
    const keptAs = KEPT_FEATURES[feature];
    if (keptAs !== undefined) kept.add(keptAs);
    else loss.add(LOSS_WORDING[feature] ?? feature);
  }
  if (preview.truncated) loss.add("Content past the editor's size limit");
  if (preview.imagesOmitted > 0 || missingImages > 0) loss.add("Pictures too large to open here");

  // What only the raw body shows: direct formatting, fields and sections.
  const archive = await openOoxmlArchive(bytes, DEFAULT_OOXML_LIMITS);
  const raw = archive.entries.get("word/document.xml");
  const xml = raw === undefined ? "" : new TextDecoder("utf-8").decode(raw);
  if (bodySectionXml(xml) !== null) kept.add("Page size and margins");
  if ((xml.match(/<w:sectPr\b/g)?.length ?? 0) > 1 + (xml.match(/<w:sectPrChange\b/g)?.length ?? 0)) {
    loss.add("Section breaks");
  }
  if (/<w:(fldChar|fldSimple)\b/.test(xml)) {
    loss.add("Fields such as a table of contents or page numbers (kept as text)");
  }
  if (/<w:br\b[^>]*w:type="page"/.test(xml)) loss.add("Page breaks (kept as line breaks)");
  if (/<w:(gridSpan|vMerge|hMerge)\b/.test(xml)) loss.add("Merged table cells");
  if (/<wp:anchor\b/.test(xml)) loss.add("Floating pictures and shapes (kept in line)");
  if (/<w:vertAlign\b/.test(xml)) loss.add("Superscript and subscript");
  if (/<w:(smartTag|customXml)\b/.test(xml)) loss.add("Smart tags and custom XML");
  for (const grid of xml.matchAll(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/g)) {
    const widths = [...grid[1]!.matchAll(/w:w="(\d+)"/g)].map((match) => Number(match[1]));
    if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > 30) {
      loss.add("Table column widths (columns become equal)");
      break;
    }
  }
  if (/<w:r\b[^>]*>\s*<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:(sz|highlight|shd)\b/.test(xml)) {
    loss.add("Font sizes and highlights set on words");
  }
  if (/<w:sdt\b/.test(xml)) loss.add("Content controls such as form fields (their text is kept)");
  if (listsStartPastOne(xml, archive.entries.get("word/numbering.xml"))) {
    loss.add("Numbered lists that start past 1 (they start at 1)");
  }
  // Paragraph styles the editor has no kind for (a template's own styles) become plain paragraphs.
  const stylesRaw = archive.entries.get("word/styles.xml");
  const stylesXml = stylesRaw === undefined ? "" : new TextDecoder("utf-8").decode(stylesRaw);
  const used = new Set(
    [...xml.matchAll(/<w:pStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]!),
  );
  const styleBody = (id: string): string | null => {
    const style = new RegExp(
      `<w:style\\b[^>]*\\bw:styleId\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)</w:style>`,
    ).exec(stylesXml);
    return style === null ? null : style[1]!;
  };
  const defaultStyle =
    /<w:style\b(?=[^>]*\bw:type\s*=\s*["']paragraph["'])(?=[^>]*\bw:default\s*=\s*["'](?:1|true)["'])[^>]*\bw:styleId\s*=\s*["']([^"']+)["']/.exec(
      stylesXml,
    )?.[1] ?? "Normal";
  /**
   * A style the paragraph can lose: it and every style it is based on, up to the
   * file's default paragraph style (which the paragraph keeps), set nothing but
   * spacing and housekeeping. Anything else, or a chain it cannot read, is a look.
   */
  const addsNoLook = (id: string): boolean => {
    for (let current: string | undefined = id, depth = 0; current !== undefined; depth += 1) {
      if (current === defaultStyle) return true;
      const body = styleBody(current);
      if (body === null || depth > 16) return false;
      for (const element of body.matchAll(/<w:([A-Za-z]+)\b/g)) {
        if (!LOOKLESS_STYLE_ELEMENTS.has(element[1]!)) return false;
      }
      current = /<w:basedOn\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    }
    return true;
  };
  for (const id of used) {
    if (id === defaultStyle) continue;
    const body = styleBody(id) ?? "";
    const name = /<w:name\b[^>]*\bw:val\s*=\s*["']([^"']+)["']/.exec(body)?.[1] ?? id;
    const mapped = MAPPED_PARAGRAPH_STYLE.test(name) || MAPPED_PARAGRAPH_STYLE.test(id);
    const plain = (PLAIN_PARAGRAPH_STYLE.test(name) || PLAIN_PARAGRAPH_STYLE.test(id)) && addsNoLook(id);
    if (!mapped && !plain) {
      loss.add("Paragraph styles from the file's template (become plain paragraphs)");
      break;
    }
  }
  return { document, lossOnSave: [...loss], keptNotShown: [...kept] };
}

/** Whether a list the body uses starts at a number other than 1, which the editor does not keep. */
function listsStartPastOne(documentXml: string, numberingRaw: Uint8Array | undefined): boolean {
  if (numberingRaw === undefined) return false;
  const numbering = new TextDecoder("utf-8").decode(numberingRaw);
  const used = new Set(
    [...documentXml.matchAll(/<w:numId\b[^>]*\bw:val\s*=\s*["'](\d+)["']/g)].map((match) => match[1]!),
  );
  used.delete("0");
  const pastOne = (value: string | undefined) => value !== undefined && Number(value) > 1;
  for (const num of numbering.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g)) {
    const id = /\bw:numId\s*=\s*["'](\d+)["']/.exec(num[1]!)?.[1];
    if (id === undefined || !used.has(id)) continue;
    const body = num[2]!;
    for (const override of body.matchAll(/<w:startOverride\b[^>]*\bw:val\s*=\s*["'](\d+)["']/g)) {
      if (pastOne(override[1])) return true;
    }
    const abstractId = /<w:abstractNumId\b[^>]*\bw:val\s*=\s*["'](\d+)["']/.exec(body)?.[1];
    if (abstractId === undefined) continue;
    const abstract = new RegExp(
      `<w:abstractNum\\b[^>]*\\bw:abstractNumId\\s*=\\s*["']${abstractId}["'][^>]*>([\\s\\S]*?)</w:abstractNum>`,
    ).exec(numbering)?.[1];
    if (abstract === undefined) continue;
    for (const level of abstract.matchAll(/<w:lvl\b[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const levelBody = level[1]!;
      // A bullet level's start number shows nowhere.
      if (/<w:numFmt\b[^>]*\bw:val\s*=\s*["'](bullet|none)["']/.test(levelBody)) continue;
      if (pastOne(/<w:start\b[^>]*\bw:val\s*=\s*["'](\d+)["']/.exec(levelBody)?.[1])) return true;
    }
  }
  return false;
}

/** Paragraph styles the editor keeps a kind for (heading, list, quote, code), by English name or id. */
const MAPPED_PARAGRAPH_STYLE =
  /^(heading ?[1-6]|title|list ?paragraph|list ?(bullet|number)( ?[1-9])?|(intense ?)?quote|quotations|code( ?block)?|source ?code|preformatted ?text|html ?preformatted)$/i;

/**
 * What a body style may set and still be plain: housekeeping, the paragraph and run
 * property wrappers, and spacing between lines and paragraphs. Fonts, sizes, weight,
 * colour, alignment and indents are a look, so a style setting them is named before a save.
 */
const LOOKLESS_STYLE_ELEMENTS = new Set([
  "name",
  "aliases",
  "basedOn",
  "next",
  "link",
  "autoRedefine",
  "hidden",
  "uiPriority",
  "semiHidden",
  "unhideWhenUsed",
  "qFormat",
  "locked",
  "personal",
  "personalCompose",
  "personalReply",
  "rsid",
  "pPr",
  "rPr",
  "spacing",
  "widowControl",
  "contextualSpacing",
  "keepNext",
  "keepLines",
  "suppressAutoHyphens",
  "snapToGrid",
  "lang",
  "noProof",
  "kern",
]);

/** Default body styles, written by Word and LibreOffice, that are plain text unless they add a look. */
const PLAIN_PARAGRAPH_STYLE =
  /^(normal|default( paragraph style)?|standard|text ?body|body ?text|no ?spacing|table ?contents)$/i;
