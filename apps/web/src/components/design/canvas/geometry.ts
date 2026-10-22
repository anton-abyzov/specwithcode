import type { DesignNode, DesignOperation, DesignPage } from "@specweave-studio/contracts";

/** Page coordinates: what node x and y mean for a top-level node. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Screen = page * zoom + offset. */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export function screenToPage(camera: Camera, point: Point): Point {
  return { x: (point.x - camera.x) / camera.zoom, y: (point.y - camera.y) / camera.zoom };
}

/** Zooms around a screen point so the page point under it stays put. */
export function zoomAt(camera: Camera, zoom: number, anchor: Point): Camera {
  const next = clampZoom(zoom);
  const page = screenToPage(camera, anchor);
  return { zoom: next, x: anchor.x - page.x * next, y: anchor.y - page.y * next };
}

/** A camera that shows `rect` centred in a viewport, never above `maxZoom`. */
export function fitRect(
  rect: Rect,
  viewport: { width: number; height: number },
  maxZoom = 1,
  padding = 48,
): Camera {
  const width = Math.max(1, viewport.width - padding * 2);
  const height = Math.max(1, viewport.height - padding * 2);
  const zoom = clampZoom(
    Math.min(maxZoom, width / Math.max(1, rect.width), height / Math.max(1, rect.height)),
  );
  return {
    zoom,
    x: viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
  };
}

export type NodeIndex = ReadonlyMap<string, DesignNode>;

export function indexNodes(page: DesignPage): NodeIndex {
  return new Map(page.nodes.map((node) => [node.id, node]));
}

/** Page position of a node's parent origin (0,0 for top-level nodes). */
export function parentOrigin(index: NodeIndex, node: DesignNode): Point {
  let x = 0;
  let y = 0;
  let parent = node.parentId === null ? undefined : index.get(node.parentId);
  while (parent !== undefined) {
    x += parent.x;
    y += parent.y;
    parent = parent.parentId === null ? undefined : index.get(parent.parentId);
  }
  return { x, y };
}

export function pageRect(index: NodeIndex, node: DesignNode): Rect {
  const origin = parentOrigin(index, node);
  return { x: origin.x + node.x, y: origin.y + node.y, width: node.width, height: node.height };
}

export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContains(rect: Rect, point: Point) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** The innermost visible frame containing a page point, for parenting new nodes. */
export function frameAt(page: DesignPage, index: NodeIndex, point: Point): DesignNode | null {
  let found: DesignNode | null = null;
  for (const node of page.nodes) {
    if (node.type !== "frame" || node.hidden === true) continue;
    if (rectContains(pageRect(index, node), point)) found = node;
  }
  return found;
}

/** Nodes a marquee selects: children of the container it started in that it touches. */
export function marqueeSelection(
  page: DesignPage,
  index: NodeIndex,
  containerId: string | null,
  marquee: Rect,
): string[] {
  return page.nodes
    .filter(
      (node) =>
        node.parentId === containerId &&
        node.hidden !== true &&
        node.locked !== true &&
        rectsIntersect(pageRect(index, node), marquee),
    )
    .map((node) => node.id);
}

/** Snaps the vector from `origin` to `point` to the nearest 45 degrees. */
export function snapAngle(origin: Point, point: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: origin.x + Math.round(Math.cos(angle) * length),
    y: origin.y + Math.round(Math.sin(angle) * length),
  };
}

