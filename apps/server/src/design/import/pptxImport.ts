/**
 * PowerPoint import: reads a .pptx and plans the pages of a slides document.
 * It mirrors the exporter (`../export/pptx.ts`) in reverse: a slide is a
 * 1920 x 1080 frame, text bodies become text nodes, simple preset shapes
 * become shapes, pictures become images (stored later through the design
 * asset store) and the notes slide becomes the page's speaker notes. Slides
 * follow presentation.xml. Pictures keep their crop and transparency, and
 * come from picture placeholders, picture-filled rectangles, groups, the
 * slide background (or its layout's or master's) and the layout and master
 * themselves. Whatever cannot be kept (charts, tables, SmartArt, media,
 * freeform or other preset shapes) is listed for each slide.
 *
 * The reader is defensive: only real .pptx decks (no macros), bounded zip
 * sizes and entry counts, paths that stay inside the archive, and XML without
 * a DOCTYPE or ENTITY, within bounded part sizes, element counts and depth.
 */
import {
  DESIGN_DECK_IMPORT_MAX_BYTES,
  DESIGN_MAX_PAGES,
  type DesignNode,
} from "@specweave-studio/contracts";
import * as Yauzl from "yauzl";

import { MAX_ASSET_BYTES } from "../DesignStore.ts";
import { imagePixelSize } from "../export/imageSize.ts";
import {
  child,
  childrenNamed,
  descendants,
  parseXml,
  path,
  XML_LIMITS,
  XmlRefused,
  type XmlBudget,
  type XmlElement,
} from "./xml.ts";

/** What the import accepts; the file, slide and picture limits are the ones the app enforces. */
export const PPTX_IMPORT_LIMITS = {
  fileBytes: DESIGN_DECK_IMPORT_MAX_BYTES,
  entries: 2_000,
  unpackedBytes: 200 * 1024 * 1024,
  /** A slides document holds at most this many pages. */
  slides: DESIGN_MAX_PAGES,
  /** The design asset store refuses larger pictures, so they are not read. */
  imageBytes: MAX_ASSET_BYTES,
  /** Bytes of one XML part; each part is also bounded by `XML_LIMITS`. */
  xmlPartBytes: XML_LIMITS.partChars,
  /** XML elements across every part the import reads. */
  xmlElements: 1_000_000,
} as const;

const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;
/** One point is 12,700 EMU. */
const EMU_PER_POINT = 12_700;
/** PowerPoint's slide side, 1 to 56 inches (ECMA-376 `ST_SlideSizeCoordinate`). */
const SLIDE_SIDE_EMU = { min: 914_400, max: 51_206_400 } as const;
/** The node coordinate and size bound of the design contract. */
const MAX_COORDINATE = 1_000_000;
/** Nodes kept per slide; the page holds 5,000 including the frame. */
const MAX_NODES_PER_SLIDE = 4_000;
const MAX_TEXT = 100_000;

const PRESENTATION_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDESHOW_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml";
const MACRO_TYPE = /macroenabled|vbaproject|activex|vnd\.ms-office\.vba/i;

/** Bytes as whole megabytes for a sentence ("10 MB"). */
export const megabytes = (bytes: number) => `${Math.floor(bytes / (1024 * 1024))} MB`;

/** A refusal or failure with a plain sentence for the person importing. */
export class PptxImportError extends Error {
  readonly code: "invalid" | "too_large";
  constructor(code: "invalid" | "too_large", message: string) {
    super(message);
    this.code = code;
  }
}

export type ImportedNode =
  | { readonly kind: "node"; readonly node: DesignNode }
  | {
      readonly kind: "image";
      readonly node: DesignNode & { readonly type: "image" };
      readonly media: string;
    };

export interface ImportedSlide {
  readonly name: string;
  /** The slide frame's id; every node's parent. */
  readonly frameId: string;
  readonly background: string | undefined;
  readonly nodes: ReadonlyArray<ImportedNode>;
  readonly notes: string | undefined;
  readonly skipped: boolean;
  readonly notImported: ReadonlyArray<string>;
}

export interface ImportedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml";
}

export interface ImportedDeck {
  readonly slides: ReadonlyArray<ImportedSlide>;
  /** Pictures by archive path, for image nodes' `media`. */
  readonly media: ReadonlyMap<string, ImportedMedia>;
}

const IMAGE_TYPES: ReadonlyMap<string, ImportedMedia["mimeType"]> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
]);

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const unsafeEntryName = (name: string) =>
  name.startsWith("/") ||
  name.includes("\\") ||
  /^[A-Za-z]:/.test(name) ||
  name.split("/").some((part) => part === "..");

export interface ZipEntries {
  /** Every file the import reads, by name. */
  readonly files: Map<string, Buffer>;
  /** XML parts left unread because they are over `xmlPartBytes`. */
  readonly oversized: Set<string>;
}

