import type {
  DesignComment,
  DesignNode,
  DesignOperation,
  DesignPage,
} from "@specweave-studio/contracts";
import { designNodeStyle } from "@specweave-studio/shared/designRender";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";
import type { DesignSession } from "../editor/designSession";
import type { CameraStore } from "./camera";
import {
  alignOperations,
  artboards,
  indexNodes,
  marqueeSelection,
  pageRect,
  placeNodePatch,
  rectFromPoints,
  reorderOperations,
  resizeRect,
  screenToPage,
  topLevelIds,
  unionRect,
  type Alignment,
  type Handle,
  type NodeIndex,
  type Point,
  type Rect,
} from "./geometry";
import { DesignPageView, DesignRenderContextValue, reactStyle } from "./NodeView";
import {
  Box,
  CommentPins,
  DraftPolyline,
  FrameLabels,
  HoverOutline,
  SelectionOutline,
} from "./SelectionLayer";
import {
  createBoxNode,
  createLineNode,
  createPenNode,
  duplicateOperations,
  penPoint,
  toolForKey,
  type CanvasTool,
} from "./tools";

export interface DesignCanvasProps {
  readonly session: DesignSession;
  readonly page: DesignPage;
  readonly comments: readonly DesignComment[];
  readonly camera: CameraStore;
  readonly tool: CanvasTool;
  readonly onToolChange: (tool: CanvasTool) => void;
  readonly selection: readonly string[];
  readonly onSelectionChange: (ids: readonly string[]) => void;
  /** Edits are refused (view or comment access): only select, hand and comment work. */
  readonly readOnly: boolean;
  /** Comment tool and C key; view-only collaborators cannot comment. */
  readonly canComment: boolean;
  readonly activeCommentId: string | null;
  readonly onOpenComment: (comment: DesignComment) => void;
  readonly onPlaceComment: (anchor: { nodeId: string | null; x: number; y: number }) => void;
  readonly onPickImage: (at: Point) => void;
  readonly onDropFiles: (files: readonly File[], at: Point) => void;
  readonly onExportFrame: (frame: DesignNode, anchor: HTMLElement) => void;
  readonly onError: (detail: string) => void;
  /** Floats above the selection (the selection toolbar). */
  readonly accessory?: ReactNode;
}

type Gesture =
  | { kind: "pan"; last: Point }
  | {
      kind: "move";
      start: Point;
      ids: readonly string[];
      /** The moved nodes as they were at pointer down; previews replace the live page. */
      origins: readonly DesignNode[];
      moved: boolean;
      /** Click on an already selected node inside a multi-selection: select it alone on release. */
      collapseTo: string | null;
    }
  | { kind: "resize"; start: Point; node: DesignNode; rect: Rect; handle: Handle }
  | { kind: "marquee"; start: Point; container: string | null; base: readonly string[] }
  | { kind: "box"; tool: "frame" | "rect" | "ellipse" | "text" | "note"; start: Point }
  | { kind: "line"; start: Point };

type Draft =
  | { kind: "rect"; rect: Rect; round?: boolean }
  | { kind: "line"; from: Point; to: Point }
  | null;

interface Editing {
  readonly node: Extract<DesignNode, { type: "text" | "note" }>;
  readonly isNew: boolean;
}

const EDIT_TOOLS = new Set<CanvasTool>([
  "frame",
  "rect",
  "ellipse",
  "line",
  "pen",
  "text",
  "note",
  "image",
]);

const MemoPage = memo(DesignPageView);

