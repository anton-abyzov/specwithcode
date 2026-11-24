// @effect-diagnostics nodeBuiltinImport:off - Names pictures by content hash, as DeckPreview does.
/**
 * Read-only Word (.docx) OOXML preview parser.
 * Emits a structured, zero-raw-HTML AST (`DocxPreviewBlock[]`) with bounded
 * raster images (`data:` URLs), fragment-only internal links (external links
 * stripped), and explicit disclosure of unsupported Word features.
 */
import * as NodeCrypto from "node:crypto";

import {
  DESIGN_DECK_PREVIEW_IMAGE_BYTES,
  type DesignPreviewDocumentResult,
  type DocxPreviewBlock,
  type DocxPreviewRun,
} from "@specweave-studio/contracts";

import {
  assertNoMacros,
  DEFAULT_OOXML_LIMITS,
  openOoxmlArchive,
  OoxmlPreviewError,
  readRelationships,
  resolveOoxmlTarget,
  type OoxmlArchive,
  type OoxmlRelationship,
} from "./ooxmlZip.ts";
import { localName, type XmlElement } from "./xml.ts";

const MAX_BLOCKS = 4_000;
const MAX_TABLE_ROWS = 400;
const MAX_TABLE_COLS = 40;
const MAX_RUN_CHARS = 32_000;
const MAX_PARAGRAPH_BOOKMARKS = 16;

const IMAGE_MIME_BY_EXT: Readonly<Record<string, { readonly mime: string; readonly ext: string }>> = {
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  gif: { mime: "image/gif", ext: "gif" },
  webp: { mime: "image/webp", ext: "webp" },
};

const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;
/** Links an editing read keeps; anything else (javascript:, file:, data:) stays stripped. */
const SAFE_HREF_RE = /^(https?:\/\/|mailto:)[^\s<>"]{1,2040}$/i;
const EMU_PER_PIXEL = 9525;

type InlineImage = {
  readonly asset: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
};

/** Pixel size of a drawing from its `wp:extent`, when it gives one. */
function drawingSize(drawing: XmlElement): { width?: number; height?: number } {
  const extent = findDescendants(drawing, "extent")[0];
  if (!extent) return {};
  const cx = Number(attrLocal(extent, "cx"));
  const cy = Number(attrLocal(extent, "cy"));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) return {};
  const width = Math.min(20_000, Math.max(1, Math.round(cx / EMU_PER_PIXEL)));
  const height = Math.min(20_000, Math.max(1, Math.round(cy / EMU_PER_PIXEL)));
  return { width, height };
}
const MONO_FONT_RE = /(courier|consolas|menlo|monaco|fira\s*code|jetbrains|source\s*code|mono)/i;

function findChild(el: XmlElement | undefined, local: string): XmlElement | undefined {
  return el?.children.find((kid) => localName(kid) === local);
}

function findChildren(el: XmlElement | undefined, local: string): XmlElement[] {
  return el?.children.filter((kid) => localName(kid) === local) ?? [];
}

function findDescendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const kid of node.children) {
      if (localName(kid) === local) out.push(kid);
      visit(kid);
    }
  };
  visit(el);
  return out;
}

function attrLocal(el: XmlElement, local: string): string | undefined {
  if (Object.hasOwn(el.attrs, local)) return el.attrs[local];
  const suffix = `:${local}`;
  for (const [k, v] of Object.entries(el.attrs)) {
    if (k.endsWith(suffix)) return v;
  }
  return undefined;
}

function isOn(el: XmlElement | undefined): boolean {
  if (!el) return false;
  const val = attrLocal(el, "val");
  return val === undefined || (val !== "0" && val !== "false" && val !== "none");
}

interface ParsedStyles {
  readonly headingLevel: ReadonlyMap<string, 1 | 2 | 3 | 4 | 5 | 6>;
  /** The list a paragraph style puts its paragraphs in ("List Bullet"), by style id. */
  readonly listNumId: ReadonlyMap<string, string>;
}

