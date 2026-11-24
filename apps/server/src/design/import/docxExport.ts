// @effect-diagnostics nodeBuiltinImport:off - Names pictures by content hash, as docxImport does.
/**
 * Word (.docx) writer for the document editor and the `doc_write` tool.
 *
 * Writes the editor's `OfficeDocument` as WordprocessingML that Word and
 * LibreOffice open alike. Given the file it replaces (`base`), only the body
 * of `word/document.xml` is rewritten: headers, footers, page setup, theme,
 * fonts, settings, footnotes, comments and every other part are copied as
 * they were, the file's own styles stay and only the styles and list
 * definitions the body needs are added. The base is read through the same
 * bounded, macro-refusing OOXML reader as the preview.
 */
import * as NodeCrypto from "node:crypto";

import {
  DOCUMENT_LIMITS,
  type DocumentAlign,
  type DocumentBlock,
  type DocumentRun,
  type OfficeDocument,
} from "@specweave-studio/contracts";
import JSZip from "jszip";

import {
  assertNoMacros,
  DEFAULT_OOXML_LIMITS,
  OoxmlPreviewError,
  openOoxmlArchive,
} from "./ooxmlZip.ts";

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  rels: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
} as const;

const REL_TYPE = {
  officeDocument: `${NS.r}/officeDocument`,
  styles: `${NS.r}/styles`,
  numbering: `${NS.r}/numbering`,
  settings: `${NS.r}/settings`,
  image: `${NS.r}/image`,
  hyperlink: `${NS.r}/hyperlink`,
  coreProperties: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProperties: `${NS.r}/extended-properties`,
} as const;

const CONTENT_TYPE = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  styles: "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  numbering: "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  settings: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  rels: "application/vnd.openxmlformats-package.relationships+xml",
} as const;

const IMAGE_TYPES: Readonly<Record<string, { readonly ext: string; readonly mime: string }>> = {
  png: { ext: "png", mime: "image/png" },
  jpeg: { ext: "jpeg", mime: "image/jpeg" },
  gif: { ext: "gif", mime: "image/gif" },
  webp: { ext: "webp", mime: "image/webp" },
};

