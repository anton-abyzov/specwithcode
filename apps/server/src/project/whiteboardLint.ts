/**
 * Geometric checks for an Excalidraw scene, ported from the vskill
 * `excalidraw-mcp` skill's `excalidraw_lint.py`. Errors mean the drawing
 * renders wrong (an empty box, a label off its arrow, a dangling binding);
 * warnings are worth a look but never block a save.
 */
import {
  BOUND_TEXT_PADDING,
  CONTAINER_TYPES,
  LINE_HEIGHT,
  PSEUDO_TYPES,
  pathLength,
  textHeight,
  textWidth,
} from "./whiteboardBuild.ts";

const WARN_BAND = 0.9;
const MIN_BODY_FONT = 16;
/** A report never lists more than this many lines of each kind. */
const MAX_LINES = 100;

export interface LintReport {
  readonly errors: string[];
  readonly warnings: string[];
}

type Element = Record<string, unknown>;

const n = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const s = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const points = (element: Element): number[][] =>
  Array.isArray(element.points)
    ? element.points.filter(
        (point): point is number[] => Array.isArray(point) && point.length >= 2,
      )
    : [];

function bbox(element: Element): readonly [number, number, number, number] {
  const x = n(element.x);
  const y = n(element.y);
  const pts = points(element);
  if ((element.type === "arrow" || element.type === "line") && pts.length > 0) {
    const xs = pts.map((point) => x + n(point[0]));
    const ys = pts.map((point) => y + n(point[1]));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [x, y, x + n(element.width), y + n(element.height)];
}

function overlapArea(a: Element, b: Element): number {
  const [ax1, ay1, ax2, ay2] = bbox(a);
  const [bx1, by1, bx2, by2] = bbox(b);
  const w = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const h = Math.min(ay2, by2) - Math.max(ay1, by1);
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(outer: Element, inner: Element): boolean {
  const [ox1, oy1, ox2, oy2] = bbox(outer);
  const [ix1, iy1, ix2, iy2] = bbox(inner);
  return ox1 <= ix1 && oy1 <= iy1 && ox2 >= ix2 && oy2 >= iy2;
}

function boundIds(element: Element): string[] {
  return Array.isArray(element.boundElements)
    ? element.boundElements
        .map((entry) => (entry && typeof entry === "object" ? s((entry as Element).id) : undefined))
        .filter((id): id is string => id !== undefined)
    : [];
}

function labelText(raw: unknown): { text: string; fontSize: number | undefined } | null {
  if (typeof raw === "string") return { text: raw, fontSize: undefined };
  if (raw && typeof raw === "object" && typeof (raw as Element).text === "string") {
    const fontSize = (raw as Element).fontSize;
    return {
      text: (raw as Element).text as string,
      fontSize: typeof fontSize === "number" ? fontSize : undefined,
    };
  }
  return null;
}

/** Checks a skeleton before it is built: label fit and inline text on shapes. */
export function lintSkeleton(skeleton: ReadonlyArray<Element>): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const element of skeleton) {
    const type = s(element.type);
    if (type === undefined || !CONTAINER_TYPES.has(type)) continue;
    if (element.text !== undefined) {
      errors.push(
        `R14-INLINE-TEXT: ${s(element.id) ?? type}: inline "text" on a ${type} never renders; use "label"`,
      );
    }
  }
  return { errors, warnings };
}