function readWordStyles(archive: OoxmlArchive): ParsedStyles {
  const headingLevel = new Map<string, 1 | 2 | 3 | 4 | 5 | 6>();
  const listNumId = new Map<string, string>();
  const basedOn = new Map<string, string>();
  const root = archive.readXml("word/styles.xml");
  if (!root) return { headingLevel, listNumId };

  for (const style of findChildren(root, "style")) {
    const styleId = attrLocal(style, "styleId");
    if (!styleId) continue;
    const nameEl = findChild(style, "name");
    const nameVal = (nameEl ? attrLocal(nameEl, "val") : undefined) ?? styleId;
    const pPr = findChild(style, "pPr");
    const styleNumId = findChild(findChild(pPr, "numPr"), "numId");
    const styleNumVal = styleNumId ? attrLocal(styleNumId, "val") : undefined;
    if (styleNumVal) listNumId.set(styleId, styleNumVal);
    const parent = findChild(style, "basedOn");
    const parentId = parent ? attrLocal(parent, "val") : undefined;
    if (parentId) basedOn.set(styleId, parentId);
    const outlineEl = findChild(pPr, "outlineLvl");
    const outlineVal = outlineEl ? Number(attrLocal(outlineEl, "val")) : Number.NaN;

    if (Number.isInteger(outlineVal) && outlineVal >= 0 && outlineVal <= 5) {
      headingLevel.set(styleId, (outlineVal + 1) as 1 | 2 | 3 | 4 | 5 | 6);
      continue;
    }
    const headingMatch = /^heading\s*([1-6])$/i.exec(nameVal) ?? /^Heading([1-6])$/i.exec(styleId);
    if (headingMatch) {
      headingLevel.set(styleId, Number(headingMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6);
    } else if (/^title$/i.test(nameVal) || /^title$/i.test(styleId)) {
      headingLevel.set(styleId, 1);
    } else if (/^subtitle$/i.test(nameVal) || /^subtitle$/i.test(styleId)) {
      headingLevel.set(styleId, 2);
    }
  }
  // A style without its own list takes its parent's ("List Bullet 2" from "List Bullet").
  for (const styleId of basedOn.keys()) {
    let at: string | undefined = styleId;
    for (let depth = 0; depth < 8 && at !== undefined && !listNumId.has(styleId); depth += 1) {
      at = basedOn.get(at);
      const inherited = at === undefined ? undefined : listNumId.get(at);
      if (inherited !== undefined) listNumId.set(styleId, inherited);
    }
  }
  return { headingLevel, listNumId };
}

/** Returns a set of `numId` strings that are ordered (decimal/roman/letter) lists. */
function readOrderedNumIds(archive: OoxmlArchive): ReadonlySet<string> {
  const ordered = new Set<string>();
  const root = archive.readXml("word/numbering.xml");
  if (!root) return ordered;

  const abstractOrdered = new Map<string, boolean>();
  for (const abs of findChildren(root, "abstractNum")) {
    const absId = attrLocal(abs, "abstractNumId");
    if (!absId) continue;
    const lvl0 = findChildren(abs, "lvl").find((l) => attrLocal(l, "ilvl") === "0") ?? findChild(abs, "lvl");
    const numFmt = findChild(lvl0, "numFmt");
    const fmt = (numFmt ? attrLocal(numFmt, "val") : undefined)?.toLowerCase() ?? "bullet";
    abstractOrdered.set(absId, fmt !== "bullet" && fmt !== "none");
  }

  for (const num of findChildren(root, "num")) {
    const numId = attrLocal(num, "numId");
    const absRef = findChild(num, "abstractNumId");
    const absId = absRef ? attrLocal(absRef, "val") : undefined;
    if (numId && absId && abstractOrdered.get(absId) === true) {
      ordered.add(numId);
    }
  }
  return ordered;
}

interface ImageCollector {
  readonly images: Record<string, string>;
  usedBytes: number;
  omitted: number;
  addFromRel: (relId: string) => string | null;
}

function makeImageCollector(
  archive: OoxmlArchive,
  rels: ReadonlyMap<string, OoxmlRelationship>,
  budget: number,
): ImageCollector {
  const images: Record<string, string> = {};
  const byRel = new Map<string, string | null>();
  const collector: ImageCollector = {
    images,
    usedBytes: 0,
    omitted: 0,
    addFromRel: (relId: string) => {
      if (byRel.has(relId)) return byRel.get(relId) ?? null;
      const rel = rels.get(relId);
      if (!rel || rel.external) {
        byRel.set(relId, null);
        return null;
      }
      const partPath = resolveOoxmlTarget("word/document.xml", rel.target);
      if (!partPath) {
        byRel.set(relId, null);
        return null;
      }
      const ext = partPath.split(".").pop()?.toLowerCase() ?? "";
      const spec = IMAGE_MIME_BY_EXT[ext];
      const bytes = archive.entries.get(partPath);
      if (!spec || !bytes) {
        byRel.set(relId, null);
        return null;
      }
      if (collector.usedBytes + bytes.byteLength > budget) {
        collector.omitted += 1;
        byRel.set(relId, null);
        return null;
      }
      collector.usedBytes += bytes.byteLength;
      const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      const asset = `${hash}.${spec.ext}`;
      images[asset] ??= `data:${spec.mime};base64,${Buffer.from(bytes).toString("base64")}`;
      byRel.set(relId, asset);
      return asset;
    },
  };
  return collector;
}

function parseRunElement(
  runEl: XmlElement,
  anchor: string | undefined,
  imageCollector: ImageCollector,
  inlineImages: Array<InlineImage>,
  unsupported: Set<string>,
  href?: string,
): DocxPreviewRun | null {
  const rPr = findChild(runEl, "rPr");
  const bold = isOn(findChild(rPr, "b"));
  const italic = isOn(findChild(rPr, "i"));
  const underline = isOn(findChild(rPr, "u"));
  const strike = isOn(findChild(rPr, "strike")) || isOn(findChild(rPr, "dstrike"));
  const rFonts = findChild(rPr, "rFonts");
  const fontName =
    (rFonts ? attrLocal(rFonts, "ascii") ?? attrLocal(rFonts, "hAnsi") : undefined) ?? "";
  const code = MONO_FONT_RE.test(fontName);
  const colorEl = findChild(rPr, "color");
  const rawColor = colorEl ? attrLocal(colorEl, "val") : undefined;
  const color = rawColor && HEX_COLOR_RE.test(rawColor) ? `#${rawColor}` : undefined;

  let text = "";
  for (const kid of runEl.children) {
    const name = localName(kid);
    if (name === "t") {
      text += kid.text;
    } else if (name === "tab") {
      text += "\t";
    } else if (name === "br" || name === "cr") {
      text += "\n";
    } else if (name === "drawing" || name === "pict") {
      if (findDescendants(kid, "chart").length > 0) {
        unsupported.add("Embedded charts");
      }
      if (findDescendants(kid, "txbxContent").length > 0) {
        unsupported.add("Text boxes / SmartArt");
      }
      const docPr = findDescendants(kid, "docPr")[0];
      const alt = docPr ? attrLocal(docPr, "descr") ?? attrLocal(docPr, "name") : undefined;
      const size = drawingSize(kid);
      const blips = findDescendants(kid, "blip");
      for (const blip of blips) {
        if (inlineImages.length >= 200) {
          unsupported.add("Excess inline images");
          break;
        }
        const embedId = attrLocal(blip, "embed");
        if (!embedId) continue;
        const asset = imageCollector.addFromRel(embedId);
        if (asset) {
          inlineImages.push({ asset, ...(alt ? { alt } : {}), ...size });
        }
      }
    }
  }

  if (text.length === 0) return null;
  const clamped = text.length > MAX_RUN_CHARS ? `${text.slice(0, MAX_RUN_CHARS - 1)}…` : text;
  return {
    text: clamped,
    ...(bold ? { bold: true } : {}),
    ...(italic ? { italic: true } : {}),
    ...(underline ? { underline: true } : {}),
    ...(strike ? { strike: true } : {}),
    ...(code ? { code: true } : {}),
    ...(color ? { color } : {}),
    ...(anchor ? { anchor } : {}),
    ...(href ? { href } : {}),
  };
}

const MAX_SDT_DEPTH = 16;
const MAX_NESTED_TABLE_DEPTH = 4;

function unwrapSdtChildren(
  children: readonly XmlElement[],
  unsupported: Set<string>,
  depth = 0,
): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of children) {
    if (localName(child) === "sdt") {
      if (depth >= MAX_SDT_DEPTH) {
        unsupported.add("Deeply nested content controls (omitted)");
        continue;
      }
      const content = findChild(child, "sdtContent");
      if (content) {
        out.push(...unwrapSdtChildren(content.children, unsupported, depth + 1));
      }
    } else {
      out.push(child);
    }
  }
  return out;
}