const EMU_PER_PIXEL = 9525;
/** 6.5 inches: the text width of a Letter or A4 page with one-inch margins. */
const MAX_IMAGE_WIDTH_PX = 624;
const SAFE_HREF_RE = /^(https?:\/\/|mailto:)[^\s<>"]+$/i;
/** Characters XML 1.0 cannot hold (control characters, lone surrogates, U+FFFE/FFFF). */
const XML_INVALID_RE = new RegExp(
  `[^\\t\\n\\r${String.fromCodePoint(0x20)}-${String.fromCodePoint(0xd7ff)}${String.fromCodePoint(0xe000)}-${String.fromCodePoint(0xfffd)}${String.fromCodePoint(0x10000)}-${String.fromCodePoint(0x10ffff)}]`,
  "gu",
);

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export class DocxWriteError extends Error {
  readonly code: "invalid" | "too_large";
  constructor(code: "invalid" | "too_large", message: string) {
    super(message);
    this.code = code;
  }
}

function esc(text: string): string {
  return text
    .replace(XML_INVALID_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bookmark names Word accepts: up to 40 characters, no spaces. */
function bookmarkName(id: string): string {
  const cleaned = id.replace(/[^\p{L}\p{N}_]/gu, "_").slice(0, 40);
  return /^\p{L}|^_/u.test(cleaned) ? cleaned : `_${cleaned}`.slice(0, 40);
}

// ── Styles and numbering the body uses ──────────────────────────────────────

const HEADING_SIZES = [32, 28, 26, 24, 22, 22] as const;

function headingStyle(level: number): string {
  const size = HEADING_SIZES[level - 1] ?? 22;
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
    `<w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="80"/>` +
    `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  );
}

const EXTRA_STYLES: Readonly<Record<string, string>> = {
  Normal:
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:style>',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [`Heading${level}`, headingStyle(level)])),
  ListParagraph:
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>',
  Quote:
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:before="120" w:after="120"/><w:ind w:left="720" w:right="720"/></w:pPr>' +
    '<w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>',
  CodeBlock:
    '<w:style w:type="paragraph" w:customStyle="1" w:styleId="CodeBlock"><w:name w:val="Code Block"/>' +
    '<w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
  Hyperlink:
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
  TableGrid:
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:uiPriority w:val="39"/>' +
    '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:tblPr><w:tblBorders>' +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
      .join("") +
    '</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>',
};

function stylesPart(): string {
  return (
    XML_HEADER +
    `<w:styles xmlns:w="${NS.w}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/>' +
    "</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>" +
    Object.values(EXTRA_STYLES).join("") +
    "</w:styles>"
  );
}

/** Adds the styles the body names that the file's own styles lack. */
function mergeStyles(existing: string, used: ReadonlySet<string>): string {
  if (!/<w:styles[\s>]/.test(existing) || !existing.includes("</w:styles>")) return existing;
  const missing = [...used].filter(
    (id) => !new RegExp(`w:styleId="${id}"`).test(existing) && EXTRA_STYLES[id] !== undefined,
  );
  if (missing.length === 0) return existing;
  const insert = missing.map((id) => EXTRA_STYLES[id]).join("");
  const at = existing.lastIndexOf("</w:styles>");
  return existing.slice(0, at) + insert + existing.slice(at);
}

const BULLETS = ["•", "◦", "▪"] as const;
const ORDERED_FORMATS = [
  ["decimal", "%L."],
  ["lowerLetter", "%L."],
  ["lowerRoman", "%L."],
] as const;

function abstractNum(id: number, ordered: boolean): string {
  let levels = "";
  for (let level = 0; level < 9; level += 1) {
    const indent = 720 * (level + 1);
    if (ordered) {
      const [format, text] = ORDERED_FORMATS[level % 3]!;
      levels +=
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
        `<w:lvlText w:val="${text.replace("L", String(level + 1))}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
    } else {
      levels +=
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
        `<w:lvlText w:val="${BULLETS[level % 3]}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
    }
  }
  return (
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>` +
    `${levels}</w:abstractNum>`
  );
}

interface NumberingPlan {
  readonly bulletAbstract: number;
  readonly orderedAbstract: number;
  readonly bulletNum: number;
  /** One numId per ordered list, so each starts again at 1. */
  readonly orderedNums: number[];
}

function numberingXml(plan: NumberingPlan, abstracts: boolean): { abstracts: string; nums: string } {
  const nums =
    `<w:num w:numId="${plan.bulletNum}"><w:abstractNumId w:val="${plan.bulletAbstract}"/></w:num>` +
    plan.orderedNums
      .map(
        (numId) =>
          `<w:num w:numId="${numId}"><w:abstractNumId w:val="${plan.orderedAbstract}"/>` +
          `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
      )
      .join("");
  return {
    abstracts: abstracts
      ? abstractNum(plan.bulletAbstract, false) + abstractNum(plan.orderedAbstract, true)
      : "",
    nums,
  };
}

function maxAttr(xml: string, attr: string): number {
  let max = 0;
  for (const match of xml.matchAll(new RegExp(`${attr}="(\\d+)"`, "g"))) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

// ── Pictures ────────────────────────────────────────────────────────────────

function pictureSize(bytes: Uint8Array, kind: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (kind === "png" && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (kind === "gif" && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (kind === "jpeg") {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1]!;
        const length = view.getUint16(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
        }
        at += 2 + length;
      }
    }
    if (kind === "webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X") {
        const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        return { width, height };
      }
      if (chunk === "VP8 ") {
        return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

interface Media {
  readonly part: string;
  readonly relId: string;
  readonly bytes: Uint8Array;
}

// ── Body ────────────────────────────────────────────────────────────────────

interface BodyContext {
  readonly relIds: Set<string>;
  readonly newRels: Array<{ id: string; type: string; target: string; external: boolean }>;
  readonly media: Map<string, Media>;
  readonly usedStyles: Set<string>;
  readonly usedImageTypes: Set<string>;
  imageBytes: number;
  drawingId: number;
  bookmarkId: number;
  numbering: NumberingPlan;
  orderedIndex: number;
  usesLists: boolean;
}

function nextRelId(ctx: BodyContext): string {
  let n = ctx.newRels.length + 1;
  while (ctx.relIds.has(`rIdSwc${n}`)) n += 1;
  const id = `rIdSwc${n}`;
  ctx.relIds.add(id);
  return id;
}

function runXml(run: DocumentRun, linked: boolean): string {
  const props: string[] = [];
  if (linked) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (run.code) {
    props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  }
  if (run.bold) props.push("<w:b/><w:bCs/>");
  if (run.italic) props.push("<w:i/><w:iCs/>");
  if (run.strike) props.push("<w:strike/>");
  if (run.color && /^#[0-9A-Fa-f]{6}$/.test(run.color)) {
    props.push(`<w:color w:val="${run.color.slice(1).toUpperCase()}"/>`);
  }
  if (run.underline) props.push('<w:u w:val="single"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  let content = "";
  const parts = run.text.replace(/\r\n?/g, "\n").split(/(\n|\t)/);
  for (const part of parts) {
    if (part === "\n") content += "<w:br/>";
    else if (part === "\t") content += "<w:tab/>";
    else if (part.length > 0) content += `<w:t xml:space="preserve">${esc(part)}</w:t>`;
  }
  return content.length > 0 ? `<w:r>${rPr}${content}</w:r>` : "";
}

function runsXml(runs: ReadonlyArray<DocumentRun>, ctx: BodyContext): string {
  let out = "";
  let index = 0;
  while (index < runs.length) {
    const run = runs[index]!;
    const href = run.href;
    if (href === undefined || href.length === 0) {
      out += runXml(run, false);
      index += 1;
      continue;
    }
    // Neighbouring runs with the same link are one hyperlink.
    let end = index;
    let inner = "";
    while (end < runs.length && runs[end]!.href === href) {
      inner += runXml(runs[end]!, true);
      end += 1;
    }
    if (href.startsWith("#") && href.length > 1) {
      out += `<w:hyperlink w:anchor="${esc(bookmarkName(href.slice(1)))}" w:history="1">${inner}</w:hyperlink>`;
    } else if (SAFE_HREF_RE.test(href)) {
      const id = nextRelId(ctx);
      ctx.newRels.push({ id, type: REL_TYPE.hyperlink, target: href, external: true });
      out += `<w:hyperlink r:id="${id}" w:history="1">${inner}</w:hyperlink>`;
    } else {
      // A link the file may not carry (javascript:, file:) is kept as its text.
      out += runs.slice(index, end).map((entry) => runXml(entry, false)).join("");
    }
    ctx.usedStyles.add("Hyperlink");
    index = end;
  }
  return out;
}

function jcXml(align: DocumentAlign | undefined): string {
  if (align === undefined || align === "left") return "";
  return `<w:jc w:val="${align === "justify" ? "both" : align}"/>`;
}

function bookmarked(id: string | undefined, ctx: BodyContext, inner: string): string {
  if (id === undefined || id.length === 0) return inner;
  const n = ctx.bookmarkId++;
  return `<w:bookmarkStart w:id="${n}" w:name="${esc(bookmarkName(id))}"/>${inner}<w:bookmarkEnd w:id="${n}"/>`;
}

function paragraphXml(
  runs: ReadonlyArray<DocumentRun>,
  ctx: BodyContext,
  options: {
    readonly style?: string;
    readonly numbering?: { readonly numId: number; readonly level: number };
    readonly align?: DocumentAlign | undefined;
    readonly id?: string | undefined;
  } = {},
): string {
  let pPr = "";
  if (options.style) {
    pPr += `<w:pStyle w:val="${options.style}"/>`;
    ctx.usedStyles.add(options.style);
  }
  if (options.numbering) {
    pPr += `<w:numPr><w:ilvl w:val="${options.numbering.level}"/><w:numId w:val="${options.numbering.numId}"/></w:numPr>`;
  }
  pPr += jcXml(options.align);
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${bookmarked(options.id, ctx, runsXml(runs, ctx))}</w:p>`;
}

function imageXml(block: Extract<DocumentBlock, { type: "image" }>, ctx: BodyContext): string {
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]*)$/.exec(block.src);
  if (!match) throw new DocxWriteError("invalid", "A picture is not a PNG, JPEG, GIF or WebP data URL.");
  const kind = match[1]!;
  const bytes = new Uint8Array(Buffer.from(match[2]!.replace(/\s+/g, ""), "base64"));
  if (bytes.byteLength === 0) throw new DocxWriteError("invalid", "A picture has no data.");
  const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  let media = ctx.media.get(hash);
  if (media === undefined) {
    ctx.imageBytes += bytes.byteLength;
    if (ctx.imageBytes > DOCUMENT_LIMITS.imageBytes) {
      throw new DocxWriteError(
        "too_large",
        `The pictures together are over ${DOCUMENT_LIMITS.imageBytes / (1024 * 1024)} MB.`,
      );
    }
    const type = IMAGE_TYPES[kind]!;
    const part = `media/swc-${hash.slice(0, 16)}.${type.ext}`;
    const relId = nextRelId(ctx);
    ctx.newRels.push({ id: relId, type: REL_TYPE.image, target: part, external: false });
    ctx.usedImageTypes.add(kind);
    media = { part: `word/${part}`, relId, bytes };
    ctx.media.set(hash, media);
  }
  const natural = pictureSize(bytes, kind) ?? { width: 480, height: 320 };
  let width = block.width ?? natural.width;
  let height =
    block.height ?? (block.width !== undefined && natural.width > 0
      ? (block.width * natural.height) / natural.width
      : natural.height);
  if (width > MAX_IMAGE_WIDTH_PX) {
    height = (height * MAX_IMAGE_WIDTH_PX) / width;
    width = MAX_IMAGE_WIDTH_PX;
  }
  const cx = Math.max(1, Math.round(width * EMU_PER_PIXEL));
  const cy = Math.max(1, Math.round(height * EMU_PER_PIXEL));
  const id = ctx.drawingId++;
  const alt = esc(block.alt ?? "");
  const drawing =
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${media.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const jc = jcXml(block.align);
  return `<w:p>${jc ? `<w:pPr>${jc}</w:pPr>` : ""}${drawing}</w:p>`;
}

function tableXml(block: Extract<DocumentBlock, { type: "table" }>, ctx: BodyContext): string {
  const cols = Math.max(1, ...block.rows.map((row) => row.cells.length));
  const colWidth = Math.floor(9360 / cols);
  ctx.usedStyles.add("TableGrid");
  let rows = "";
  for (const row of block.rows) {
    const header = row.cells.length > 0 && row.cells.every((cell) => cell.header === true);
    let cells = "";
    for (let col = 0; col < cols; col += 1) {
      const cell = row.cells[col];
      const paragraphs = cell?.paragraphs.length ? cell.paragraphs : [[]];
      cells +=
        `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>` +
        paragraphs.map((runs) => paragraphXml(runs, ctx)).join("") +
        "</w:tc>";
    }
    rows += `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
  }
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/>` +
    `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>` +
    `</w:tblPr><w:tblGrid>${`<w:gridCol w:w="${colWidth}"/>`.repeat(cols)}</w:tblGrid>${rows}</w:tbl>`
  );
}

function bodyXml(document: OfficeDocument, ctx: BodyContext): string {
  let out = "";
  let previousTable = false;
  for (const block of document.blocks) {
    // Two tables in a row merge into one in Word unless a paragraph parts them.
    if (block.type === "table" && previousTable) out += "<w:p/>";
    previousTable = block.type === "table";
    switch (block.type) {
      case "paragraph":
        out += paragraphXml(block.runs, ctx, {
          ...(block.style === "quote"
            ? { style: "Quote" }
            : block.style === "code"
              ? { style: "CodeBlock" }
              : {}),
          align: block.align,
          id: block.id,
        });
        break;
      case "heading":
        out += paragraphXml(block.runs, ctx, {
          style: `Heading${block.level}`,
          align: block.align,
          id: block.id,
        });
        break;
      case "list": {
        ctx.usesLists = true;
        const numId = block.ordered
          ? ctx.numbering.orderedNums[ctx.orderedIndex++]!
          : ctx.numbering.bulletNum;
        for (const item of block.items) {
          out += paragraphXml(item.runs, ctx, {
            style: "ListParagraph",
            numbering: { numId, level: Math.max(0, Math.min(8, item.level)) },
          });
        }
        break;
      }
      case "table":
        out += tableXml(block, ctx);
        break;
      case "image":
        out += imageXml(block, ctx);
        break;
      case "divider":
        out +=
          '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
        break;
    }
  }
  // Word needs a paragraph before the section properties, and after a closing table.
  if (out.length === 0 || previousTable) out += "<w:p/>";
  return out;
}

const DEFAULT_SECT_PR =
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';

/**
 * The body's own `w:sectPr` (page size, margins, header and footer links) as
 * written in the file, or null. A section break's `w:sectPr` inside a
 * paragraph, and the old one inside `w:sectPrChange`, are not it.
 */
export function bodySectionXml(documentXml: string): string | null {
  const bodyEnd = documentXml.lastIndexOf("</w:body>");
  if (bodyEnd < 0) return null;
  const before = documentXml.slice(0, bodyEnd).trimEnd();
  if (/<w:sectPr\b[^>]*\/>$/.test(before)) {
    const start = before.lastIndexOf("<w:sectPr");
    return before.slice(start);
  }
  if (!before.endsWith("</w:sectPr>")) return null;
  const tokens = [...before.matchAll(/<w:sectPr\b[^>]*?(\/?)>|<\/w:sectPr>/g)];
  let depth = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token[0] === "</w:sectPr>") depth += 1;
    else if (token[1] !== "/") depth -= 1;
    if (depth === 0) return before.slice(token.index);
  }
  return null;
}

function rootAttributes(documentXml: string | null): string {
  const attrs = new Map<string, string>();
  const root = documentXml === null ? null : /<w:document\b([^>]*)>/.exec(documentXml);
  if (root) {
    for (const match of root[1]!.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      attrs.set(match[1]!, match[2]!);
    }
  }
  for (const prefix of ["w", "r", "wp", "a", "pic"] as const) {
    if (!attrs.has(`xmlns:${prefix}`)) attrs.set(`xmlns:${prefix}`, NS[prefix]);
  }
  // A prefix the file says to ignore must still be declared.
  const ignorable = attrs.get("mc:Ignorable");
  if (ignorable !== undefined) {
    const declared = ignorable.split(/\s+/).filter((prefix) => attrs.has(`xmlns:${prefix}`));
    if (declared.length > 0 && attrs.has("xmlns:mc")) attrs.set("mc:Ignorable", declared.join(" "));
    else attrs.delete("mc:Ignorable");
  }
  return [...attrs].map(([name, value]) => ` ${name}="${value}"`).join("");
}

// ── Package parts ───────────────────────────────────────────────────────────

interface RelEntry {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  readonly raw?: string;
}

function parseRels(xml: string): RelEntry[] {
  const out: RelEntry[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*?\/?>(?:\s*<\/Relationship>)?/g)) {
    const raw = match[0];
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(raw)?.[1];
    const id = attr("Id");
    const type = attr("Type");
    const target = attr("Target");
    if (!id || !type || target === undefined) continue;
    out.push({ id, type, target, external: attr("TargetMode")?.toLowerCase() === "external", raw });
  }
  return out;
}

function relsXml(entries: ReadonlyArray<RelEntry>): string {
  return (
    XML_HEADER +
    `<Relationships xmlns="${NS.rels}">` +
    entries
      .map(
        (entry) =>
          entry.raw ??
          `<Relationship Id="${esc(entry.id)}" Type="${entry.type}" Target="${esc(entry.target)}"${
            entry.external ? ' TargetMode="External"' : ""
          }/>`,
      )
      .join("") +
    "</Relationships>"
  );
}

function ensureContentTypes(
  xml: string,
  defaults: ReadonlyArray<readonly [string, string]>,
  overrides: ReadonlyArray<readonly [string, string]>,
): string {
  let out = xml;
  const close = "</Types>";
  for (const [ext, type] of defaults) {
    if (!new RegExp(`<Default\\b[^>]*Extension="${ext}"`, "i").test(out)) {
      out = out.replace(close, `<Default Extension="${ext}" ContentType="${type}"/>${close}`);
    }
  }
  for (const [part, type] of overrides) {
    if (!new RegExp(`<Override\\b[^>]*PartName="${part.replace(/[.]/g, "\\.")}"`, "i").test(out)) {
      out = out.replace(close, `<Override PartName="${part}" ContentType="${type}"/>${close}`);
    }
  }
  return out;
}

function newContentTypes(): string {
  return (
    XML_HEADER +
    `<Types xmlns="${NS.ct}">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPE.rels}"/>` +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${CONTENT_TYPE.document}"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="${CONTENT_TYPE.core}"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="${CONTENT_TYPE.app}"/>` +
    "</Types>"
  );
}

function corePart(title: string | undefined, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    (title ? `<dc:title>${esc(title)}</dc:title>` : "") +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

const APP_PART =
  XML_HEADER +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  "<Application>SpecWithCode</Application></Properties>";

const SETTINGS_PART =
  XML_HEADER +
  `<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>` +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

export interface BuildDocxOptions {
  /** The .docx being replaced; its other parts are kept. */
  readonly base?: Uint8Array | undefined;
  /** Title for a new file's properties. */
  readonly title?: string | undefined;
  readonly now?: Date | undefined;
}

/** Writes an `OfficeDocument` as `.docx` bytes. */
export async function buildDocx(
  document: OfficeDocument,
  options: BuildDocxOptions = {},
): Promise<Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let baseDocumentXml: string | null = null;
  if (options.base !== undefined) {
    let archive;
    try {
      archive = await openOoxmlArchive(options.base, DEFAULT_OOXML_LIMITS);
    } catch (error) {
      if (error instanceof OoxmlPreviewError) throw new DocxWriteError(error.code, error.message);
      throw error;
    }
    try {
      assertNoMacros(archive);
    } catch (error) {
      if (error instanceof OoxmlPreviewError) throw new DocxWriteError(error.code, error.message);
      throw error;
    }
    for (const [name, bytes] of archive.entries) entries.set(name, bytes);
    const raw = entries.get("word/document.xml");
    if (raw === undefined) {
      throw new DocxWriteError("invalid", "The file is not a valid Word document (.docx).");
    }
    baseDocumentXml = decoder.decode(raw);
  }
  const text = (name: string) => {
    const bytes = entries.get(name);
    return bytes === undefined ? null : decoder.decode(bytes);
  };

  // Relationships of the main part: the file's own, less the pictures and links the old body used.
  const baseRels = parseRels(text("word/_rels/document.xml.rels") ?? "");
  const dropped = baseRels.filter(
    (rel) => rel.type === REL_TYPE.image || rel.type === REL_TYPE.hyperlink,
  );
  const keptRels = baseRels.filter((rel) => !dropped.includes(rel));
  const existingNumbering = text("word/numbering.xml");
  const orderedLists = document.blocks.filter(
    (block) => block.type === "list" && block.ordered,
  ).length;
  const absBase = existingNumbering === null ? 0 : maxAttr(existingNumbering, "w:abstractNumId") + 1;
  const numBase = existingNumbering === null ? 1 : maxAttr(existingNumbering, "w:numId") + 1;
  const ctx: BodyContext = {
    relIds: new Set(baseRels.map((rel) => rel.id)),
    newRels: [],
    media: new Map(),
    usedStyles: new Set(["Normal"]),
    usedImageTypes: new Set(),
    imageBytes: 0,
    drawingId: 1000,
    bookmarkId: 9000,
    numbering: {
      bulletAbstract: absBase,
      orderedAbstract: absBase + 1,
      bulletNum: numBase,
      orderedNums: Array.from({ length: orderedLists }, (_, index) => numBase + 1 + index),
    },
    orderedIndex: 0,
    usesLists: false,
  };
  const body = bodyXml(document, ctx);
  const section = (baseDocumentXml && bodySectionXml(baseDocumentXml)) ?? DEFAULT_SECT_PR;
  const documentXml =
    XML_HEADER +
    `<w:document${rootAttributes(baseDocumentXml)}><w:body>${body}${section}</w:body></w:document>`;

  // Old pictures no other part links to go with the old body.
  const otherRels = [...entries.keys()]
    .filter((name) => name.endsWith(".rels") && name !== "word/_rels/document.xml.rels")
    .map((name) => text(name) ?? "")
    .join("\n");
  for (const rel of dropped) {
    if (rel.type !== REL_TYPE.image || rel.external) continue;
    const file = rel.target.replace(/^\/+/, "").replace(/^(?!word\/)/, "word/");
    const fileName = file.slice(file.lastIndexOf("/") + 1);
    if (!otherRels.includes(fileName)) entries.delete(file);
  }

  // Styles.
  const existingStyles = text("word/styles.xml");
  const addedParts: Array<readonly [string, string]> = [];
  if (existingStyles === null) {
    entries.set("word/styles.xml", encoder.encode(stylesPart()));
    addedParts.push(["/word/styles.xml", CONTENT_TYPE.styles]);
  } else {
    entries.set("word/styles.xml", encoder.encode(mergeStyles(existingStyles, ctx.usedStyles)));
  }
  if (!keptRels.some((rel) => rel.type === REL_TYPE.styles)) {
    keptRels.push({ id: nextRelId(ctx), type: REL_TYPE.styles, target: "styles.xml", external: false });
  }

  // Numbering: our two list definitions after the file's own.
  if (ctx.usesLists) {
    if (existingNumbering === null || !existingNumbering.includes("</w:numbering>")) {
      const { abstracts, nums } = numberingXml(ctx.numbering, true);
      entries.set(
        "word/numbering.xml",
        encoder.encode(`${XML_HEADER}<w:numbering xmlns:w="${NS.w}">${abstracts}${nums}</w:numbering>`),
      );
      addedParts.push(["/word/numbering.xml", CONTENT_TYPE.numbering]);
    } else {
      const { abstracts, nums } = numberingXml(ctx.numbering, true);
      let xml = existingNumbering;
      const firstNum = /<w:num[\s>]/.exec(xml);
      const cleanup = xml.indexOf("<w:numIdMacAtCleanup");
      const close = xml.lastIndexOf("</w:numbering>");
      const abstractAt = firstNum ? firstNum.index : cleanup >= 0 ? cleanup : close;
      xml = xml.slice(0, abstractAt) + abstracts + xml.slice(abstractAt);
      const cleanup2 = xml.indexOf("<w:numIdMacAtCleanup");
      const numAt = cleanup2 >= 0 ? cleanup2 : xml.lastIndexOf("</w:numbering>");
      xml = xml.slice(0, numAt) + nums + xml.slice(numAt);
      entries.set("word/numbering.xml", encoder.encode(xml));
    }
    if (!keptRels.some((rel) => rel.type === REL_TYPE.numbering)) {
      keptRels.push({
        id: nextRelId(ctx),
        type: REL_TYPE.numbering,
        target: "numbering.xml",
        external: false,
      });
    }
  }

  if (!entries.has("word/settings.xml")) {
    entries.set("word/settings.xml", encoder.encode(SETTINGS_PART));
    addedParts.push(["/word/settings.xml", CONTENT_TYPE.settings]);
    keptRels.push({ id: nextRelId(ctx), type: REL_TYPE.settings, target: "settings.xml", external: false });
  }

  for (const media of ctx.media.values()) entries.set(media.part, media.bytes);
  entries.set("word/document.xml", encoder.encode(documentXml));
  entries.set("word/_rels/document.xml.rels", encoder.encode(relsXml([...keptRels, ...ctx.newRels])));

  if (options.base === undefined) {
    entries.set("docProps/core.xml", encoder.encode(corePart(options.title, options.now ?? new Date())));
    entries.set("docProps/app.xml", encoder.encode(APP_PART));
    entries.set(
      "_rels/.rels",
      encoder.encode(
        relsXml([
          { id: "rId1", type: REL_TYPE.officeDocument, target: "word/document.xml", external: false },
          { id: "rId2", type: REL_TYPE.coreProperties, target: "docProps/core.xml", external: false },
          { id: "rId3", type: REL_TYPE.extendedProperties, target: "docProps/app.xml", external: false },
        ]),
      ),
    );
  }
  const contentTypes = ensureContentTypes(
    text("[Content_Types].xml") ?? newContentTypes(),
    [...ctx.usedImageTypes].map((kind) => [IMAGE_TYPES[kind]!.ext, IMAGE_TYPES[kind]!.mime] as const),
    addedParts,
  );

  const zip = new JSZip();
  // [Content_Types].xml first, as Office writes it.
  zip.file("[Content_Types].xml", contentTypes, { createFolders: false });
  for (const [name, bytes] of entries) {
    if (name === "[Content_Types].xml") continue;
    // No folder entries: Office writes none, and some readers list them as parts.
    zip.file(name, bytes, { createFolders: false });
  }
  const out = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  if (out.byteLength > DOCUMENT_LIMITS.fileBytes) {
    throw new DocxWriteError(
      "too_large",
      `The document is over the ${DOCUMENT_LIMITS.fileBytes / (1024 * 1024)} MB limit.`,
    );
  }
  return out;
}
