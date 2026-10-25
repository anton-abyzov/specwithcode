import type {
  DesignNode,
  DesignOperation,
  DesignPage,
  DesignSystemComponent,
} from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import {
  dragRect,
  frameAt,
  parentOrigin,
  polylineBox,
  snapAngle,
  type NodeIndex,
  type Point,
  type Rect,
} from "./geometry";

export type CanvasTool =
  | "select"
  | "hand"
  | "frame"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "pen"
  | "note"
  | "image"
  | "comment";

export interface ToolInfo {
  readonly tool: CanvasTool;
  readonly label: string;
  /** Single key that picks the tool while the canvas has focus. */
  readonly key: string | null;
}

export const TOOLS: readonly ToolInfo[] = [
  { tool: "select", label: "Select", key: "v" },
  { tool: "hand", label: "Hand", key: "h" },
  { tool: "frame", label: "Frame", key: "f" },
  { tool: "rect", label: "Rectangle", key: "r" },
  { tool: "ellipse", label: "Ellipse", key: "o" },
  { tool: "line", label: "Line", key: "l" },
  { tool: "pen", label: "Pen", key: "p" },
  { tool: "text", label: "Text", key: "t" },
  { tool: "note", label: "Note", key: "n" },
  { tool: "image", label: "Image", key: null },
  { tool: "comment", label: "Comment", key: "c" },
];

export function toolForKey(key: string): CanvasTool | null {
  const lower = key.toLowerCase();
  return TOOLS.find((info) => info.key === lower)?.tool ?? null;
}

/** Size a click without a drag creates. */
const CLICK_SIZE: Partial<Record<CanvasTool, { width: number; height: number }>> = {
  frame: { width: 400, height: 300 },
  rect: { width: 120, height: 120 },
  ellipse: { width: 120, height: 120 },
  note: { width: 200, height: 160 },
  text: { width: 200, height: 32 },
};

const DRAG_THRESHOLD = 3;

export interface CreateContext {
  readonly page: DesignPage;
  readonly index: NodeIndex;
  readonly random?: () => number;
  /** Count of frames already on the page, for the default name. */
  readonly frameCount?: number;
}

function parentFor(context: CreateContext, point: Point) {
  const frame = frameAt(context.page, context.index, point);
  // A new frame on the empty canvas is an artboard; drawn inside a frame it nests.
  if (frame === null) return { parentId: null, origin: { x: 0, y: 0 } };
  const origin = parentOrigin(context.index, frame);
  return { parentId: frame.id, origin: { x: origin.x + frame.x, y: origin.y + frame.y } };
}

/**
 * The node a box tool (frame, rect, ellipse, text, note) creates from a drag in
 * page coordinates; a click creates the tool's default size at that point.
 */