function extractNestedTableRuns(
  tblEl: XmlElement,
  rels: ReadonlyMap<string, OoxmlRelationship>,
  imageCollector: ImageCollector,
  cellImages: Array<InlineImage>,
  unsupported: Set<string>,
  depth = 1,
): DocxPreviewRun[] {
  if (depth > MAX_NESTED_TABLE_DEPTH) {
    unsupported.add("Deeply nested tables (omitted)");
    return [];
  }
  unsupported.add("Nested tables (flattened into cell text)");
  const runs: DocxPreviewRun[] = [];
  const trNodes = unwrapSdtChildren(tblEl.children, unsupported).filter((el) => localName(el) === "tr");
  for (const tr of trNodes) {
    const rowRuns: DocxPreviewRun[] = [];
    for (const tc of unwrapSdtChildren(tr.children, unsupported).filter((el) => localName(el) === "tc")) {
      const innerRuns: DocxPreviewRun[] = [];
      for (const kid of unwrapSdtChildren(tc.children, unsupported)) {
        const kidName = localName(kid);
        if (kidName === "p") {
          const { runs: pRuns } = extractParagraphRuns(kid, rels, imageCollector, cellImages, unsupported);
          if (innerRuns.length > 0 && pRuns.length > 0) innerRuns.push({ text: " " });
          innerRuns.push(...pRuns);
        } else if (kidName === "tbl") {
          const nested = extractNestedTableRuns(kid, rels, imageCollector, cellImages, unsupported, depth + 1);
          if (innerRuns.length > 0 && nested.length > 0) innerRuns.push({ text: "\n" });
          innerRuns.push(...nested);
        }
      }
      if (rowRuns.length > 0 && innerRuns.length > 0) rowRuns.push({ text: " | " });
      rowRuns.push(...innerRuns);
    }
    if (runs.length > 0 && rowRuns.length > 0) runs.push({ text: "\n" });
    runs.push(...rowRuns);
  }
  return runs;
}