export function DesignCanvas(props: DesignCanvasProps) {
  const {
    session,
    page,
    camera,
    tool,
    selection,
    onSelectionChange,
    onToolChange,
    readOnly,
    canComment,
    onError,
  } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pendingMove = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const moveFrame = useRef(0);
  const [draft, setDraft] = useState<Draft>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [pen, setPen] = useState<{ points: Point[]; cursor: Point | null } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  // Enter and blur can both finish one edit; the ref lets only the first one commit.
  const editingRef = useRef(editing);
  useLayoutEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  const [spaceDown, setSpaceDown] = useState(false);
  const index = useMemo(() => indexNodes(page), [page]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const renderContext = useContext(DesignRenderContextValue);
  const effectiveTool: CanvasTool = spaceDown ? "hand" : tool;
  const frameCount = useMemo(() => artboards(page).length, [page]);

  useEffect(() => {
    camera.attach(worldRef.current, viewportRef.current);
    return () => camera.attach(null, null);
  }, [camera]);

  // Selection that points at deleted nodes (undo, agent edits) drops them.
  useEffect(() => {
    const kept = selection.filter((id) => index.has(id));
    if (kept.length !== selection.length) onSelectionChange(kept);
  }, [index, selection, onSelectionChange]);

  useEffect(() => {
    if (tool !== "pen") setPen(null);
  }, [tool]);

  const commit = useCallback(
    (operations: readonly DesignOperation[]) => {
      if (operations.length === 0) return true;
      const result = session.commit(operations);
      if (!result.ok) onError(result.detail);
      return result.ok;
    },
    [session, onError],
  );

  const pagePoint = useCallback(
    (clientX: number, clientY: number) =>
      screenToPage(camera.get(), camera.localPoint(clientX, clientY)),
    [camera],
  );

  // ---- wheel: pan, Cmd/Ctrl + wheel and trackpad pinch zoom -------------
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = camera.get();
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
        camera.zoomTo(current.zoom * factor, camera.localPoint(event.clientX, event.clientY));
      } else {
        const scale = event.deltaMode === 1 ? 16 : 1;
        camera.panBy(
          -(event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * scale,
          -(event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * scale,
        );
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [camera]);

  // ---- hit testing -------------------------------------------------------
  const hitNode = useCallback(
    (target: EventTarget | null): DesignNode | null => {
      let element = target instanceof Element ? target.closest<HTMLElement>("[data-node]") : null;
      while (element !== null) {
        const node = index.get(element.dataset.node ?? "");
        if (node !== undefined && node.locked !== true) {
          // An artboard with content is picked by its label; its empty area starts a marquee.
          const isArtboardWithContent =
            node.type === "frame" &&
            node.parentId === null &&
            page.nodes.some((child) => child.parentId === node.id);
          if (!isArtboardWithContent) return node;
          return null;
        }
        element = element.parentElement?.closest<HTMLElement>("[data-node]") ?? null;
      }
      return null;
    },
    [index, page.nodes],
  );

  const containerAt = useCallback(
    (target: EventTarget | null): string | null => {
      const element = target instanceof Element ? target.closest<HTMLElement>("[data-node]") : null;
      const node = element === null ? undefined : index.get(element.dataset.node ?? "");
      if (node === undefined) return null;
      return node.type === "frame" ? node.id : node.parentId;
    },
    [index],
  );

  // ---- move / resize previews -------------------------------------------
  const moveOrigins = useCallback(
    (ids: readonly string[]): DesignNode[] =>
      topLevelIds(index, ids).flatMap((id) => {
        const node = index.get(id);
        return node === undefined || node.locked === true ? [] : [node];
      }),
    [index],
  );
  const movePreview = useCallback(
    (origins: readonly DesignNode[], dx: number, dy: number): DesignOperation[] =>
      origins.map((node) => ({
        op: "update_node" as const,
        pageId: page.id,
        id: node.id,
        patch: { x: Math.round(node.x + dx), y: Math.round(node.y + dy) },
      })),
    [page.id],
  );

  const processMove = useCallback(() => {
    moveFrame.current = 0;
    const move = pendingMove.current;
    const active = gesture.current;
    if (move === null || active === null) return;
    const point = pagePoint(move.x, move.y);
    switch (active.kind) {
      case "move": {
        let dx = point.x - active.start.x;
        let dy = point.y - active.start.y;
        if (!active.moved && Math.hypot(dx, dy) * camera.get().zoom < 3) return;
        active.moved = true;
        if (move.shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        session.setPreview(movePreview(active.origins, dx, dy));
        return;
      }
      case "resize": {
        const node = active.node;
        const next = resizeRect(
          active.rect,
          active.handle,
          { x: point.x - active.start.x, y: point.y - active.start.y },
          move.shift,
        );
        session.setPreview([
          {
            op: "update_node",
            pageId: page.id,
            id: node.id,
            patch: placeNodePatch(index, node, next),
          },
        ]);
        return;
      }
      case "marquee": {
        const rect = rectFromPoints(active.start, point);
        setMarquee(rect);
        const hits = marqueeSelection(page, index, active.container, rect);
        onSelectionChange(
          active.base.length === 0 ? hits : [...new Set([...active.base, ...hits])],
        );
        return;
      }
      case "box": {
        const rect = move.shift
          ? (() => {
              const size = Math.max(
                Math.abs(point.x - active.start.x),
                Math.abs(point.y - active.start.y),
              );
              return rectFromPoints(active.start, {
                x: active.start.x + Math.sign(point.x - active.start.x || 1) * size,
                y: active.start.y + Math.sign(point.y - active.start.y || 1) * size,
              });
            })()
          : rectFromPoints(active.start, point);
        setDraft({ kind: "rect", rect, round: active.tool === "ellipse" });
        return;
      }
      case "line": {
        const result = createLineNode({ page, index }, active.start, point, move.shift);
        setDraft(
          result === null
            ? null
            : { kind: "line", from: active.start, to: lineEnd(result.node, index) },
        );
        return;
      }
      case "pan":
        return;
    }
  }, [camera, index, movePreview, onSelectionChange, page, pagePoint, session]);

  // ---- pointer handlers ---------------------------------------------------
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || (event.button === 0 && effectiveTool === "hand")) {
      gesture.current = { kind: "pan", last: { x: event.clientX, y: event.clientY } };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (editing !== null) {
      finishEditing();
      return;
    }
    viewportRef.current?.focus({ preventScroll: true });
    const point = pagePoint(event.clientX, event.clientY);
    const activeTool = toolAllowed(effectiveTool) ? effectiveTool : "select";
    switch (activeTool) {
      case "comment": {
        const node = hitNode(event.target);
        const anchor = node === null ? null : pageRect(index, node);
        props.onPlaceComment(
          anchor === null || node === null
            ? { nodeId: null, x: Math.round(point.x), y: Math.round(point.y) }
            : {
                nodeId: node.id,
                x: Math.round(point.x - anchor.x),
                y: Math.round(point.y - anchor.y),
              },
        );
        return;
      }
      case "image":
        props.onPickImage(point);
        return;
      case "pen": {
        const points = pen?.points ?? [];
        const next = penPoint(points, point, event.shiftKey);
        const first = points[0];
        if (
          first !== undefined &&
          points.length >= 2 &&
          Math.hypot(next.x - first.x, next.y - first.y) * camera.get().zoom < 8
        ) {
          finishPen(true);
          return;
        }
        if (event.detail >= 2 && points.length >= 2) {
          finishPen(false);
          return;
        }
        setPen({ points: [...points, next], cursor: next });
        return;
      }
      case "line":
        gesture.current = { kind: "line", start: point };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      case "frame":
      case "rect":
      case "ellipse":
      case "text":
      case "note":
        gesture.current = { kind: "box", tool: activeTool, start: point };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      case "hand":
        return;
      case "select": {
        const node = hitNode(event.target);
        if (node === null) {
          gesture.current = {
            kind: "marquee",
            start: point,
            container: containerAt(event.target),
            base: event.shiftKey ? selection : [],
          };
          if (!event.shiftKey) onSelectionChange([]);
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        if (event.detail >= 2 && (node.type === "text" || node.type === "note") && !readOnly) {
          setEditing({ node, isNew: false });
          return;
        }
        let ids = selection;
        let collapseTo: string | null = null;
        if (event.shiftKey) {
          ids = selected.has(node.id)
            ? selection.filter((id) => id !== node.id)
            : [...selection, node.id];
          onSelectionChange(ids);
          if (!ids.includes(node.id)) return;
        } else if (!selected.has(node.id)) {
          ids = [node.id];
          onSelectionChange(ids);
        } else if (selection.length > 1) collapseTo = node.id;
        if (readOnly) return;
        gesture.current = {
          kind: "move",
          start: point,
          ids,
          origins: moveOrigins(ids),
          moved: false,
          collapseTo,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active?.kind === "pan") {
      camera.panBy(event.clientX - active.last.x, event.clientY - active.last.y);
      active.last = { x: event.clientX, y: event.clientY };
      return;
    }
    if (active === null) {
      if (pen !== null)
        setPen({
          ...pen,
          cursor: penPoint(pen.points, pagePoint(event.clientX, event.clientY), event.shiftKey),
        });
      else if (effectiveTool === "select" && event.buttons === 0) {
        const node = hitNode(event.target);
        const id = node?.id ?? null;
        if (id !== hover) setHover(id);
      }
      return;
    }
    pendingMove.current = { x: event.clientX, y: event.clientY, shift: event.shiftKey };
    if (moveFrame.current === 0) moveFrame.current = requestAnimationFrame(processMove);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    gesture.current = null;
    if (moveFrame.current !== 0) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
    }
    if (active === null) return;
    const point = pagePoint(event.clientX, event.clientY);
    switch (active.kind) {
      case "move": {
        if (!active.moved) {
          session.setPreview(null);
          if (active.collapseTo !== null) onSelectionChange([active.collapseTo]);
          return;
        }
        let dx = point.x - active.start.x;
        let dy = point.y - active.start.y;
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        commit(movePreview(active.origins, dx, dy));
        return;
      }
      case "resize": {
        const node = active.node;
        const next = resizeRect(
          active.rect,
          active.handle,
          { x: point.x - active.start.x, y: point.y - active.start.y },
          event.shiftKey,
        );
        commit([
          {
            op: "update_node",
            pageId: page.id,
            id: node.id,
            patch: placeNodePatch(index, node, next),
          },
        ]);
        return;
      }
      case "marquee":
        setMarquee(null);
        return;
      case "box": {
        setDraft(null);
        const { node, operation } = createBoxNode(
          active.tool,
          { page, index, frameCount },
          active.start,
          point,
          event.shiftKey,
        );
        if (node.type === "text" || node.type === "note") {
          setEditing({ node, isNew: true });
          return;
        }
        if (commit([operation])) {
          onSelectionChange([node.id]);
          onToolChange("select");
        }
        return;
      }
      case "line": {
        setDraft(null);
        const result = createLineNode({ page, index }, active.start, point, event.shiftKey);
        if (result !== null && commit([result.operation])) {
          onSelectionChange([result.node.id]);
          onToolChange("select");
        }
        return;
      }
      case "pan":
        return;
    }
  };

  const finishPen = (closed: boolean) => {
    const points = pen?.points ?? [];
    setPen(null);
    const result = createPenNode({ page, index }, points, closed);
    if (result !== null && commit([result.operation])) {
      onSelectionChange([result.node.id]);
      onToolChange("select");
    }
  };

  // ---- text editing --------------------------------------------------------
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const finishEditing = useCallback(() => {
    const current = editingRef.current;
    const field = editorRef.current;
    editingRef.current = null;
    setEditing(null);
    if (current === null || field === null) return;
    const text = field.value;
    const height = Math.max(current.node.height, Math.ceil(field.scrollHeight));
    if (current.isNew) {
      if (text.trim() === "") return;
      const node = { ...current.node, text, ...(current.node.type === "text" ? { height } : {}) };
      if (commit([{ op: "add_node", pageId: page.id, node }])) {
        onSelectionChange([node.id]);
        onToolChange("select");
      }
    } else if (text !== current.node.text) {
      commit([
        {
          op: "update_node",
          pageId: page.id,
          id: current.node.id,
          patch: {
            text,
            ...(current.node.type === "text" && height !== current.node.height ? { height } : {}),
          },
        },
      ]);
    }
    viewportRef.current?.focus({ preventScroll: true });
  }, [commit, onSelectionChange, onToolChange, page.id]);

  useEffect(() => {
    if (editing === null) return;
    const field = editorRef.current;
    field?.focus();
    field?.select();
  }, [editing]);

  // ---- keyboard ------------------------------------------------------------
  const toolAllowed = (candidate: CanvasTool) =>
    !(readOnly && EDIT_TOOLS.has(candidate)) && (candidate !== "comment" || canComment);
  const nudge = (dx: number, dy: number) => commit(movePreview(moveOrigins(selection), dx, dy));

  const createAtCenter = (activeTool: CanvasTool) => {
    const size = camera.viewportSize();
    const center = screenToPage(camera.get(), { x: size.width / 2, y: size.height / 2 });
    if (activeTool === "image") {
      props.onPickImage(center);
      return;
    }
    if (activeTool === "line") {
      const result = createLineNode(
        { page, index },
        center,
        { x: center.x + 160, y: center.y },
        false,
      );
      if (result !== null && commit([result.operation])) onSelectionChange([result.node.id]);
      onToolChange("select");
      return;
    }
    if (activeTool === "pen") {
      if (pen !== null && pen.points.length >= 2) finishPen(false);
      return;
    }
    if (activeTool === "comment") {
      const target = selection.length === 1 ? index.get(selection[0]!) : undefined;
      props.onPlaceComment(
        target === undefined
          ? { nodeId: null, x: Math.round(center.x), y: Math.round(center.y) }
          : { nodeId: target.id, x: 8, y: 8 },
      );
      return;
    }
    if (activeTool === "select" || activeTool === "hand") return;
    const { node, operation } = createBoxNode(
      activeTool,
      { page, index, frameCount },
      center,
      center,
      false,
    );
    if (node.type === "text" || node.type === "note") {
      setEditing({ node, isNew: true });
      return;
    }
    if (commit([operation])) onSelectionChange([node.id]);
    onToolChange("select");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    let handled = true;
    if (mod && !event.altKey && key.toLowerCase() === "z") {
      // Still handled when read-only, so the app's own undo never fires from the canvas.
      if (!readOnly) {
        const result = event.shiftKey ? session.redo() : session.undo();
        if (!result.ok) onError(result.detail);
      }
    } else if (mod && !event.altKey && key.toLowerCase() === "y") {
      if (!readOnly) {
        const result = session.redo();
        if (!result.ok) onError(result.detail);
      }
    } else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === "d" && !readOnly) {
      const { operations, newIds } = duplicateOperations(page, topLevelIds(index, selection), 16);
      if (commit(operations)) onSelectionChange(newIds);
    } else if (mod && !event.shiftKey && !event.altKey && key.toLowerCase() === "a") {
      const container = selection.length > 0 ? (index.get(selection[0]!)?.parentId ?? null) : null;
      onSelectionChange(
        page.nodes
          .filter(
            (node) => node.parentId === container && node.locked !== true && node.hidden !== true,
          )
          .map((node) => node.id),
      );
    } else if (mod) {
      handled = false;
    } else if (
      event.altKey &&
      !readOnly &&
      selection.length > 0 &&
      ALIGN_KEYS[event.code] !== undefined
    ) {
      commit(alignOperations(page, index, selection, ALIGN_KEYS[event.code]!));
    } else if (key === " ") {
      if (!event.repeat) setSpaceDown(true);
    } else if (key === "Escape") {
      if (pen !== null) setPen(null);
      else if (tool !== "select") onToolChange("select");
      else if (selection.length > 0) {
        const parent = selection.length === 1 ? (index.get(selection[0]!)?.parentId ?? null) : null;
        onSelectionChange(parent === null ? [] : [parent]);
      } else handled = false;
    } else if (key === "Enter") {
      if (tool !== "select" && tool !== "hand") createAtCenter(tool);
      else if (selection.length === 1) {
        const node = index.get(selection[0]!);
        if ((node?.type === "text" || node?.type === "note") && !readOnly)
          setEditing({ node, isNew: false });
        else if (node !== undefined) {
          const child = page.nodes.find((candidate) => candidate.parentId === node.id);
          if (child !== undefined) onSelectionChange([child.id]);
        }
      } else handled = false;
    } else if ((key === "Delete" || key === "Backspace") && !readOnly) {
      commit(
        topLevelIds(index, selection).map((id) => ({
          op: "delete_node" as const,
          pageId: page.id,
          id,
        })),
      );
      onSelectionChange([]);
    } else if (key.startsWith("Arrow") && selection.length > 0 && !readOnly) {
      const step = event.shiftKey ? 10 : 1;
      nudge(
        key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0,
        key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0,
      );
    } else if (key === "Tab" && selection.length > 0) {
      // With nothing selected Tab leaves the canvas, so focus is never trapped here.
      const container =
        selection.length > 0 ? (index.get(selection.at(-1)!)?.parentId ?? null) : null;
      const siblings = page.nodes.filter(
        (node) => node.parentId === container && node.hidden !== true,
      );
      if (siblings.length === 0) handled = false;
      else {
        const at =
          selection.length > 0 ? siblings.findIndex((node) => node.id === selection.at(-1)) : -1;
        const next =
          siblings[(at + (event.shiftKey ? -1 : 1) + siblings.length) % siblings.length]!;
        onSelectionChange([next.id]);
      }
    } else if (
      (key === "]" || key === "[" || key === "}" || key === "{") &&
      selection.length > 0 &&
      !readOnly
    ) {
      const direction =
        key === "]" ? "forward" : key === "[" ? "backward" : key === "}" ? "front" : "back";
      commit(reorderOperations(page, selection, direction));
    } else if (
      event.shiftKey &&
      (event.code === "Digit1" || event.code === "Digit2" || event.code === "Digit0")
    ) {
      if (event.code === "Digit0") camera.zoomTo(1);
      else zoomTo(event.code === "Digit2" ? "selection" : "fit");
    } else if (!event.shiftKey && !event.altKey && toolForKey(key) !== null) {
      const next = toolForKey(key)!;
      if (!toolAllowed(next)) handled = false;
      else onToolChange(next);
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === " ") setSpaceDown(false);
  };

  const zoomTo = (target: "fit" | "selection") =>
    zoomToContent(camera, page, target === "selection" ? selection : []);

  // ---- resize handles -------------------------------------------------------
  const onHandlePointerDown = (event: ReactPointerEvent, handle: Handle) => {
    event.stopPropagation();
    if (selection.length !== 1 || readOnly) return;
    const node = index.get(selection[0]!);
    if (node === undefined) return;
    gesture.current = {
      kind: "resize",
      start: pagePoint(event.clientX, event.clientY),
      node,
      rect: pageRect(index, node),
      handle,
    };
    viewportRef.current?.setPointerCapture(event.pointerId);
  };

  const onLabelPointerDown = (event: ReactPointerEvent, frame: DesignNode) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    viewportRef.current?.focus({ preventScroll: true });
    const ids = event.shiftKey
      ? [...new Set([...selection, frame.id])]
      : selected.has(frame.id)
        ? selection
        : [frame.id];
    onSelectionChange(ids);
    if (readOnly) return;
    gesture.current = {
      kind: "move",
      start: pagePoint(event.clientX, event.clientY),
      ids,
      origins: moveOrigins(ids),
      moved: false,
      collapseTo: null,
    };
    viewportRef.current?.setPointerCapture(event.pointerId);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0 || readOnly) return;
    event.preventDefault();
    props.onDropFiles(files, pagePoint(event.clientX, event.clientY));
  };

  const cursor =
    effectiveTool === "hand"
      ? gesture.current?.kind === "pan"
        ? "grabbing"
        : "grab"
      : effectiveTool === "select"
        ? "default"
        : effectiveTool === "text"
          ? "text"
          : "crosshair";

  const editingStyle = useMemo(() => {
    if (editing === null) return null;
    const at = pageRect(index, editing.node);
    const style = reactStyle(designNodeStyle(editing.node, renderContext));
    return {
      ...style,
      left: `${at.x}px`,
      top: `${at.y}px`,
      height: editing.node.type === "text" ? undefined : style.height,
      minHeight: `${editing.node.height}px`,
      resize: "none" as const,
      outline: "none",
      boxShadow: "0 0 0 calc(1.5px / var(--zoom)) var(--color-primary)",
      background: editing.node.type === "note" ? style.background : "transparent",
    };
  }, [editing, index, renderContext]);

  const selectionBounds = useMemo(
    () =>
      unionRect(
        selection
          .map((id) => index.get(id))
          .filter((node) => node !== undefined)
          .map((node) => pageRect(index, node)),
      ),
    [index, selection],
  );

  const pageComments = useMemo(
    () => props.comments.filter((comment) => comment.pageId === page.id),
    [page.id, props.comments],
  );

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      role="application"
      aria-label="Design canvas"
      aria-roledescription="canvas"
      data-testid="design-canvas"
      className="relative min-h-0 flex-1 touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset"
      style={{ cursor, background: CANVAS_GROUND }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => setSpaceDown(false)}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDrop={onDrop}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={worldRef}
        className="absolute top-0 left-0 origin-top-left will-change-transform"
        data-testid="design-world"
      >
        <MemoPage page={page} editingId={editing?.isNew === false ? editing.node.id : null} />
        <div className="pointer-events-none absolute top-0 left-0 [&_button]:pointer-events-auto [&_[data-handle]]:pointer-events-auto">
          <FrameLabels
            page={page}
            selected={selected}
            onLabelPointerDown={onLabelPointerDown}
            onExport={props.onExportFrame}
            onFocus={(frame) => camera.fit(pageRect(index, frame))}
          />
          {hover !== null && !selected.has(hover) && <HoverOutline index={index} id={hover} />}
          <SelectionOutline
            index={index}
            ids={selection}
            showHandles={selection.length === 1 && !readOnly && editing === null}
            onHandlePointerDown={onHandlePointerDown}
          />
          {marquee !== null && <Box rect={marquee} className="border-primary bg-primary/10" />}
          {draft?.kind === "rect" && (
            <Box rect={draft.rect} className="border-primary" round={draft.round === true} />
          )}
          {draft?.kind === "line" && (
            <DraftPolyline points={[draft.from, draft.to]} cursor={null} />
          )}
          {pen !== null && <DraftPolyline points={pen.points} cursor={pen.cursor} />}
          {props.accessory !== undefined &&
            props.accessory !== null &&
            selectionBounds !== null &&
            editing === null && (
              <div
                className="absolute origin-top-left [transform:scale(calc(1/var(--zoom)))_translate(-50%,calc(-100%-10px))] [&_*]:pointer-events-auto"
                style={{
                  left: `${selectionBounds.x + selectionBounds.width / 2}px`,
                  top: `${selectionBounds.y}px`,
                }}
              >
                {props.accessory}
              </div>
            )}
          <CommentPins
            index={index}
            comments={pageComments}
            activeId={props.activeCommentId}
            onOpen={props.onOpenComment}
          />
        </div>
        {editing !== null && editingStyle !== null && (
          <textarea
            ref={editorRef}
            aria-label={editing.node.type === "note" ? "Note text" : "Text"}
            defaultValue={editing.node.text}
            className="absolute z-10 m-0 overflow-hidden border-0 p-0 caret-primary"
            style={editingStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onInput={(event) => {
              const field = event.currentTarget;
              field.style.height = "auto";
              field.style.height = `${field.scrollHeight}px`;
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (
                event.key === "Escape" ||
                (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault();
                finishEditing();
              }
            }}
            onBlur={finishEditing}
          />
        )}
      </div>
      {pen !== null && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground shadow-sm">
          Click to add points. Double-click or Enter to finish, click the first point to close, Esc
          to cancel.
        </div>
      )}
    </div>
  );
}

/** A quiet neutral a step off the app background, in light and dark and any palette. */
const CANVAS_GROUND = "color-mix(in oklab, var(--background) 94%, var(--foreground) 6%)";

const ALIGN_KEYS: Record<string, Alignment> = {
  KeyA: "left",
  KeyD: "right",
  KeyW: "top",
  KeyS: "bottom",
  KeyH: "hcenter",
  KeyV: "vcenter",
};

function lineEnd(node: DesignNode, index: NodeIndex): Point {
  const rect = pageRect(index, node);
  if (node.type !== "line") return { x: rect.x, y: rect.y };
  const last = node.points.at(-1)!;
  return { x: rect.x + last[0], y: rect.y + last[1] };
}

/** Fits the page's top-level content, or the given nodes (zoom to selection, at most 400%). */
export function zoomToContent(camera: CameraStore, page: DesignPage, ids: readonly string[]) {
  const index = indexNodes(page);
  const nodes =
    ids.length > 0
      ? ids.map((id) => index.get(id)).filter((node) => node !== undefined)
      : page.nodes.filter((node) => node.parentId === null && node.hidden !== true);
  const bounds = unionRect(nodes.map((node) => pageRect(index, node)));
  if (bounds !== null) camera.fit(bounds, ids.length > 0 ? 4 : 1);
}
