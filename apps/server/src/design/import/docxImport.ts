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

const IMAGE_MIME_BY_EXT: Readonly<Record<string, { readonly mime: string; readonly ext: string }>> = {
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  gif: { mime: "image/gif", ext: "gif" },
  webp: { mime: "image/webp", ext: "webp" },
};

const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;
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
}

function readWordStyles(archive: OoxmlArchive): ParsedStyles {
  const headingLevel = new Map<string, 1 | 2 | 3 | 4 | 5 | 6>();
  const root = archive.readXml("word/styles.xml");
  if (!root) return { headingLevel };

  for (const style of findChildren(root, "style")) {
    const styleId = attrLocal(style, "styleId");
    if (!styleId) continue;
    const nameEl = findChild(style, "name");
    const nameVal = (nameEl ? attrLocal(nameEl, "val") : undefined) ?? styleId;
    const pPr = findChild(style, "pPr");
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
  return { headingLevel };
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
  inlineImages: Array<{ readonly asset: string; readonly alt?: string }>,
  unsupported: Set<string>,
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
      const blips = findDescendants(kid, "blip");
      for (const blip of blips) {
        const embedId = attrLocal(blip, "embed");
        if (!embedId) continue;
        const asset = imageCollector.addFromRel(embedId);
        if (asset) {
          const docPr = findDescendants(kid, "docPr")[0];
          const alt = docPr ? attrLocal(docPr, "descr") ?? attrLocal(docPr, "name") : undefined;
          inlineImages.push({ asset, ...(alt ? { alt } : {}) });
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
  };
}

function extractParagraphRuns(
  pEl: XmlElement,
  rels: ReadonlyMap<string, OoxmlRelationship>,
  imageCollector: ImageCollector,
  inlineImages: Array<{ readonly asset: string; readonly alt?: string }>,
  unsupported: Set<string>,
): { readonly runs: DocxPreviewRun[]; readonly bookmarkId?: string } {
  const runs: DocxPreviewRun[] = [];
  let bookmarkId: string | undefined;

  for (const kid of pEl.children) {
    const name = localName(kid);
    if (name === "bookmarkStart" && bookmarkId === undefined) {
      const bmName = attrLocal(kid, "name");
      if (bmName && !bmName.startsWith("_")) bookmarkId = bmName;
    } else if (name === "r") {
      const parsed = parseRunElement(kid, undefined, imageCollector, inlineImages, unsupported);
      if (parsed) runs.push(parsed);
    } else if (name === "hyperlink") {
      const anchor = attrLocal(kid, "anchor");
      const relId = attrLocal(kid, "id");
      if (!anchor && relId) {
        const rel = rels.get(relId);
        if (rel?.external) unsupported.add("External links (stripped for safety)");
      }
      for (const rKid of findChildren(kid, "r")) {
        const parsed = parseRunElement(rKid, anchor, imageCollector, inlineImages, unsupported);
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

  return { runs, ...(bookmarkId ? { bookmarkId } : {}) };
}

/**
 * Parses a `.docx` binary into a `DesignPreviewDocumentResult`.
 */
export async function readDocxDocument(bytes: Uint8Array): Promise<DesignPreviewDocumentResult> {
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
  let truncated = false;
  let activeList: { ordered: boolean; items: Array<{ readonly runs: DocxPreviewRun[] }> } | null = null;

  const flushList = () => {
    if (activeList && activeList.items.length > 0) {
      blocks.push({ type: "list", ordered: activeList.ordered, items: activeList.items });
    }
    activeList = null;
  };

  for (const childEl of body.children) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    const name = localName(childEl);

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
      const numId = numIdEl ? attrLocal(numIdEl, "val") : undefined;
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

      const inlineImages: Array<{ readonly asset: string; readonly alt?: string }> = [];
      const { runs, bookmarkId } = extractParagraphRuns(
        childEl,
        rels,
        imageCollector,
        inlineImages,
        unsupported,
      );

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
          activeList.items.push({ runs });
        }
      } else {
        flushList();
        if (runs.length > 0) {
          if (headingLevel !== undefined) {
            blocks.push({
              type: "heading",
              level: headingLevel,
              ...(bookmarkId ? { id: bookmarkId } : {}),
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
        });
      }
    } else if (name === "tbl") {
      flushList();
      const rows: Array<{
        readonly cells: ReadonlyArray<{ readonly header?: boolean; readonly runs: DocxPreviewRun[] }>;
      }> = [];
      const trNodes = findChildren(childEl, "tr");
      for (const tr of trNodes) {
        if (rows.length >= MAX_TABLE_ROWS) {
          truncated = true;
          break;
        }
        const trPr = findChild(tr, "trPr");
        const isHeaderRow = findChild(trPr, "tblHeader") !== undefined || rows.length === 0;
        const cells: Array<{ readonly header?: boolean; readonly runs: DocxPreviewRun[] }> = [];
        for (const tc of findChildren(tr, "tc")) {
          if (cells.length >= MAX_TABLE_COLS) break;
          const cellRuns: DocxPreviewRun[] = [];
          const cellImages: Array<{ readonly asset: string; readonly alt?: string }> = [];
          const paragraphs = findChildren(tc, "p");
          for (let pi = 0; pi < paragraphs.length; pi += 1) {
            const { runs } = extractParagraphRuns(
              paragraphs[pi]!,
              rels,
              imageCollector,
              cellImages,
              unsupported,
            );
            if (pi > 0 && cellRuns.length > 0 && runs.length > 0) {
              cellRuns.push({ text: "\n" });
            }
            cellRuns.push(...runs);
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

  return {
    blocks,
    images: imageCollector.images,
    imagesOmitted: imageCollector.omitted,
    truncated,
    unsupportedFeatures: [...unsupported],
  };
}