function extractParagraphRuns(
  pEl: XmlElement,
  rels: ReadonlyMap<string, OoxmlRelationship>,
  imageCollector: ImageCollector,
  inlineImages: Array<InlineImage>,
  unsupported: Set<string>,
  editing = false,
): { readonly runs: DocxPreviewRun[]; readonly bookmarks: string[] } {
  const runs: DocxPreviewRun[] = [];
  const bookmarks: string[] = [];

  for (const kid of unwrapSdtChildren(pEl.children, unsupported)) {
    const name = localName(kid);
    if (name === "bookmarkStart") {
      // `_Toc` and `_Ref` names are the targets of a table of contents and of
      // cross-references, so they are kept; `_GoBack` is only Word's last cursor.
      const bmName = attrLocal(kid, "name");
      if (bmName && bmName !== "_GoBack" && bookmarks.length < MAX_PARAGRAPH_BOOKMARKS) {
        bookmarks.push(bmName);
      }
    } else if (name === "r") {
      const parsed = parseRunElement(kid, undefined, imageCollector, inlineImages, unsupported);
      if (parsed) runs.push(parsed);
    } else if (name === "hyperlink") {
      const anchor = attrLocal(kid, "anchor");
      const relId = attrLocal(kid, "id");
      let href: string | undefined;
      if (!anchor && relId) {
        const rel = rels.get(relId);
        if (rel?.external && editing && SAFE_HREF_RE.test(rel.target)) href = rel.target;
        else if (rel?.external) unsupported.add("External links (stripped for safety)");
      }
      for (const rKid of findChildren(kid, "r")) {
        const parsed = parseRunElement(
          rKid,
          anchor,
          imageCollector,
          inlineImages,
          unsupported,
          href,
        );
        if (parsed) runs.push(parsed);
      }
    } else if (name === "ins" || name === "del") {
      unsupported.add("Track changes");
      if (name === "ins") {
        for (const rKid of findChildren(kid, "r")) {
          const parsed = parseRunElement(rKid, undefined, imageCollector, inlineImages, unsupported);
          if (parsed) runs.push(parsed);
        }
      }
    } else if (name === "commentRangeStart" || name === "commentReference") {
      unsupported.add("Comments");
    }
  }

  return { runs, bookmarks };
}