export function createBoxNode(
  tool: "frame" | "rect" | "ellipse" | "text" | "note",
  context: CreateContext,
  start: Point,
  end: Point,
  square: boolean,
): { operation: DesignOperation; node: DesignNode } {
  const dragged =
    Math.abs(end.x - start.x) > DRAG_THRESHOLD || Math.abs(end.y - start.y) > DRAG_THRESHOLD;
  const size = CLICK_SIZE[tool]!;
  const rect: Rect = dragged
    ? dragRect(start, end, square)
    : { x: start.x, y: start.y, width: size.width, height: size.height };
  const { parentId, origin } = parentFor(context, start);
  const base = {
    id: designId("n", context.random),
    parentId,
    x: Math.round(rect.x - origin.x),
    y: Math.round(rect.y - origin.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  let node: DesignNode;
  switch (tool) {
    case "frame":
      node = {
        ...base,
        type: "frame",
        name: `Frame ${(context.frameCount ?? 0) + 1}`,
        fill: "#ffffff",
        clip: true,
      };
      break;
    case "rect":
      node = { ...base, type: "rect", fill: "#d9d6de" };
      break;
    case "ellipse":
      node = { ...base, type: "ellipse", fill: "#d9d6de" };
      break;
    case "text":
      node = { ...base, type: "text", text: "", fontSize: 16 };
      break;
    case "note":
      node = { ...base, type: "note", text: "", color: "yellow" };
      break;
  }
  return { operation: { op: "add_node", pageId: context.page.id, node }, node };
}

/** A line from a drag; Shift snaps to 45 degrees. */
export function createLineNode(
  context: CreateContext,
  start: Point,
  end: Point,
  snap: boolean,
): { operation: DesignOperation; node: DesignNode } | null {
  const to = snap ? snapAngle(start, end) : end;
  if (Math.hypot(to.x - start.x, to.y - start.y) < DRAG_THRESHOLD) return null;
  return pathNode("line", context, [start, to]);
}

/** A pen path from clicked points; null when it has fewer than two. */
export function createPenNode(
  context: CreateContext,
  points: readonly Point[],
  closed: boolean,
): { operation: DesignOperation; node: DesignNode } | null {
  if (points.length < 2) return null;
  return pathNode("path", context, points, closed);
}

/** The next pen point; Shift snaps it to 45 degrees from the previous one. */
export function penPoint(points: readonly Point[], point: Point, snap: boolean): Point {
  const last = points.at(-1);
  return snap && last !== undefined ? snapAngle(last, point) : point;
}

function pathNode(
  type: "line" | "path",
  context: CreateContext,
  points: readonly Point[],
  closed = false,
): { operation: DesignOperation; node: DesignNode } {
  const box = polylineBox(points);
  const { parentId, origin } = parentFor(context, points[0]!);
  const node: DesignNode = {
    id: designId("n", context.random),
    parentId,
    type,
    x: Math.round(box.rect.x - origin.x),
    y: Math.round(box.rect.y - origin.y),
    width: Math.round(box.rect.width),
    height: Math.round(box.rect.height),
    points: box.points,
    stroke: "#1f1d24",
    strokeWidth: 2,
    ...(closed ? { closed: true } : {}),
  };
  return { operation: { op: "add_node", pageId: context.page.id, node }, node };
}

/** An image node for an uploaded asset, at most 800 px wide, centred on `at`. */
export function createImageNode(
  context: CreateContext,
  asset: string,
  natural: { width: number; height: number },
  at: Point,
  alt: string,
): { operation: DesignOperation; node: DesignNode } {
  const scale = Math.min(1, 800 / Math.max(1, natural.width));
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));
  const topLeft = { x: at.x - width / 2, y: at.y - height / 2 };
  const { parentId, origin } = parentFor(context, at);
  const node: DesignNode = {
    id: designId("n", context.random),
    parentId,
    type: "image",
    asset,
    alt,
    fit: "cover",
    x: Math.round(topLeft.x - origin.x),
    y: Math.round(topLeft.y - origin.y),
    width,
    height,
  };
  return { operation: { op: "add_node", pageId: context.page.id, node }, node };
}

/** A component preview has no size of its own; this is where an inserted one starts. */
export const COMPONENT_SIZE = { width: 320, height: 120 } as const;

/**
 * A layer showing one of the design system's components, centred on `at` inside the
 * innermost frame there. It keeps the component's name, so it still reads as that
 * component under a system that lacks it.
 */
export function createComponentNode(
  context: CreateContext,
  component: Pick<DesignSystemComponent, "id" | "name">,
  at: Point,
): { operation: DesignOperation; node: DesignNode } {
  const { width, height } = COMPONENT_SIZE;
  const { parentId, origin } = parentFor(context, at);
  const node: DesignNode = {
    id: designId("n", context.random),
    parentId,
    type: "component",
    componentId: component.id,
    name: component.name.slice(0, 180),
    x: Math.round(at.x - width / 2 - origin.x),
    y: Math.round(at.y - height / 2 - origin.y),
    width,
    height,
  };
  return { operation: { op: "add_node", pageId: context.page.id, node }, node };
}

/** Copies of nodes (and their subtrees) offset by `offset`, with fresh ids. */
export function duplicateOperations(
  page: DesignPage,
  ids: readonly string[],
  offset: number,
  random?: () => number,
): { operations: DesignOperation[]; newIds: string[] } {
  const roots = new Set(ids);
  const mapping = new Map<string, string>();
  const operations: DesignOperation[] = [];
  const newIds: string[] = [];
  for (const node of page.nodes) {
    const isRoot = roots.has(node.id);
    const parentCopied = node.parentId !== null && mapping.has(node.parentId);
    if (!isRoot && !parentCopied) continue;
    const id = designId("n", random);
    mapping.set(node.id, id);
    const parentId = parentCopied ? mapping.get(node.parentId!)! : node.parentId;
    const copy = {
      ...node,
      id,
      parentId,
      ...(isRoot && !parentCopied ? { x: node.x + offset, y: node.y + offset } : {}),
    } as DesignNode;
    operations.push({ op: "add_node", pageId: page.id, node: copy });
    if (isRoot && !parentCopied) newIds.push(id);
  }
  return { operations, newIds };
}