/** A drag rectangle; Shift makes it square from the start corner. */
export function dragRect(start: Point, end: Point, square: boolean): Rect {
  if (!square) return rectFromPoints(start, end);
  const size = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  return rectFromPoints(start, {
    x: start.x + Math.sign(end.x - start.x || 1) * size,
    y: start.y + Math.sign(end.y - start.y || 1) * size,
  });
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The rect after dragging `handle` by `delta`; Shift keeps the aspect ratio. */
export function resizeRect(rect: Rect, handle: Handle, delta: Point, keepAspect: boolean): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left += delta.x;
  if (handle.includes("e")) right += delta.x;
  if (handle.includes("n")) top += delta.y;
  if (handle.includes("s")) bottom += delta.y;
  let width = Math.abs(right - left);
  let height = Math.abs(bottom - top);
  if (keepAspect && rect.width > 0 && rect.height > 0) {
    const ratio = rect.width / rect.height;
    const horizontal = handle === "e" || handle === "w";
    const vertical = handle === "n" || handle === "s";
    if (horizontal || (!vertical && width / ratio >= height)) height = width / ratio;
    else width = height * ratio;
    if (handle.includes("w")) left = right - width;
    else right = left + width;
    if (handle.includes("n")) top = bottom - height;
    else bottom = top + height;
    if (horizontal) {
      top = rect.y + (rect.height - height) / 2;
      bottom = top + height;
    }
    if (vertical) {
      left = rect.x + (rect.width - width) / 2;
      right = left + width;
    }
  }
  return {
    x: Math.round(Math.min(left, right)),
    y: Math.round(Math.min(top, bottom)),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** Patches that move and scale a node to a new page rect (path points scale too). */
export function placeNodePatch(
  index: NodeIndex,
  node: DesignNode,
  next: Rect,
): Record<string, unknown> {
  const origin = parentOrigin(index, node);
  const patch: Record<string, unknown> = {
    x: Math.round(next.x - origin.x),
    y: Math.round(next.y - origin.y),
    width: Math.round(next.width),
    height: Math.round(next.height),
  };
  if (
    (node.type === "line" || node.type === "path") &&
    (next.width !== node.width || next.height !== node.height)
  ) {
    const sx = node.width === 0 ? 1 : next.width / node.width;
    const sy = node.height === 0 ? 1 : next.height / node.height;
    patch.points = node.points.map(([x, y]) => [
      Math.round(x * sx * 10) / 10,
      Math.round(y * sy * 10) / 10,
    ]);
  }
  return patch;
}

/** Normalises a polyline in page coordinates into a node box plus relative points. */
export function polylineBox(points: readonly Point[]): { rect: Rect; points: [number, number][] } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    rect: {
      x,
      y,
      width: Math.max(1, Math.max(...xs) - x),
      height: Math.max(1, Math.max(...ys) - y),
    },
    points: points.map((point) => [Math.round(point.x - x), Math.round(point.y - y)]),
  };
}

export type Alignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Aligns two or more nodes to their joint bounds; one node aligns to its parent frame. */
export function alignOperations(
  page: DesignPage,
  index: NodeIndex,
  ids: readonly string[],
  alignment: Alignment,
): DesignOperation[] {
  const nodes = ids.map((id) => index.get(id)).filter((node) => node !== undefined);
  if (nodes.length === 0) return [];
  let bounds: Rect | null;
  if (nodes.length === 1) {
    const parent = nodes[0]!.parentId === null ? undefined : index.get(nodes[0]!.parentId);
    if (parent === undefined) return [];
    bounds = pageRect(index, parent);
  } else bounds = unionRect(nodes.map((node) => pageRect(index, node)));
  if (bounds === null) return [];
  const ops: DesignOperation[] = [];
  for (const node of nodes) {
    const rect = pageRect(index, node);
    let { x, y } = rect;
    if (alignment === "left") x = bounds.x;
    if (alignment === "hcenter") x = bounds.x + (bounds.width - rect.width) / 2;
    if (alignment === "right") x = bounds.x + bounds.width - rect.width;
    if (alignment === "top") y = bounds.y;
    if (alignment === "vcenter") y = bounds.y + (bounds.height - rect.height) / 2;
    if (alignment === "bottom") y = bounds.y + bounds.height - rect.height;
    if (x === rect.x && y === rect.y) continue;
    const origin = parentOrigin(index, node);
    ops.push({
      op: "update_node",
      pageId: page.id,
      id: node.id,
      patch: { x: Math.round(x - origin.x), y: Math.round(y - origin.y) },
    });
  }
  return ops;
}