/** Every file of the archive the import reads, within the import limits. */
export function readZipEntries(bytes: Uint8Array): Promise<ZipEntries> {
  if (bytes.byteLength > PPTX_IMPORT_LIMITS.fileBytes) {
    return Promise.reject(
      new PptxImportError(
        "too_large",
        `The file is larger than ${megabytes(PPTX_IMPORT_LIMITS.fileBytes)}, the import limit.`,
      ),
    );
  }
  const notZip = new PptxImportError("invalid", "The file is not a PowerPoint deck (.pptx).");
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return Promise.reject(notZip);
  return new Promise((resolve, reject) => {
    Yauzl.fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      { lazyEntries: true, decodeStrings: false, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null || zip === undefined) return reject(notZip);
        if (zip.entryCount > PPTX_IMPORT_LIMITS.entries) {
          zip.close();
          return reject(
            new PptxImportError(
              "too_large",
              `The deck has ${zip.entryCount} files inside; the limit is ${PPTX_IMPORT_LIMITS.entries}.`,
            ),
          );
        }
        const entries = new Map<string, Buffer>();
        const oversized = new Set<string>();
        let unpacked = 0;
        let failed = false;
        const fail = (problem: Error) => {
          if (failed) return;
          failed = true;
          zip.close();
          reject(problem);
        };
        zip.on("error", () => fail(notZip));
        zip.on("end", () => {
          if (!failed) resolve({ files: entries, oversized });
        });
        zip.on("entry", (entry: Yauzl.Entry) => {
          const name = Buffer.isBuffer(entry.fileName)
            ? (entry.fileName as Buffer).toString("utf8")
            : String(entry.fileName);
          if (unsafeEntryName(name)) {
            return fail(
              new PptxImportError("invalid", "The deck has a file path that leaves the archive."),
            );
          }
          if (name.endsWith("/")) return zip.readEntry();
          unpacked += entry.uncompressedSize;
          if (unpacked > PPTX_IMPORT_LIMITS.unpackedBytes) {
            return fail(
              new PptxImportError(
                "too_large",
                "The deck unpacks to more than 200 MB, the import limit.",
              ),
            );
          }
          const isMedia = name.startsWith("ppt/media/");
          if (isMedia && entry.uncompressedSize > PPTX_IMPORT_LIMITS.imageBytes) {
            // Too large to keep; the slide lists it as not imported.
            return zip.readEntry();
          }
          if (!isMedia && !name.endsWith(".xml") && !name.endsWith(".rels")) {
            return zip.readEntry();
          }
          if (!isMedia && entry.uncompressedSize > PPTX_IMPORT_LIMITS.xmlPartBytes) {
            // Refused only if the import needs this part.
            oversized.add(name);
            return zip.readEntry();
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError !== null || stream === undefined) return fail(notZip);
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("error", () => fail(notZip));
            stream.on("end", () => {
              entries.set(name, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Parts and relationships
// ---------------------------------------------------------------------------

interface Parts {
  readonly entries: ReadonlyMap<string, Buffer>;
  readonly xml: (name: string) => XmlElement | undefined;
  /** Relationship id to archive path, for the part at `name`. */
  readonly rels: (
    name: string,
  ) => ReadonlyMap<string, { readonly type: string; readonly target: string }>;
}

const resolvePartPath = (from: string, target: string) => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
};

function makeParts({ files: entries, oversized }: ZipEntries): Parts {
  const cache = new Map<string, XmlElement | undefined>();
  const budget: XmlBudget = { elements: PPTX_IMPORT_LIMITS.xmlElements, used: 0 };
  const xml = (name: string) => {
    if (cache.has(name)) return cache.get(name);
    if (oversized.has(name)) {
      throw new PptxImportError(
        "too_large",
        `The deck part ${name} is larger than 16 MB, the import limit.`,
      );
    }
    const bytes = entries.get(name);
    let parsed: XmlElement | undefined;
    if (bytes !== undefined) {
      try {
        parsed = parseXml(bytes.toString("utf8"), budget);
      } catch (error) {
        if (error instanceof XmlRefused) {
          throw new PptxImportError(error.tooLarge ? "too_large" : "invalid", error.message);
        }
        throw new PptxImportError("invalid", `The deck part ${name} is not readable XML.`);
      }
    }
    cache.set(name, parsed);
    return parsed;
  };
  const rels = (name: string) => {
    const slash = name.lastIndexOf("/");
    const relsName = `${name.slice(0, slash + 1)}_rels/${name.slice(slash + 1)}.rels`;
    const out = new Map<string, { type: string; target: string }>();
    for (const rel of childrenNamed(xml(relsName), "Relationship")) {
      const id = rel.attrs.Id;
      const target = rel.attrs.Target;
      if (id === undefined || target === undefined || rel.attrs.TargetMode === "External") continue;
      out.set(id, { type: rel.attrs.Type ?? "", target: resolvePartPath(name, target) });
    }
    return out;
  };
  return { entries, xml, rels };
}

function checkContentTypes(parts: Parts) {
  const types = parts.xml("[Content_Types].xml");
  if (types === undefined) {
    throw new PptxImportError("invalid", "The file is not a PowerPoint deck (.pptx).");
  }
  const all = types.children.map((entry) => entry.attrs.ContentType ?? "");
  if (
    all.some((type) => MACRO_TYPE.test(type)) ||
    [...parts.entries.keys()].some((name) => /vbaProject/i.test(name))
  ) {
    throw new PptxImportError(
      "invalid",
      "The deck contains macros (.pptm). Save it as a .pptx without macros and import that.",
    );
  }
  const main = childrenNamed(types, "Override").find(
    (entry) => entry.attrs.PartName === "/ppt/presentation.xml",
  )?.attrs.ContentType;
  if (main !== PRESENTATION_MAIN && main !== SLIDESHOW_MAIN) {
    throw new PptxImportError(
      "invalid",
      "The file is not a PowerPoint presentation the import knows (.pptx).",
    );
  }
}

// ---------------------------------------------------------------------------
// Geometry, color and text
// ---------------------------------------------------------------------------

interface Transform {
  /** Pixels per EMU and the slide offset, after groups are applied. */
  readonly kx: number;
  readonly ky: number;
  readonly dx: number;
  readonly dy: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number | undefined;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

const num = (value: string | undefined, fallback = 0) => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Two decimals; `+ 0` turns -0 into 0. */
const round = (value: number) => Math.round(value * 100) / 100 + 0;

/**
 * A position or a length within the contract's bounds, so a hostile offset,
 * group scale or line width cannot make the slide fail to save.
 */
const coordinate = (value: number) =>
  Number.isNaN(value) ? 0 : round(Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value)));
const length = (value: number) =>
  Number.isNaN(value) ? 0 : round(Math.max(0, Math.min(MAX_COORDINATE, value)));

function boxOf(xfrm: XmlElement | undefined, transform: Transform): Box | undefined {
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  if (off === undefined || ext === undefined) return undefined;
  const rot = num(xfrm?.attrs.rot) / 60_000;
  return {
    x: coordinate(transform.dx + num(off.attrs.x) * transform.kx),
    y: coordinate(transform.dy + num(off.attrs.y) * transform.ky),
    width: length(num(ext.attrs.cx) * transform.kx),
    height: length(num(ext.attrs.cy) * transform.ky),
    rotation: rot === 0 ? undefined : Math.max(-360, Math.min(360, rot > 180 ? rot - 360 : rot)),
    flipH: xfrm?.attrs.flipH === "1",
    flipV: xfrm?.attrs.flipV === "1",
  };
}

/** A literal color of a fill (`a:solidFill` parent), or undefined for theme or no color. */
function solidColor(fillParent: XmlElement | undefined): string | undefined {
  const fill = child(fillParent, "a:solidFill");
  const rgb = child(fill, "a:srgbClr");
  const value = rgb?.attrs.val;
  if (value === undefined || !/^[0-9A-Fa-f]{6}$/.test(value)) return undefined;
  const alpha = child(rgb, "a:alpha")?.attrs.val;
  const hex = `#${value.toUpperCase()}`;
  if (alpha === undefined) return hex;
  const a = Math.max(0, Math.min(1, num(alpha, 100_000) / 100_000));
  if (a >= 1) return hex;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${round(a)})`;
}

interface Placeholder {
  readonly type: string;
  readonly idx: string | undefined;
}

const placeholderOf = (shape: XmlElement): Placeholder | undefined => {
  const nvPr = shape.children.find((kid) => kid.name.startsWith("p:nv"));
  const ph = path(nvPr, "p:nvPr", "p:ph");
  return ph === undefined ? undefined : { type: ph.attrs.type ?? "body", idx: ph.attrs.idx };
};

const DEFAULT_POINTS: ReadonlyMap<string, number> = new Map([
  ["title", 40],
  ["ctrTitle", 54],
  ["subTitle", 24],
  ["body", 24],
]);

const BULLETED_PLACEHOLDERS = new Set(["body", "obj"]);

interface TextParts {
  readonly text: string;
  readonly fontPoints: number | undefined;
  readonly bold: boolean;
  readonly color: string | undefined;
  readonly fontFamily: string | undefined;
  readonly align: "left" | "center" | "right" | undefined;
  readonly lineHeight: number | undefined;
}

function readText(body: XmlElement, placeholder: Placeholder | undefined): TextParts | undefined {
  const paragraphs = childrenNamed(body, "a:p");
  const lines: string[] = [];
  let fontPoints: number | undefined;
  let color: string | undefined;
  let fontFamily: string | undefined;
  let align: TextParts["align"];
  let lineHeight: number | undefined;
  let runs = 0;
  let boldRuns = 0;
  const bulleted = placeholder !== undefined && BULLETED_PLACEHOLDERS.has(placeholder.type);
  for (const paragraph of paragraphs) {
    const pPr = child(paragraph, "a:pPr");
    let line = "";
    for (const part of paragraph.children) {
      if (part.name === "a:br") line += "\n";
      if (part.name !== "a:r" && part.name !== "a:fld") continue;
      const value = child(part, "a:t")?.text ?? "";
      line += value;
      if (value.trim() === "") continue;
      runs += 1;
      const rPr = child(part, "a:rPr");
      if (rPr?.attrs.b === "1" || rPr?.attrs.b === "true") boldRuns += 1;
      fontPoints ??= rPr?.attrs.sz === undefined ? undefined : num(rPr.attrs.sz) / 100;
      color ??= solidColor(rPr);
      const typeface = child(rPr, "a:latin")?.attrs.typeface;
      if (fontFamily === undefined && typeface !== undefined && !typeface.startsWith("+")) {
        fontFamily = typeface;
      }
    }
    align ??=
      pPr?.attrs.algn === "ctr"
        ? "center"
        : pPr?.attrs.algn === "r"
          ? "right"
          : pPr?.attrs.algn === "l"
            ? "left"
            : undefined;
    const spacing = path(pPr, "a:lnSpc", "a:spcPct")?.attrs.val;
    if (lineHeight === undefined && spacing !== undefined) {
      lineHeight = Math.max(0.5, Math.min(4, round((num(spacing, 100_000) / 100_000) * 1.2)));
    }
    const explicitBullet =
      child(pPr, "a:buChar") !== undefined || child(pPr, "a:buAutoNum") !== undefined;
    const noBullet = child(pPr, "a:buNone") !== undefined;
    if (line.trim() !== "" && !noBullet && (explicitBullet || bulleted)) {
      const char = child(pPr, "a:buChar")?.attrs.char;
      const level = num(pPr?.attrs.lvl);
      line = `${"  ".repeat(Math.max(0, Math.min(8, level)))}${char === undefined || char === "" ? "•" : char} ${line}`;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const text = lines.join("\n");
  if (text.trim() === "") return undefined;
  return {
    text: text.slice(0, MAX_TEXT),
    fontPoints:
      fontPoints ?? (placeholder === undefined ? undefined : DEFAULT_POINTS.get(placeholder.type)),
    bold: runs > 0 && boldRuns === runs,
    color,
    fontFamily,
    align,
    lineHeight,
  };
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

interface SlideContext {
  readonly parts: Parts;
  readonly slidePath: string;
  readonly rels: ReturnType<Parts["rels"]>;
  /** Placeholder positions from the layout and master, for shapes without their own. */
  readonly placeholderXfrm: (ph: Placeholder) => XmlElement | undefined;
  readonly nodeId: () => string;
  readonly frameId: string;
  /** Scale from EMU to pixels for font sizes and stroke widths. */
  readonly k: number;
  readonly nodes: ImportedNode[];
  readonly notImported: string[];
  readonly media: Map<string, ImportedMedia>;
  /** Reading a layout or master: only its own pictures show on the slide. */
  readonly inherited: boolean;
}

const SHAPES: ReadonlyMap<string, "rect" | "roundRect" | "ellipse" | "line"> = new Map([
  ["rect", "rect"],
  ["roundRect", "roundRect"],
  ["ellipse", "ellipse"],
  ["line", "line"],
  ["straightConnector1", "line"],
]);

const shapeName = (shape: XmlElement) => {
  const nvPr = shape.children.find((kid) => kid.name.startsWith("p:nv"));
  const cNvPr = nvPr?.children.find((kid) => kid.name === "p:cNvPr");
  return {
    name: cNvPr?.attrs.name?.slice(0, 180),
    hidden: cNvPr?.attrs.hidden === "1" || cNvPr?.attrs.hidden === "true",
    alt: cNvPr?.attrs.descr?.slice(0, 500),
  };
};

const label = (kind: string, name: string | undefined) =>
  name === undefined || name === "" ? kind : `${kind} "${name}"`;

/** A deck-supplied word (a preset name, a file extension) cut short for a label. */
const clip = (value: string, max = 40) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function addNode(context: SlideContext, node: ImportedNode) {
  if (context.nodes.length === MAX_NODES_PER_SLIDE) {
    context.notImported.push(`Shapes beyond the first ${MAX_NODES_PER_SLIDE}`);
  }
  context.nodes.push(node);
}

function readShape(context: SlideContext, shape: XmlElement, transform: Transform) {
  const { name, hidden } = shapeName(shape);
  const spPr = child(shape, "p:spPr");
  const placeholder = placeholderOf(shape);
  const box =
    boxOf(child(spPr, "a:xfrm"), transform) ??
    (placeholder === undefined
      ? undefined
      : boxOf(context.placeholderXfrm(placeholder), transform));
  const body = child(shape, "p:txBody");
  const text = body === undefined ? undefined : readText(body, placeholder);
  if (box === undefined) {
    if (text !== undefined) context.notImported.push(label("Text without a position", name));
    return;
  }
  const base = {
    parentId: context.frameId,
    ...(name === undefined || name === "" ? {} : { name }),
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...(box.rotation === undefined ? {} : { rotation: box.rotation }),
    ...(hidden ? { hidden: true } : {}),
  };
  const geometry = child(spPr, "a:prstGeom")?.attrs.prst;
  const custom = child(spPr, "a:custGeom") !== undefined;
  const pictureFill = child(spPr, "a:blipFill");
  if (pictureFill !== undefined) {
    // A placeholder inherits its geometry from the layout; nearly all of those are rectangles.
    const kind =
      geometry === undefined
        ? placeholder === undefined
          ? undefined
          : "rect"
        : SHAPES.get(geometry);
    if (custom || (kind !== "rect" && kind !== "roundRect")) {
      context.notImported.push(
        label(`Picture-filled shape (${clip(geometry ?? "freeform")})`, name),
      );
    } else {
      const adjust = descendants(spPr!, "a:gd").find((gd) => gd.attrs.name === "adj");
      const radius =
        kind === "roundRect"
          ? length(
              Math.min(box.width, box.height) *
                (num(/val\s+(-?\d+)/.exec(adjust?.attrs.fmla ?? "")?.[1], 16_667) / 100_000),
            )
          : undefined;
      addPicture(context, pictureFill, {
        name,
        hidden,
        alt: undefined,
        box,
        ...(radius === undefined || radius <= 0 ? {} : { radius }),
      });
    }
  }
  const fill =
    pictureFill !== undefined || child(spPr, "a:noFill") !== undefined
      ? undefined
      : solidColor(spPr);
  const ln = child(spPr, "a:ln");
  const stroke = child(ln, "a:noFill") !== undefined ? undefined : solidColor(ln);
  const strokeWidth = ln?.attrs.w === undefined ? undefined : length(num(ln.attrs.w) * context.k);
  const kind = geometry === undefined ? undefined : SHAPES.get(geometry);
  const drawn = fill !== undefined || stroke !== undefined;
  if (custom) {
    if (pictureFill === undefined) context.notImported.push(label("Freeform shape", name));
  } else if (
    geometry !== undefined &&
    kind === undefined &&
    pictureFill === undefined &&
    (drawn || text === undefined)
  ) {
    context.notImported.push(label(`Shape (${clip(geometry)})`, name));
  } else if (kind === "line") {
    const [x0, x1] = box.flipH ? [box.width, 0] : [0, box.width];
    const [y0, y1] = box.flipV ? [box.height, 0] : [0, box.height];
    addNode(context, {
      kind: "node",
      node: {
        ...base,
        id: context.nodeId(),
        type: "line",
        points: [
          [x0, y0],
          [x1, y1],
        ],
        stroke: stroke ?? "#1F1D24",
        ...(strokeWidth === undefined ? {} : { strokeWidth }),
      },
    });
  } else if (kind !== undefined && drawn) {
    const adjust = descendants(spPr ?? shape, "a:gd").find((gd) => gd.attrs.name === "adj");
    const radius =
      kind === "roundRect"
        ? length(
            Math.min(box.width, box.height) *
              (num(/val\s+(-?\d+)/.exec(adjust?.attrs.fmla ?? "")?.[1], 16_667) / 100_000),
          )
        : undefined;
    // PowerPoint centers a line on the edge; the canvas draws a border inside the box.
    const inset = stroke === undefined ? 0 : (strokeWidth ?? 1) / 2;
    addNode(context, {
      kind: "node",
      node: {
        ...base,
        id: context.nodeId(),
        type: kind === "ellipse" ? "ellipse" : "rect",
        x: coordinate(box.x - inset),
        y: coordinate(box.y - inset),
        width: length(box.width + inset * 2),
        height: length(box.height + inset * 2),
        ...(fill === undefined ? {} : { fill }),
        ...(stroke === undefined ? {} : { stroke, strokeWidth: strokeWidth ?? 1 }),
        ...(radius === undefined || radius <= 0 ? {} : { radius }),
      },
    });
  }
  if (text !== undefined) {
    const fontSize =
      text.fontPoints === undefined
        ? undefined
        : length(text.fontPoints * EMU_PER_POINT * context.k);
    addNode(context, {
      kind: "node",
      node: {
        ...base,
        id: context.nodeId(),
        type: "text",
        ...(kind !== undefined && drawn && name !== undefined
          ? { name: `${name.slice(0, 175)} text` }
          : {}),
        text: text.text,
        ...(text.color === undefined ? {} : { color: text.color }),
        ...(text.fontFamily === undefined ? {} : { fontFamily: text.fontFamily.slice(0, 200) }),
        ...(fontSize === undefined ? {} : { fontSize }),
        ...(text.bold ? { fontWeight: 700 } : {}),
        ...(text.lineHeight === undefined ? {} : { lineHeight: text.lineHeight }),
        ...(text.align === undefined ? {} : { align: text.align }),
      },
    });
  }
}

interface Crop {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** `a:srcRect` as fractions of the picture cut from each side; a negative side pads. */
function cropOf(blipFill: XmlElement): Crop {
  const rect = child(blipFill, "a:srcRect");
  const side = (key: string) => Math.max(-10, Math.min(1, num(rect?.attrs[key]) / 100_000));
  return { l: side("l"), t: side("t"), r: side("r"), b: side("b") };
}

const near = (a: number, b: number, within = 0.002) => Math.abs(a - b) <= within;

/** How a cropped picture fits its box: a centered crop that keeps its shape is a cover or contain fit. */
function fitOf(crop: Crop, box: Box, size: { width: number; height: number } | null) {
  const { l, t, r, b } = crop;
  if ([l, t, r, b].every((side) => near(side, 0))) return "fill" as const;
  if (size === null || !near(l, r) || !near(t, b)) return undefined;
  const sx = box.width / Math.max(1, size.width * (1 - l - r));
  const sy = box.height / Math.max(1, size.height * (1 - t - b));
  if (!near(sx / sy, 1, 0.01) || (!near(l, 0) && !near(t, 0))) return undefined;
  if (l >= -0.002 && t >= -0.002) return "cover" as const;
  if (l <= 0.002 && t <= 0.002) return "contain" as const;
  return undefined;
}

interface PictureAt {
  readonly name: string | undefined;
  readonly hidden: boolean;
  readonly alt: string | undefined;
  readonly box: Box;
  readonly radius?: number;
  /** Shown before the slide's own nodes (a background). */
  readonly first?: boolean;
}

/**
 * A picture fill (`p:blipFill` or `a:blipFill`) as an image node. A crop that
 * a fit cannot express becomes a clipping frame around the whole picture.
 */
function addPicture(context: SlideContext, blipFill: XmlElement, at: PictureAt) {
  const { name, box } = at;
  const blip = child(blipFill, "a:blip");
  const embed = blip?.attrs["r:embed"];
  const target = embed === undefined ? undefined : context.rels.get(embed)?.target;
  const extension = target?.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeType = IMAGE_TYPES.get(extension);
  if (target === undefined || mimeType === undefined) {
    context.notImported.push(
      label(
        mimeType === undefined && target !== undefined
          ? `Picture (.${clip(extension)})`
          : "Picture",
        name,
      ),
    );
    return;
  }
  const bytes = context.parts.entries.get(target);
  if (bytes === undefined) {
    context.notImported.push(
      label(`Picture larger than ${megabytes(PPTX_IMPORT_LIMITS.imageBytes)}`, name),
    );
    return;
  }
  context.media.set(target, { bytes, mimeType });
  const amount = child(blip, "a:alphaModFix")?.attrs.amt;
  const opacity =
    amount === undefined ? 1 : round(Math.max(0, Math.min(1, num(amount, 100_000) / 100_000)));
  const crop = cropOf(blipFill);
  const size = mimeType === "image/svg+xml" ? null : imagePixelSize(bytes);
  const fit = fitOf(crop, box, size);
  const common = {
    ...(name === undefined || name === "" ? {} : { name }),
    ...(at.hidden ? { hidden: true } : {}),
    ...(opacity < 1 ? { opacity } : {}),
  };
  // The asset name is filled in once the picture is stored.
  const asset = `${"0".repeat(64)}.png`;
  const alt = at.alt === undefined || at.alt === "" ? {} : { alt: at.alt };
  const rotation = box.rotation === undefined ? {} : { rotation: box.rotation };
  const push = (node: ImportedNode) =>
    at.first === true ? context.nodes.unshift(node) : addNode(context, node);
  if (fit !== undefined) {
    push({
      kind: "image",
      media: target,
      node: {
        id: context.nodeId(),
        parentId: context.frameId,
        type: "image",
        ...common,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        ...rotation,
        asset,
        fit,
        ...alt,
        ...(at.radius === undefined ? {} : { radius: at.radius }),
      },
    });
    return;
  }
  // The whole picture, placed so the crop falls on the box, inside a frame that clips to the box.
  const visibleW = Math.max(0.001, 1 - crop.l - crop.r);
  const visibleH = Math.max(0.001, 1 - crop.t - crop.b);
  const width = box.width / visibleW;
  const height = box.height / visibleH;
  const frameId = context.nodeId();
  const image: ImportedNode = {
    kind: "image",
    media: target,
    node: {
      id: context.nodeId(),
      parentId: frameId,
      type: "image",
      ...(name === undefined || name === "" ? {} : { name }),
      x: coordinate(-crop.l * width),
      y: coordinate(-crop.t * height),
      width: length(width),
      height: length(height),
      asset,
      fit: "fill",
      ...alt,
    },
  };
  const frame: ImportedNode = {
    kind: "node",
    node: {
      id: frameId,
      parentId: context.frameId,
      type: "frame",
      ...common,
      ...(name === undefined || name === "" ? { name: "Cropped picture" } : {}),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ...rotation,
      clip: true,
      ...(at.radius === undefined ? {} : { radius: at.radius }),
    },
  };
  if (at.first === true) {
    context.nodes.unshift(frame, image);
    return;
  }
  addNode(context, frame);
  addNode(context, image);
}

function readPicture(context: SlideContext, picture: XmlElement, transform: Transform) {
  const { name, hidden, alt } = shapeName(picture);
  const placeholder = placeholderOf(picture);
  // A layout's own picture placeholders are prompts, not pictures.
  if (context.inherited && placeholder !== undefined) return;
  const nvPr = path(picture, "p:nvPicPr", "p:nvPr");
  if (child(nvPr, "a:videoFile") !== undefined || child(nvPr, "a:audioFile") !== undefined) {
    context.notImported.push(
      label(child(nvPr, "a:videoFile") === undefined ? "Audio" : "Video", name),
    );
    return;
  }
  const blipFill = child(picture, "p:blipFill");
  // A picture placeholder takes its position from the layout or master.
  const box =
    boxOf(path(picture, "p:spPr", "a:xfrm"), transform) ??
    (placeholder === undefined
      ? undefined
      : boxOf(context.placeholderXfrm(placeholder), transform));
  if (box === undefined || blipFill === undefined) {
    context.notImported.push(label("Picture", name));
    return;
  }
  addPicture(context, blipFill, { name, hidden, alt, box });
}

const GRAPHIC_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/chart$/, "Chart"],
  [/\/table$/, "Table"],
  [/\/diagram$/, "SmartArt diagram"],
  [/ole$/i, "Embedded object"],
];

function readTree(context: SlideContext, tree: XmlElement, transform: Transform, depth: number) {
  for (const item of tree.children) {
    switch (item.name) {
      case "p:sp":
      case "p:cxnSp":
        if (!context.inherited) readShape(context, item, transform);
        break;
      case "p:pic":
        readPicture(context, item, transform);
        break;
      case "p:graphicFrame": {
        if (context.inherited) break;
        const uri = path(item, "a:graphic", "a:graphicData")?.attrs.uri ?? "";
        const kind = GRAPHIC_KINDS.find(([pattern]) => pattern.test(uri))?.[1] ?? "Embedded object";
        context.notImported.push(label(kind, shapeName(item).name));
        break;
      }
      case "p:grpSp": {
        const xfrm = path(item, "p:grpSpPr", "a:xfrm");
        const off = child(xfrm, "a:off");
        const ext = child(xfrm, "a:ext");
        const chOff = child(xfrm, "a:chOff");
        const chExt = child(xfrm, "a:chExt");
        const { name } = shapeName(item);
        if (
          depth > 8 ||
          num(xfrm?.attrs.rot) !== 0 ||
          xfrm?.attrs.flipH === "1" ||
          xfrm?.attrs.flipV === "1"
        ) {
          if (!context.inherited) context.notImported.push(label("Rotated or flipped group", name));
          break;
        }
        if (off === undefined || ext === undefined || chOff === undefined || chExt === undefined) {
          readTree(context, item, transform, depth + 1);
          break;
        }
        const sx = num(chExt.attrs.cx) === 0 ? 1 : num(ext.attrs.cx) / num(chExt.attrs.cx);
        const sy = num(chExt.attrs.cy) === 0 ? 1 : num(ext.attrs.cy) / num(chExt.attrs.cy);
        readTree(
          context,
          item,
          {
            kx: transform.kx * sx,
            ky: transform.ky * sy,
            dx: transform.dx + (num(off.attrs.x) - num(chOff.attrs.x) * sx) * transform.kx,
            dy: transform.dy + (num(off.attrs.y) - num(chOff.attrs.y) * sy) * transform.ky,
          },
          depth + 1,
        );
        break;
      }
      case "mc:AlternateContent":
      case "p:contentPart":
        if (context.inherited) break;
        context.notImported.push("Ink or content that needs a newer PowerPoint");
        break;
      default:
        break;
    }
  }
}

function notesText(parts: Parts, notesPath: string | undefined): string | undefined {
  const notes = notesPath === undefined ? undefined : parts.xml(notesPath);
  if (notes === undefined) return undefined;
  const tree = path(notes, "p:cSld", "p:spTree");
  const body = childrenNamed(tree, "p:sp").find((shape) => placeholderOf(shape)?.type === "body");
  const textBody = child(body, "p:txBody");
  if (textBody === undefined) return undefined;
  const text = childrenNamed(textBody, "a:p")
    .map((paragraph) =>
      paragraph.children
        .map((part) =>
          part.name === "a:br"
            ? "\n"
            : part.name === "a:r" || part.name === "a:fld"
              ? (child(part, "a:t")?.text ?? "")
              : "",
        )
        .join(""),
    )
    .join("\n")
    .trim();
  return text === "" ? undefined : text.slice(0, MAX_TEXT);
}

const relOfType = (rels: ReturnType<Parts["rels"]>, suffix: string) =>
  [...rels.values()].find((rel) => rel.type.endsWith(suffix))?.target;

const placeholderKind = (type: string) =>
  type === "ctrTitle" ? "title" : type === "obj" ? "body" : type;

interface PlaceholderIndex {
  /** The first placeholder shape of a layout or master by `idx`, and by kind. */
  readonly byIdx: ReadonlyMap<string, XmlElement>;
  readonly byKind: ReadonlyMap<string, XmlElement>;
}

/** Indexes per layout or master tree, built once however many shapes look them up. */
const placeholderIndexes = new WeakMap<XmlElement, PlaceholderIndex>();

function placeholderIndex(tree: XmlElement): PlaceholderIndex {
  const known = placeholderIndexes.get(tree);
  if (known !== undefined) return known;
  const byIdx = new Map<string, XmlElement>();
  const byKind = new Map<string, XmlElement>();
  for (const shape of descendants(tree, "p:sp")) {
    const ph = placeholderOf(shape);
    if (ph === undefined) continue;
    if (ph.idx !== undefined && !byIdx.has(ph.idx)) byIdx.set(ph.idx, shape);
    const kind = placeholderKind(ph.type);
    if (!byKind.has(kind)) byKind.set(kind, shape);
  }
  const index = { byIdx, byKind };
  placeholderIndexes.set(tree, index);
  return index;
}

function placeholderLookup(parts: Parts, slideRels: ReturnType<Parts["rels"]>) {
  const layoutPath = relOfType(slideRels, "/slideLayout");
  const masterPath =
    layoutPath === undefined ? undefined : relOfType(parts.rels(layoutPath), "/slideMaster");
  const trees = [layoutPath, masterPath]
    .map((name) => (name === undefined ? undefined : path(parts.xml(name), "p:cSld", "p:spTree")))
    .filter((tree): tree is XmlElement => tree !== undefined)
    .map(placeholderIndex);
  return (ph: Placeholder) => {
    for (const { byIdx, byKind } of trees) {
      const match =
        (ph.idx === undefined ? undefined : byIdx.get(ph.idx)) ??
        byKind.get(placeholderKind(ph.type));
      const xfrm = path(match, "p:spPr", "a:xfrm");
      if (xfrm !== undefined) return xfrm;
    }
    return undefined;
  };
}

/** Reads a .pptx and plans its slides; throws `PptxImportError` with a plain sentence. */
export async function readPptxDeck(bytes: Uint8Array, nodeId: () => string): Promise<ImportedDeck> {
  const entries = await readZipEntries(bytes);
  const parts = makeParts(entries);
  checkContentTypes(parts);
  const presentation = parts.xml("ppt/presentation.xml");
  if (presentation === undefined) {
    throw new PptxImportError("invalid", "The deck has no presentation part.");
  }
  const presentationRels = parts.rels("ppt/presentation.xml");
  const slidePaths = childrenNamed(child(presentation, "p:sldIdLst"), "p:sldId")
    .map((entry) => presentationRels.get(entry.attrs["r:id"] ?? "")?.target)
    .filter((target): target is string => target !== undefined);
  if (slidePaths.length === 0) throw new PptxImportError("invalid", "The deck has no slides.");
  if (slidePaths.length > PPTX_IMPORT_LIMITS.slides) {
    throw new PptxImportError(
      "too_large",
      `The deck has ${slidePaths.length} slides; the import limit is ${PPTX_IMPORT_LIMITS.slides}.`,
    );
  }
  const size = child(presentation, "p:sldSz");
  const cx = num(size?.attrs.cx, 12_192_000) || 12_192_000;
  const cy = num(size?.attrs.cy, 6_858_000) || 6_858_000;
  if ([cx, cy].some((side) => side < SLIDE_SIDE_EMU.min || side > SLIDE_SIDE_EMU.max)) {
    throw new PptxImportError(
      "invalid",
      "The deck's slide size is outside what PowerPoint allows (1 to 56 inches a side).",
    );
  }
  const k = Math.min(SLIDE_WIDTH / cx, SLIDE_HEIGHT / cy);
  const transform: Transform = {
    kx: k,
    ky: k,
    dx: (SLIDE_WIDTH - cx * k) / 2,
    dy: (SLIDE_HEIGHT - cy * k) / 2,
  };
  const media = new Map<string, ImportedMedia>();
  const slides = slidePaths.map((slidePath, index): ImportedSlide => {
    const slide = parts.xml(slidePath);
    const rels = parts.rels(slidePath);
    const frameId = nodeId();
    const context: SlideContext = {
      parts,
      slidePath,
      rels,
      placeholderXfrm: placeholderLookup(parts, rels),
      nodeId,
      frameId,
      k,
      nodes: [],
      notImported: [],
      media,
      inherited: false,
    };
    const cSld = child(slide, "p:cSld");
    const layoutPath = relOfType(rels, "/slideLayout");
    const masterPath =
      layoutPath === undefined ? undefined : relOfType(parts.rels(layoutPath), "/slideMaster");
    const layout = layoutPath === undefined ? undefined : parts.xml(layoutPath);
    // The master's and layout's own pictures (a logo, a band) show under the slide's shapes.
    const inherited = [
      ...(slide?.attrs.showMasterSp !== "0" && layout?.attrs.showMasterSp !== "0"
        ? [masterPath]
        : []),
      ...(slide?.attrs.showMasterSp !== "0" ? [layoutPath] : []),
    ];
    for (const part of inherited) {
      const tree = part === undefined ? undefined : path(parts.xml(part), "p:cSld", "p:spTree");
      if (part === undefined || tree === undefined) continue;
      readTree({ ...context, rels: parts.rels(part), inherited: true }, tree, transform, 0);
    }
    const tree = child(cSld, "p:spTree");
    if (tree !== undefined) readTree(context, tree, transform, 0);
    // The background is the slide's, else its layout's, else its master's.
    const owner = [slidePath, layoutPath, masterPath].find(
      (part) => part !== undefined && path(parts.xml(part), "p:cSld", "p:bg") !== undefined,
    );
    const bgPr =
      owner === undefined ? undefined : path(parts.xml(owner), "p:cSld", "p:bg", "p:bgPr");
    const background = solidColor(bgPr);
    const backgroundPicture = child(bgPr, "a:blipFill");
    if (owner !== undefined && backgroundPicture !== undefined) {
      addPicture({ ...context, rels: parts.rels(owner) }, backgroundPicture, {
        name: "Background picture",
        hidden: false,
        alt: undefined,
        // The slide area, letterboxed like the shapes when the deck is not 16:9.
        box: {
          x: round(transform.dx),
          y: round(transform.dy),
          width: round(cx * k),
          height: round(cy * k),
          rotation: undefined,
          flipH: false,
          flipV: false,
        },
        first: true,
      });
    } else if (
      bgPr !== undefined &&
      background === undefined &&
      child(bgPr, "a:noFill") === undefined
    ) {
      context.notImported.push("Background gradient or pattern");
    }
    return {
      name: `Slide ${index + 1}`,
      frameId,
      background,
      nodes: context.nodes.slice(0, MAX_NODES_PER_SLIDE),
      notes: notesText(parts, relOfType(rels, "/notesSlide")),
      skipped: slide?.attrs.show === "0",
      notImported: [...new Set(context.notImported)],
    };
  });
  return { slides, media };
}