/** Checks a built or saved scene. */
export function lintScene(elements: ReadonlyArray<Element>): LintReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (rule: string, message: string) => errors.push(`${rule}: ${message}`);
  const warn = (rule: string, message: string) => warnings.push(`${rule}: ${message}`);
  const live = elements.filter(
    (element) =>
      typeof element.type === "string" &&
      !PSEUDO_TYPES.has(element.type) &&
      element.isDeleted !== true,
  );
  const byId = new Map<string, Element>();
  for (const element of live) {
    const id = s(element.id);
    if (id === undefined) continue;
    if (byId.has(id)) err("R0-UNIQUE-ID", `duplicate id ${id}`);
    byId.set(id, element);
  }
  const shapes = live.filter((element) => CONTAINER_TYPES.has(element.type as string));
  const texts = live.filter((element) => element.type === "text");
  const arrows = live.filter((element) => element.type === "arrow");

  const checkLabel = (container: Element, text: string, fontSize: number) => {
    const pad = 2 * BOUND_TEXT_PADDING;
    const w = textWidth(text, fontSize);
    const h = textHeight(text, fontSize, LINE_HEIGHT[5]!);
    const availW = n(container.width) - pad;
    const availH = n(container.height) - pad;
    const id = s(container.id);
    const first = text.split("\n")[0]!.slice(0, 40);
    if (w > availW) {
      err(
        "R1-LABEL-WIDTH",
        `${id}: label "${first}" ~${Math.round(w)}px exceeds ${Math.round(availW)}px of usable box width`,
      );
    } else if (w > availW * WARN_BAND) {
      warn(
        "R1-LABEL-WIDTH",
        `${id}: label within 10% of overflow (${Math.round(w)}/${Math.round(availW)}px)`,
      );
    }
    if (h > availH) {
      err("R2-LABEL-HEIGHT", `${id}: label needs ${Math.round(h)}px, box gives ${Math.round(availH)}px`);
    }
  };

  for (const text of texts) {
    const containerId = s(text.containerId);
    if (containerId === undefined) continue;
    const container = byId.get(containerId);
    if (container === undefined) {
      err("R13-DANGLING", `text ${s(text.id)} points at missing container ${containerId}`);
      continue;
    }
    if (CONTAINER_TYPES.has(container.type as string)) {
      checkLabel(container, s(text.text) ?? "", n(text.fontSize, 20));
    }
    if (!boundIds(container).includes(s(text.id) ?? "")) {
      err(
        "R15-RECIPROCITY",
        `${containerId}: missing boundElements entry for its text ${s(text.id)} (the box renders empty)`,
      );
    }
  }
  for (const shape of shapes) {
    if (shape.text !== undefined || shape.label !== undefined) {
      err(
        "R14-INLINE-TEXT",
        `${s(shape.id)}: inline text on a ${shape.type as string} is never rendered by Excalidraw`,
      );
    }
  }

  for (const text of texts) {
    const family = text.fontFamily;
    const id = s(text.id);
    if (family === undefined || family === null) {
      warn("R16-FONT", `${id}: no fontFamily; set 5 (Excalifont, the current default)`);
    } else if (family === 1 || family === 2 || family === 3) {
      warn("R16-FONT", `${id}: fontFamily ${family} is deprecated; 5 = Excalifont`);
    }
    const expected = LINE_HEIGHT[typeof family === "number" ? family : 5] ?? 1.25;
    const lineHeight = text.lineHeight;
    if (typeof lineHeight !== "number") {
      err(
        "R17-LINEHEIGHT",
        `${id}: no lineHeight; Excalidraw back-derives a wrong one from height; set ${expected}`,
      );
    } else if (Math.abs(lineHeight - expected) > 0.001) {
      warn("R17-LINEHEIGHT", `${id}: lineHeight ${lineHeight} != ${expected} for fontFamily ${String(family)}`);
    }
    const fontSize = n(text.fontSize);
    if (fontSize > 0 && fontSize < MIN_BODY_FONT) {
      warn("R18-FONTSIZE", `${id}: fontSize ${fontSize} below the ${MIN_BODY_FONT}px readable floor`);
    }
    const height = n(text.height);
    if (height > 0) {
      const want = textHeight(s(text.text) ?? "", fontSize, expected);
      if (Math.abs(want - height) > Math.max(2, want * 0.15)) {
        warn(
          "R19-TEXT-METRICS",
          `${id}: height ${Math.round(height)} vs computed ${Math.round(want)} (text geometry is never recomputed on open)`,
        );
      }
    }
  }

  for (const arrow of arrows) {
    const id = s(arrow.id);
    const pts = points(arrow);
    if (pts.length < 2) {
      err("R8-ARROW-POINTS", `${id}: an arrow needs at least 2 points`);
      continue;
    }
    if (n(pts[0]![0]) !== 0 || n(pts[0]![1]) !== 0) {
      err("R8-ARROW-ORIGIN", `${id}: points[0] must be [0,0] (x,y is the first point)`);
    }
    const xs = pts.map((point) => n(point[0]));
    const ys = pts.map((point) => n(point[1]));
    const ew = Math.max(...xs) - Math.min(...xs);
    const eh = Math.max(...ys) - Math.min(...ys);
    if (Math.abs(n(arrow.width) - ew) > 1 || Math.abs(n(arrow.height) - eh) > 1) {
      err(
        "R7-ARROW-BBOX",
        `${id}: declared ${n(arrow.width)}x${n(arrow.height)} but points span ${Math.round(ew)}x${Math.round(eh)}`,
      );
    }
    if (!arrow.startBinding && !arrow.endBinding) {
      warn("R12-BINDINGS", `${id}: no start or end binding; it will not follow its shapes`);
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      const binding = arrow[key] as Element | null | undefined;
      const target = binding ? s(binding.elementId) : undefined;
      if (target === undefined) continue;
      const shape = byId.get(target);
      if (shape === undefined) err("R13-DANGLING", `${id}.${key} -> missing ${target}`);
      else if (!boundIds(shape).includes(id ?? "")) {
        err("R15-RECIPROCITY", `${target}: missing boundElements entry for arrow ${id}`);
      }
    }
    const bound = texts.find((text) => text.containerId === arrow.id);
    const label = bound
      ? { text: s(bound.text) ?? "", fontSize: n(bound.fontSize, 16) }
      : labelText(arrow.label);
    if (label !== null && label.text.length > 0) {
      const fontSize = label.fontSize ?? 16;
      const length = pathLength(pts);
      const lw = textWidth(label.text, fontSize);
      if (lw > length - 20) {
        err("R10-ARROW-LABEL", `${id}: label "${label.text}" ~${Math.round(lw)}px on a ${Math.round(length)}px path`);
      } else if (lw > 0.7 * length) {
        warn("R10-ARROW-LABEL", `${id}: label crowds its ${Math.round(length)}px path`);
      }
    }
  }

  const solid = shapes.filter(
    (shape) =>
      (s(shape.backgroundColor) ?? "transparent") !== "transparent" && n(shape.opacity, 100) >= 60,
  );
  for (let i = 0; i < solid.length && errors.length < MAX_LINES; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      const a = solid[i]!;
      const b = solid[j]!;
      if (contains(a, b) || contains(b, a)) continue;
      const area = overlapArea(a, b);
      if (area > 4) {
        err("R20-OVERLAP", `${s(a.id)} and ${s(b.id)} overlap by ${Math.round(area)}px2`);
      }
    }
  }
  for (const text of texts) {
    if (text.containerId) continue;
    for (const shape of solid) {
      if (overlapArea(text, shape) > 4 && !contains(shape, text)) {
        warn("R21-TEXT-COLLIDES", `text ${s(text.id)} straddles the edge of ${s(shape.id)}`);
      }
    }
    for (const arrow of arrows) {
      if (overlapArea(text, arrow) > 4) {
        warn("R21-TEXT-COLLIDES", `text ${s(text.id)} sits on arrow ${s(arrow.id)}`);
      }
    }
  }
  return { errors: errors.slice(0, MAX_LINES), warnings: warnings.slice(0, MAX_LINES) };
}