/**
 * Point every link at the one name its target paragraph is shown under. A link
 * whose target the preview does not show (a bookmark past the cap, or one on a
 * list item or inside a table) becomes plain text. Returns true when any did.
 */
function resolveAnchors(
  blocks: ReadonlyArray<DocxPreviewBlock>,
  shownAs: ReadonlyMap<string, string>,
): boolean {
  const targets = new Set<string>();
  for (const block of blocks) {
    if ((block.type === "heading" || block.type === "paragraph") && block.id !== undefined) {
      targets.add(block.id);
    }
  }
  let dropped = false;
  const fix = (runs: ReadonlyArray<DocxPreviewRun>): void => {
    for (const run of runs) {
      if (run.anchor === undefined) continue;
      const shown = shownAs.get(run.anchor) ?? run.anchor;
      if (targets.has(shown)) {
        (run as { anchor?: string }).anchor = shown;
      } else {
        delete (run as { anchor?: string }).anchor;
        dropped = true;
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") fix(block.runs);
    else if (block.type === "list") for (const item of block.items) fix(item.runs);
    else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) fix(cell.runs);
    }
  }
  return dropped;
}

/**
 * Parses a `.docx` binary into a `DesignPreviewDocumentResult`.
 */
export async function readDocxDocument(
  bytes: Uint8Array,
  options: {
    /**
     * Read for the editor: keep safe external links (`href`), list levels and
     * picture sizes. A preview leaves external links out.
     */
    readonly forEditing?: boolean;
  } = {},
): Promise<DesignPreviewDocumentResult> {
  const editing = options.forEditing === true;
  const archive = await openOoxmlArchive(bytes, DEFAULT_OOXML_LIMITS);
  assertNoMacros(archive);

  const documentXml = archive.readXml("word/document.xml");
  const body = findChild(documentXml ?? undefined, "body");
  if (!body) {
    throw new OoxmlPreviewError("invalid", "The file is not a valid Word document (.docx).");
  }

  const rels = readRelationships(archive, "word/_rels/document.xml.rels");
  const styles = readWordStyles(archive);
  const orderedNumIds = readOrderedNumIds(archive);
  const imageCollector = makeImageCollector(archive, rels, DESIGN_DECK_PREVIEW_IMAGE_BYTES);
  const unsupported = new Set<string>();

  for (const partPath of archive.entries.keys()) {
    if (/^word\/comments\.xml$/i.test(partPath)) unsupported.add("Comments");
    if (/^word\/(footnotes|endnotes)\.xml$/i.test(partPath)) unsupported.add("Footnotes/endnotes");
    if (/^word\/(header|footer)\d+\.xml$/i.test(partPath)) unsupported.add("Headers/footers");
    if (/^word\/charts\//i.test(partPath)) unsupported.add("Embedded charts");
    if (/^word\/diagrams\//i.test(partPath)) unsupported.add("Text boxes / SmartArt");
  }

  const blocks: DocxPreviewBlock[] = [];
  // A paragraph can carry several bookmarks and shows under the first; the
  // others are remembered so a link to any of them finds the paragraph.
  const shownAs = new Map<string, string>();
  let looseBookmarks: string[] = [];
  let truncated = false;
  let activeList: {
    ordered: boolean;
    items: Array<{ readonly runs: DocxPreviewRun[]; readonly level?: number }>;
  } | null = null;

  const flushList = () => {
    if (activeList && activeList.items.length > 0) {
      blocks.push({ type: "list", ordered: activeList.ordered, items: activeList.items });
    }
    activeList = null;
  };

  for (const childEl of unwrapSdtChildren(body.children, unsupported)) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    const name = localName(childEl);

    if (name === "bookmarkStart") {
      // A bookmark between paragraphs marks the paragraph after it.
      const bmName = attrLocal(childEl, "name");
      if (bmName && bmName !== "_GoBack" && looseBookmarks.length < MAX_PARAGRAPH_BOOKMARKS) {
        looseBookmarks.push(bmName);
      }
      continue;
    }

    if (name === "p") {
      const pPr = findChild(childEl, "pPr");
      const pStyleEl = findChild(pPr, "pStyle");
      const styleId = pStyleEl ? attrLocal(pStyleEl, "val") : undefined;
      let headingLevel = styleId ? styles.headingLevel.get(styleId) : undefined;
      if (headingLevel === undefined && styleId) {
        const builtIn = /^heading\s*([1-6])$/i.exec(styleId);
        if (builtIn) {
          headingLevel = Number(builtIn[1]) as 1 | 2 | 3 | 4 | 5 | 6;
        } else if (/^title$/i.test(styleId)) {
          headingLevel = 1;
        } else if (/^subtitle$/i.test(styleId)) {
          headingLevel = 2;
        }
      }
      const numPr = findChild(pPr, "numPr");
      const numIdEl = findChild(numPr, "numId");
      const ilvlEl = findChild(numPr, "ilvl");
      const ilvl = ilvlEl ? Number(attrLocal(ilvlEl, "val")) : 0;
      const listLevel = Number.isInteger(ilvl) && ilvl > 0 && ilvl <= 8 ? ilvl : 0;
      const numId =
        (numIdEl ? attrLocal(numIdEl, "val") : undefined) ??
        (styleId ? styles.listNumId.get(styleId) : undefined);
      const jcEl = findChild(pPr, "jc");
      const jc = jcEl ? attrLocal(jcEl, "val") : undefined;
      const align =
        jc === "left" || jc === "center" || jc === "right"
          ? jc
          : jc === "both"
            ? "justify"
            : undefined;
      const pBdr = findChild(pPr, "pBdr");
      const hasBottomRule = pBdr !== undefined && findChild(pBdr, "bottom") !== undefined;

      const inlineImages: Array<InlineImage> = [];
      const { runs, bookmarks } = extractParagraphRuns(
        childEl,
        rels,
        imageCollector,
        inlineImages,
        unsupported,
        editing,
      );
      const names = [...looseBookmarks, ...bookmarks];
      const listed = numId !== undefined && numId !== "0" && headingLevel === undefined;
      // Only a heading or a paragraph with text is shown under a name.
      const bookmarkId = runs.length > 0 && !listed ? names[0] : undefined;
      if (bookmarkId !== undefined) {
        looseBookmarks = [];
        for (const other of names) if (!shownAs.has(other)) shownAs.set(other, bookmarkId);
      }

      if (runs.length === 0 && inlineImages.length === 0) {
        if (hasBottomRule) {
          flushList();
          blocks.push({ type: "divider" });
        }
        continue;
      }

      if (numId && numId !== "0" && headingLevel === undefined) {
        const ordered = orderedNumIds.has(numId);
        if (!activeList || activeList.ordered !== ordered) {
          flushList();
          activeList = { ordered, items: [] };
        }
        if (runs.length > 0) {
          activeList.items.push({ runs, ...(listLevel > 0 ? { level: listLevel } : {}) });
        }
      } else {
        flushList();
        if (runs.length > 0) {
          if (headingLevel !== undefined) {
            blocks.push({
              type: "heading",
              level: headingLevel,
              ...(bookmarkId ? { id: bookmarkId } : {}),
              ...(align ? { align } : {}),
              runs,
            });
          } else {
            blocks.push({
              type: "paragraph",
              ...(bookmarkId ? { id: bookmarkId } : {}),
              ...(align ? { align } : {}),
              runs,
            });
          }
        }
      }

      for (const img of inlineImages) {
        if (blocks.length >= MAX_BLOCKS) {
          truncated = true;
          break;
        }
        flushList();
        blocks.push({
          type: "image",
          asset: img.asset,
          ...(img.alt ? { alt: img.alt } : {}),
          ...(img.width !== undefined && img.height !== undefined
            ? { width: img.width, height: img.height }
            : {}),
          ...(align ? { align } : {}),
        });
      }
    } else if (name === "tbl") {
      flushList();
      const rows: Array<{
        readonly cells: ReadonlyArray<{ readonly header?: boolean; readonly runs: DocxPreviewRun[] }>;
      }> = [];
      const trNodes = unwrapSdtChildren(childEl.children, unsupported).filter((el) => localName(el) === "tr");
      for (const tr of trNodes) {
        if (rows.length >= MAX_TABLE_ROWS) {
          truncated = true;
          break;
        }
        const trPr = findChild(tr, "trPr");
        // A preview shows the first row as a header; the editor only the rows Word repeats.
        const isHeaderRow =
          findChild(trPr, "tblHeader") !== undefined || (!editing && rows.length === 0);
        const cells: Array<{ readonly header?: boolean; readonly runs: DocxPreviewRun[] }> = [];
        for (const tc of unwrapSdtChildren(tr.children, unsupported).filter((el) => localName(el) === "tc")) {
          if (cells.length >= MAX_TABLE_COLS) {
            truncated = true;
            break;
          }
          const cellRuns: DocxPreviewRun[] = [];
          const cellImages: Array<InlineImage> = [];
          for (const tcKid of unwrapSdtChildren(tc.children, unsupported)) {
            const tcKidName = localName(tcKid);
            if (tcKidName === "p") {
              const { runs } = extractParagraphRuns(
                tcKid,
                rels,
                imageCollector,
                cellImages,
                unsupported,
                editing,
              );
              if (cellRuns.length > 0 && runs.length > 0) {
                cellRuns.push({ text: "\n" });
              }
              cellRuns.push(...runs);
            } else if (tcKidName === "tbl") {
              const nestedRuns = extractNestedTableRuns(
                tcKid,
                rels,
                imageCollector,
                cellImages,
                unsupported,
              );
              if (cellRuns.length > 0 && nestedRuns.length > 0) {
                cellRuns.push({ text: "\n" });
              }
              cellRuns.push(...nestedRuns);
            }
          }
          if (cellImages.length > 0) {
            unsupported.add("Images inside tables");
          }
          cells.push({
            ...(isHeaderRow ? { header: true } : {}),
            runs: cellRuns,
          });
        }
        if (cells.length > 0) rows.push({ cells });
      }
      if (rows.length > 0) {
        blocks.push({ type: "table", rows });
      }
    }
  }

  flushList();
  if (resolveAnchors(blocks, shownAs)) {
    unsupported.add("Links to places the preview does not show (shown as text)");
  }

  return {
    blocks,
    images: imageCollector.images,
    imagesOmitted: imageCollector.omitted,
    truncated,
    unsupportedFeatures: [...unsupported],
  };
}