/** Spreads three or more nodes so the gaps between them are equal. */
export function distributeOperations(
  page: DesignPage,
  index: NodeIndex,
  ids: readonly string[],
  axis: "horizontal" | "vertical",
): DesignOperation[] {
  const nodes = ids.map((id) => index.get(id)).filter((node) => node !== undefined);
  if (nodes.length < 3) return [];
  const horizontal = axis === "horizontal";
  const items = nodes
    .map((node) => ({ node, rect: pageRect(index, node) }))
    .sort((a, b) => (horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y));
  const first = items[0]!.rect;
  const last = items.at(-1)!.rect;
  const span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y;
  const total = items.reduce(
    (sum, item) => sum + (horizontal ? item.rect.width : item.rect.height),
    0,
  );
  const gap = (span - total) / (items.length - 1);
  let cursor = horizontal ? first.x : first.y;
  const ops: DesignOperation[] = [];
  for (const { node, rect } of items) {
    const origin = parentOrigin(index, node);
    const value = Math.round(cursor - (horizontal ? origin.x : origin.y));
    const current = horizontal ? node.x : node.y;
    if (value !== current)
      ops.push({
        op: "update_node",
        pageId: page.id,
        id: node.id,
        patch: horizontal ? { x: value } : { y: value },
      });
    cursor += (horizontal ? rect.width : rect.height) + gap;
  }
  return ops;
}

/** Bring forward/back by one step or to the front/back, within the node's siblings. */
export function reorderOperations(
  page: DesignPage,
  ids: readonly string[],
  direction: "forward" | "backward" | "front" | "back",
): DesignOperation[] {
  const ops: DesignOperation[] = [];
  let order = page.nodes.map((node) => node.id);
  const nodes = page.nodes.filter((node) => ids.includes(node.id));
  const sorted = direction === "forward" || direction === "front" ? [...nodes].reverse() : nodes;
  for (const node of sorted) {
    const siblings = order.filter(
      (id) => page.nodes.find((candidate) => candidate.id === id)?.parentId === node.parentId,
    );
    const position = siblings.indexOf(node.id);
    let targetSibling: string | undefined;
    if (direction === "forward") targetSibling = siblings[position + 1];
    if (direction === "backward") targetSibling = siblings[position - 1];
    if (direction === "front") targetSibling = siblings.at(-1);
    if (direction === "back") targetSibling = siblings[0];
    if (targetSibling === undefined || targetSibling === node.id) continue;
    if (ids.includes(targetSibling) && (direction === "forward" || direction === "backward"))
      continue;
    const rest = order.filter((id) => id !== node.id);
    const anchor = rest.indexOf(targetSibling);
    const forwardish = direction === "forward" || direction === "front";
    // After the target and its subtree when moving up, before it when moving down.
    let at = forwardish ? anchor + 1 : anchor;
    if (forwardish) {
      const subtree = subtreeOf(page, targetSibling);
      while (at < rest.length && subtree.has(rest[at]!)) at += 1;
    }
    rest.splice(at, 0, node.id);
    order = rest;
    ops.push({ op: "move_node", pageId: page.id, id: node.id, index: at });
  }
  return ops;
}

function subtreeOf(page: DesignPage, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (const node of page.nodes)
    if (node.parentId !== null && ids.has(node.parentId)) ids.add(node.id);
  return ids;
}

/** Ids whose ancestors are not also in the set; moving a frame moves its children. */
export function topLevelIds(index: NodeIndex, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = index.get(id)?.parentId ?? null;
    while (parent !== null) {
      if (set.has(parent)) return false;
      parent = index.get(parent)?.parentId ?? null;
    }
    return true;
  });
}

/** Top-level frames of a page in paint order: the artboards. */
export function artboards(page: DesignPage): DesignNode[] {
  return page.nodes.filter(
    (node) => node.type === "frame" && node.parentId === null && node.hidden !== true,
  );
}
