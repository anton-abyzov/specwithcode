/**
 * Builds a real `.excalidraw` scene from the skeleton format agents write
 * (the Excalidraw MCP `create_view` element list), ported from the vskill
 * `excalidraw-mcp` skill's `excalidraw_build.py` (MIT, same author).
 *
 * A skeleton `label` on a shape never renders by itself: Excalidraw draws
 * container text only as a separate text element with `containerId`, listed in
 * the container's `boundElements`. Arrows given `from`/`to` are laid from
 * perimeter to perimeter and bound both ways, since Excalidraw does not repair
 * that reciprocity on open. Text geometry is never recomputed on open either,
 * so the builder owns x/y/width/height and wraps lines itself.
 */

// Verified against excalidraw/excalidraw: packages/common/src/constants.ts and font-metadata.ts.
export const FONT_FAMILY = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  "Lilita One": 7,
  "Comic Shanns": 8,
  "Liberation Sans": 9,
  Assistant: 10,
} as const;
export const DEFAULT_FONT_FAMILY = FONT_FAMILY.Excalifont;
export const LINE_HEIGHT: Readonly<Record<number, number>> = {
  1: 1.25,
  2: 1.15,
  3: 1.2,
  5: 1.25,
  6: 1.25,
  7: 1.15,
  8: 1.25,
  9: 1.15,
  10: 1.25,
};
export const BOUND_TEXT_PADDING = 5;
const SAFE_PADDING = 6;
const MIN_BOX_W = 120;
const MIN_BOX_H = 60;
export const PSEUDO_TYPES = new Set(["cameraUpdate", "restoreCheckpoint", "delete"]);
export const CONTAINER_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
/** The most elements one skeleton may hold. */
export const MAX_SKELETON_ELEMENTS = 2_000;

export type SceneElement = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  boundElements: Array<{ type: string; id: string }> | null;
};

export interface SkeletonLabel {
  readonly text: string;
  readonly fontSize?: number | undefined;
  readonly strokeColor?: string | undefined;
}

/** One skeleton element; every field but type is optional and checked here. */
export type SkeletonElement = Readonly<Record<string, unknown>> & { readonly type?: unknown };

// --- text metrics ------------------------------------------------------------
// Calibrated per-character em widths: Excalifont is proportional, and a flat
// coefficient under-measures capitals and wide glyphs by up to ~27%.
const NARROW = new Set("iljtfrI!.,:;'`|()[]{}");
const WIDE = new Set("MWmw@%");

function charWidth(c: string): number {
  if (c === " ") return 0.3;
  if (NARROW.has(c)) return 0.35;
  if (WIDE.has(c)) return 0.95;
  if (c !== c.toLowerCase() && c === c.toUpperCase()) return 0.72;
  return 0.55;
}

function lineWidth(line: string, fontSize: number): number {
  let sum = 0;
  for (const c of line) sum += charWidth(c);
  return sum * fontSize;
}

export function textWidth(text: string, fontSize: number): number {
  return Math.max(0, ...text.split("\n").map((line) => lineWidth(line, fontSize)));
}

export function textHeight(text: string, fontSize: number, lineHeight: number): number {
  return text.split("\n").length * fontSize * lineHeight;
}

/** Greedy word wrap; explicit newlines are always kept. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (line.length > 0 && lineWidth(candidate, fontSize) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// --- deterministic ids and seeds ---------------------------------------------
/** Reproducible builds diff cleanly in git. */
export function stableInt(value: string, salt = 0): number {
  let hash = 2166136261;
  for (const ch of `${value}#${salt}`) {
    hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  }
  return hash % 2147483647 || 1;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function baseElement(type: string, id: string): SceneElement {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: stableInt(id),
    version: 1,
    versionNonce: stableInt(id, 1),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function makeText(
  id: string,
  x: number,
  y: number,
  text: string,
  fontSize: number,
  options: {
    readonly color?: string;
    readonly containerId?: string | null;
    readonly align?: string;
    readonly valign?: string;
    readonly opacity?: number;
  } = {},
): SceneElement {
  const lineHeight = LINE_HEIGHT[DEFAULT_FONT_FAMILY]!;
  const element = baseElement("text", id);
  Object.assign(element, {
    x: round2(x),
    y: round2(y),
    width: round2(textWidth(text, fontSize)),
    height: round2(textHeight(text, fontSize, lineHeight)),
    strokeColor: options.color ?? "#1e1e1e",
    opacity: options.opacity ?? 100,
    fontSize,
    fontFamily: DEFAULT_FONT_FAMILY,
    text,
    originalText: text,
    textAlign: options.align ?? "left",
    verticalAlign: options.valign ?? "top",
    containerId: options.containerId ?? null,
    lineHeight,
    autoResize: true,
  });
  return element;
}

// --- geometry ----------------------------------------------------------------
function center(element: SceneElement): readonly [number, number] {
  return [element.x + element.width / 2, element.y + element.height / 2];
}

function perimeterPoint(
  element: SceneElement,
  tx: number,
  ty: number,
  gap = 4,
): readonly [number, number] {
  const [cx, cy] = center(element);
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = element.width / 2;
  const hh = element.height / 2;
  if (element.type === "ellipse") {
    const angle = Math.atan2(dy, dx);
    return [cx + (hw + gap) * Math.cos(angle), cy + (hh + gap) * Math.sin(angle)];
  }
  const sx = dx !== 0 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(sx, sy);
  const n = Math.hypot(dx, dy);
  return [cx + dx * scale + (dx / n) * gap, cy + dy * scale + (dy / n) * gap];
}

function orthoPoints(x1: number, y1: number, x2: number, y2: number): number[][] {
  if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
    const mid = (x1 + x2) / 2;
    return [
      [0, 0],
      [mid - x1, 0],
      [mid - x1, y2 - y1],
      [x2 - x1, y2 - y1],
    ];
  }
  const mid = (y1 + y2) / 2;
  return [
    [0, 0],
    [0, mid - y1],
    [x2 - x1, mid - y1],
    [x2 - x1, y2 - y1],
  ];
}

export function pathLength(points: ReadonlyArray<ReadonlyArray<number>>): number {
  let sum = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    sum += Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
  }
  return sum;
}

// --- input helpers -----------------------------------------------------------
export class SkeletonError extends Error {}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function labelOf(raw: unknown): SkeletonLabel | null {
  if (typeof raw === "string") return raw.length > 0 ? { text: raw } : null;
  if (typeof raw === "number") return { text: String(raw) };
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const text = str(record.text);
    if (text === undefined || text.length === 0) return null;
    return {
      text,
      fontSize: typeof record.fontSize === "number" ? record.fontSize : undefined,
      strokeColor: str(record.strokeColor),
    };
  }
  return null;
}

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "angle",
  "groupIds",
  "locked",
] as const;

/** Safe style values only: links and anything outside these shapes are dropped. */
function copyStyle(target: SceneElement, raw: SkeletonElement): void {
  for (const key of STYLE_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    switch (key) {
      case "strokeColor":
      case "backgroundColor":
        if (typeof value === "string" && value.length <= 64) target[key] = value;
        break;
      case "fillStyle":
        if (value === "solid" || value === "hachure" || value === "cross-hatch" || value === "zigzag")
          target[key] = value;
        break;
      case "strokeStyle":
        if (value === "solid" || value === "dashed" || value === "dotted") target[key] = value;
        break;
      case "strokeWidth":
      case "roughness":
      case "angle":
        if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
        break;
      case "opacity":
        if (typeof value === "number" && Number.isFinite(value))
          target[key] = Math.max(0, Math.min(100, value));
        break;
      case "roundness":
        if (value === null) target[key] = null;
        else if (
          typeof value === "object" &&
          typeof (value as { type?: unknown }).type === "number"
        )
          target[key] = { type: (value as { type: number }).type };
        break;
      case "groupIds":
        if (Array.isArray(value)) target[key] = value.filter((id) => typeof id === "string");
        break;
      case "locked":
        if (typeof value === "boolean") target[key] = value;
        break;
    }
  }
}

function checkedId(raw: SkeletonElement, index: number): string {
  const id = raw.id;
  if (id === undefined) return `el-${index + 1}`;
  if (typeof id !== "string" || id.length === 0 || id.length > 100) {
    throw new SkeletonError(`element ${index + 1}: id must be a string of 1 to 100 characters`);
  }
  return id;
}

// --- builder -----------------------------------------------------------------
export interface BuildResult {
  readonly elements: SceneElement[];
  readonly warnings: string[];
}

export function buildScene(
  skeleton: ReadonlyArray<SkeletonElement>,
  options: {
    readonly dark?: boolean | undefined;
    /** Elements already in the file: arrows may bind to them, ids may not repeat them. */
    readonly existing?: ReadonlyArray<SceneElement> | undefined;
  } = {},
): BuildResult {
  if (skeleton.length > MAX_SKELETON_ELEMENTS) {
    throw new SkeletonError(`a skeleton holds at most ${MAX_SKELETON_ELEMENTS} elements`);
  }
  const dark = options.dark === true;
  const defaultText = dark ? "#e5e5e5" : "#1e1e1e";
  const existing = (options.existing ?? []).map((element) => ({ ...element }));
  const out: SceneElement[] = [];
  const byId = new Map<string, SceneElement>();
  for (const element of existing) byId.set(element.id, element);
  const warnings: string[] = [];
  const deleted = new Set<string>();

  const emit = (element: SceneElement): SceneElement => {
    if (byId.has(element.id)) {
      throw new SkeletonError(`duplicate element id: ${element.id}`);
    }
    byId.set(element.id, element);
    out.push(element);
    return element;
  };
  const bind = (target: SceneElement, entry: { type: string; id: string }) => {
    target.boundElements = [...(target.boundElements ?? []), entry];
  };

  const shape = (raw: SkeletonElement, id: string) => {
    const type = raw.type as string;
    const label = labelOf(raw.label);
    const zone = labelOf(raw.zoneLabel);
    let width = num(raw.width, MIN_BOX_W);
    let height = num(raw.height, MIN_BOX_H);
    let wrapped: string | null = null;
    let fontSize = 20;
    const lineHeight = LINE_HEIGHT[DEFAULT_FONT_FAMILY]!;
    if (label !== null) {
      fontSize = label.fontSize ?? 20;
      const pad = 2 * (BOUND_TEXT_PADDING + SAFE_PADDING);
      // Grow the box to the text rather than let the text overflow.
      wrapped = wrapText(label.text, fontSize, Math.max(width - pad, 40));
      const needW = textWidth(wrapped, fontSize) + pad;
      let needH = textHeight(wrapped, fontSize, lineHeight) + 2 * BOUND_TEXT_PADDING;
      if (needW > width) {
        if (raw.fixedWidth === true) {
          wrapped = wrapText(label.text, fontSize, width - pad);
          needH = textHeight(wrapped, fontSize, lineHeight) + 2 * BOUND_TEXT_PADDING;
        } else {
          width = Math.ceil(needW);
        }
      }
      height = Math.max(height, Math.ceil(needH));
    }
    const element = baseElement(type, id);
    element.x = num(raw.x, 0);
    element.y = num(raw.y, 0);
    element.width = width;
    element.height = height;
    copyStyle(element, raw);
    emit(element);
    if (wrapped !== null && label !== null) {
      const textId = `${id}-label`;
      const lw = textWidth(wrapped, fontSize);
      const lh = textHeight(wrapped, fontSize, lineHeight);
      const text = makeText(
        textId,
        element.x + (width - lw) / 2,
        element.y + (height - lh) / 2,
        wrapped,
        fontSize,
        {
          color: label.strokeColor ?? defaultText,
          containerId: id,
          align: "center",
          valign: "middle",
        },
      );
      bind(element, { type: "text", id: textId });
      emit(text);
    }
    if (zone !== null) {
      // A zone's caption sits top-left: a label bound to a zone centres in it and cannot be grabbed.
      emit(
        makeText(`${id}-zone`, element.x + 12, element.y + 8, zone.text, zone.fontSize ?? 16, {
          color: zone.strokeColor ?? str(raw.strokeColor) ?? defaultText,
        }),
      );
    }
  };

  const text = (raw: SkeletonElement, id: string) => {
    const content = str(raw.text) ?? (typeof raw.text === "number" ? String(raw.text) : undefined);
    if (content === undefined) throw new SkeletonError(`text ${id}: text is required`);
    const fontSize = num(raw.fontSize, 20);
    const element = makeText(id, num(raw.x, 0), num(raw.y, 0), content, fontSize, {
      color: str(raw.strokeColor) ?? defaultText,
      align: str(raw.textAlign) ?? "left",
      valign: str(raw.verticalAlign) ?? "top",
      opacity: num(raw.opacity, 100),
    });
    if (typeof raw.center === "number") element.x = round2(raw.center - element.width / 2);
    emit(element);
  };

  const arrowOrLine = (raw: SkeletonElement, id: string) => {
    const type = raw.type as "arrow" | "line";
    const startId = str(raw.from);
    const endId = str(raw.to);
    let startBinding: { elementId: string; focus: number; gap: number } | null = null;
    let endBinding: { elementId: string; focus: number; gap: number } | null = null;
    let points: number[][];
    let ox: number;
    let oy: number;
    if (startId !== undefined && endId !== undefined) {
      const a = byId.get(startId);
      const b = byId.get(endId);
      if (a === undefined || b === undefined) {
        throw new SkeletonError(
          `${type} ${id}: from and to must name shapes defined earlier (${startId}, ${endId})`,
        );
      }
      const [acx, acy] = center(a);
      const [bcx, bcy] = center(b);
      const [x1, y1] = perimeterPoint(a, bcx, bcy);
      const [x2, y2] = perimeterPoint(b, acx, acy);
      points =
        raw.route === "ortho"
          ? orthoPoints(x1, y1, x2, y2)
          : [
              [0, 0],
              [x2 - x1, y2 - y1],
            ];
      ox = x1;
      oy = y1;
      if (type === "arrow") {
        startBinding = { elementId: startId, focus: 0, gap: 4 };
        endBinding = { elementId: endId, focus: 0, gap: 4 };
      }
    } else {
      if (!Array.isArray(raw.points) || raw.points.length < 2) {
        throw new SkeletonError(`${type} ${id}: give from and to, or at least two points`);
      }
      points = raw.points.map((point, index) => {
        if (!Array.isArray(point) || point.length < 2) {
          throw new SkeletonError(`${type} ${id}: point ${index + 1} is not [x, y]`);
        }
        return [num(point[0], 0), num(point[1], 0)];
      });
      ox = num(raw.x, 0);
      oy = num(raw.y, 0);
      // Points are relative to x, y and the first must be the origin.
      const [p0x, p0y] = points[0] as [number, number];
      if (p0x !== 0 || p0y !== 0) {
        ox += p0x;
        oy += p0y;
        points = points.map(([px, py]) => [px! - p0x, py! - p0y]);
      }
      if (type === "arrow") {
        for (const key of ["startBinding", "endBinding"] as const) {
          const given = raw[key] as { elementId?: unknown; focus?: unknown; gap?: unknown } | null;
          if (given && typeof given === "object" && typeof given.elementId === "string") {
            const binding = {
              elementId: given.elementId,
              focus: num(given.focus, 0),
              gap: num(given.gap, 4),
            };
            if (key === "startBinding") startBinding = binding;
            else endBinding = binding;
          }
        }
      }
    }
    const xs = points.map((point) => point[0]!);
    const ys = points.map((point) => point[1]!);
    const element = baseElement(type, id);
    Object.assign(element, {
      x: round2(ox),
      y: round2(oy),
      // getSizeFromPoints: the extents of the points, never negative.
      width: round2(Math.max(...xs) - Math.min(...xs)),
      height: round2(Math.max(...ys) - Math.min(...ys)),
      points: points.map(([px, py]) => [round2(px!), round2(py!)]),
      lastCommittedPoint: null,
      startBinding,
      endBinding,
      startArrowhead: type === "arrow" ? (str(raw.startArrowhead) ?? null) : null,
      endArrowhead:
        type === "arrow"
          ? raw.endArrowhead === null
            ? null
            : (str(raw.endArrowhead) ?? "arrow")
          : null,
      ...(type === "arrow" ? { elbowed: raw.elbowed === true } : {}),
    });
    copyStyle(element, raw);
    emit(element);
    // Excalidraw does not repair arrow-to-shape reciprocity on open.
    for (const binding of [startBinding, endBinding]) {
      const target = binding ? byId.get(binding.elementId) : undefined;
      if (target !== undefined) bind(target, { type: "arrow", id });
    }
    const label = labelOf(raw.label);
    if (label !== null) {
      const fontSize = label.fontSize ?? 16;
      const length = pathLength(points);
      const lw = textWidth(label.text, fontSize);
      if (lw > length - 20) {
        warnings.push(
          `${type} ${id}: label "${label.text}" (~${Math.round(lw)}px) is wider than its ${Math.round(length)}px path; shorten it or lengthen the ${type}`,
        );
      }
      const lh = textHeight(label.text, fontSize, LINE_HEIGHT[DEFAULT_FONT_FAMILY]!);
      const mx = ox + (Math.min(...xs) + Math.max(...xs)) / 2;
      const my = oy + (Math.min(...ys) + Math.max(...ys)) / 2;
      const textId = `${id}-label`;
      const labelText = makeText(textId, mx - lw / 2, my - lh / 2, label.text, fontSize, {
        color: label.strokeColor ?? (element.strokeColor as string),
        containerId: id,
        align: "center",
        valign: "middle",
      });
      bind(element, { type: "text", id: textId });
      emit(labelText);
    }
  };

  skeleton.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warnings.push(`skipped element ${index + 1}: not an object`);
      return;
    }
    const type = raw.type;
    if (type === "delete") {
      for (const id of String(raw.ids ?? "").split(",")) {
        if (id.trim().length > 0) deleted.add(id.trim());
      }
      return;
    }
    if (typeof type !== "string" || PSEUDO_TYPES.has(type)) return;
    const id = checkedId(raw, index);
    if (type === "zone") {
      shape(
        { ...raw, type: "rectangle", zoneLabel: raw.zoneLabel ?? raw.label, label: undefined },
        id,
      );
    } else if (CONTAINER_TYPES.has(type)) shape(raw, id);
    else if (type === "text") text(raw, id);
    else if (type === "arrow" || type === "line") arrowOrLine(raw, id);
    else warnings.push(`skipped unsupported element type "${type}"`);
  });

  let all = [...existing, ...out];
  if (deleted.size > 0) {
    all = all.filter(
      (element) =>
        !deleted.has(element.id) &&
        !(typeof element.containerId === "string" && deleted.has(element.containerId)),
    );
  }
  pruneDangling(all);
  return { elements: orderWithIndex(all), warnings };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The n-th valid fractional-indexing key with no fractional part ("a0".."az",
 * then "b00".."bzz", then "c000"...), ascending, so Excalidraw keeps them as is.
 */
export function fractionalIndex(n: number): string {
  let rest = n;
  for (let digits = 1; digits <= 4; digits += 1) {
    const span = 62 ** digits;
    if (rest < span) {
      let key = "";
      for (let i = 0; i < digits; i += 1) {
        key = BASE62[rest % 62]! + key;
        rest = Math.floor(rest / 62);
      }
      return String.fromCharCode(96 + digits) + key;
    }
    rest -= span;
  }
  throw new SkeletonError("too many elements");
}

function pruneDangling(elements: SceneElement[]): void {
  const ids = new Set(elements.map((element) => element.id));
  for (const element of elements) {
    if (typeof element.containerId === "string" && !ids.has(element.containerId)) {
      element.containerId = null;
    }
    if (element.boundElements) {
      const kept = element.boundElements.filter((entry) => ids.has(entry.id));
      element.boundElements = kept.length > 0 ? kept : null;
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = element[key] as { elementId?: string } | null | undefined;
      if (binding && (binding.elementId === undefined || !ids.has(binding.elementId))) {
        element[key] = null;
      }
    }
  }
}

/**
 * Bound text sits right after its container, and every element gets a fresh,
 * ascending fractional index in that order so z-order stays stable on edits.
 */
function orderWithIndex(elements: SceneElement[]): SceneElement[] {
  const ordered: SceneElement[] = [];
  const seen = new Set<string>();
  const texts = new Map<string, SceneElement>();
  for (const element of elements) {
    if (typeof element.containerId === "string") texts.set(element.containerId, element);
  }
  for (const element of elements) {
    if (seen.has(element.id) || typeof element.containerId === "string") continue;
    ordered.push(element);
    seen.add(element.id);
    const bound = texts.get(element.id);
    if (bound !== undefined && !seen.has(bound.id)) {
      ordered.push(bound);
      seen.add(bound.id);
    }
  }
  for (const element of elements) if (!seen.has(element.id)) ordered.push(element);
  ordered.forEach((element, index) => {
    element.index = fractionalIndex(index);
  });
  return ordered;
}

/** A complete `.excalidraw` document around built elements. */
export function sceneDocument(
  elements: ReadonlyArray<SceneElement>,
  options: { readonly dark?: boolean | undefined } = {},
): {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: ReadonlyArray<SceneElement>;
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
} {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: {
      gridSize: null,
      viewBackgroundColor: options.dark === true ? "#121212" : "#ffffff",
    },
    files: {},
  };
}
