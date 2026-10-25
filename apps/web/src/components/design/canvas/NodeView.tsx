import type { DesignNode, DesignPage } from "@specweave-studio/contracts";
import {
  designComponentSrcdoc,
  designHtmlSrcdoc,
  designNodeStyle,
  designPathData,
  resolveDesignPaint,
  type DesignRenderContext,
} from "@specweave-studio/shared/designRender";
import { ImageIcon } from "lucide-react";
import { createContext, memo, useContext, useMemo, useRef, type CSSProperties } from "react";

/**
 * Renders design nodes as absolutely positioned DOM from the shared
 * `designNodeStyle`, the same function thumbnails and exports use. Agent HTML
 * and component previews run in opaque-origin sandboxed frames.
 */

export const DesignRenderContextValue = createContext<DesignRenderContext>({
  system: null,
  mode: "light",
  assetUrl: () => "",
});

type Children = ReadonlyMap<string | null, readonly DesignNode[]>;

const ChildrenContext = createContext<Children>(new Map());

const camelCache = new Map<string, string>();
function camel(key: string) {
  let out = camelCache.get(key);
  if (out === undefined) {
    out = key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    camelCache.set(key, out);
  }
  return out;
}

export function reactStyle(style: Readonly<Record<string, string | number>>): CSSProperties {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(style)) out[camel(key)] = value;
  return out as CSSProperties;
}

/**
 * Children by parent, keeping the previous array for a parent whose children
 * are all the same objects, so memoised node views skip unchanged subtrees.
 */
export function useStableChildren(page: DesignPage): Children {
  const previous = useRef<Children>(new Map());
  return useMemo(() => {
    const next = new Map<string | null, DesignNode[]>();
    for (const node of page.nodes) {
      const list = next.get(node.parentId);
      if (list === undefined) next.set(node.parentId, [node]);
      else list.push(node);
    }
    const stable = new Map<string | null, readonly DesignNode[]>();
    for (const [parent, list] of next) {
      const old = previous.current.get(parent);
      stable.set(
        parent,
        old !== undefined && old.length === list.length && old.every((node, i) => node === list[i])
          ? old
          : list,
      );
    }
    previous.current = stable;
    return stable;
  }, [page.nodes]);
}

export function DesignPageView({
  page,
  editingId,
}: {
  page: DesignPage;
  editingId?: string | null;
}) {
  const children = useStableChildren(page);
  const roots = children.get(null) ?? [];
  return (
    <ChildrenContext value={children}>
      {roots.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          kids={children.get(node.id)}
          editingId={editingId ?? null}
        />
      ))}
    </ChildrenContext>
  );
}

interface NodeViewProps {
  readonly node: DesignNode;
  readonly kids: readonly DesignNode[] | undefined;
  /** The text being edited in place, at any depth (a title inside a slide too): it hides under its field. */
  readonly editingId?: string | null;
}

export const NodeView = memo(function NodeView({ node, kids, editingId = null }: NodeViewProps) {
  const context = useContext(DesignRenderContextValue);
  const children = useContext(ChildrenContext);
  const style = useMemo(() => reactStyle(designNodeStyle(node, context)), [node, context]);
  const common = {
    "data-node": node.id,
    "data-type": node.type,
    ...(node.name === undefined ? {} : { "data-name": node.name }),
  };
  const inner = kids?.map((child) => (
    <NodeView key={child.id} node={child} kids={children.get(child.id)} editingId={editingId} />
  ));
  switch (node.type) {
    case "frame":
    case "rect":
    case "ellipse":
      return (
        <div {...common} style={style}>
          {inner}
        </div>
      );
    case "text":
    case "note":
      return (
        <div {...common} style={node.id === editingId ? { ...style, visibility: "hidden" } : style}>
          {node.text}
        </div>
      );
    case "image": {
      const src = context.assetUrl(node.asset);
      return (
        <div {...common} style={style}>
          {src === "" ? (
            // The signed URL has not resolved yet (or the asset is missing): a neutral box keeps the layout.
            <div
              className="grid size-full place-items-center bg-muted text-muted-foreground"
              aria-label={node.alt ?? "Image"}
              role="img"
            >
              <ImageIcon aria-hidden className="size-6 opacity-60" />
            </div>
          ) : (
            <img
              src={src}
              alt={node.alt ?? ""}
              draggable={false}
              className="pointer-events-none block size-full"
              style={{ objectFit: node.fit ?? "cover" }}
            />
          )}
        </div>
      );
    }
    case "line":
    case "path":
      return <PathView node={node} style={style} common={common} />;
    case "html":
      return (
        <div {...common} style={style}>
          <SandboxFrame
            srcDoc={designHtmlSrcdoc(node, context)}
            scripts
            title={node.name ?? "HTML"}
          />
        </div>
      );
    case "component":
      return (
        <div {...common} style={style}>
          <SandboxFrame
            srcDoc={designComponentSrcdoc(node, context)}
            scripts={false}
            title={node.name ?? node.componentId}
          />
        </div>
      );
  }
});

function PathView({
  node,
  style,
  common,
}: {
  node: Extract<DesignNode, { type: "line" | "path" }>;
  style: CSSProperties;
  common: Record<string, string>;
}) {
  const context = useContext(DesignRenderContextValue);
  const stroke = resolveDesignPaint(node.stroke, context) ?? "#1f1d24";
  const fill = node.type === "path" ? (resolveDesignPaint(node.fill, context) ?? "none") : "none";
  return (
    <svg
      {...common}
      style={{ ...style, overflow: "visible" }}
      width={node.width}
      height={node.height}
      viewBox={`0 0 ${Math.max(node.width, 1)} ${Math.max(node.height, 1)}`}
    >
      {/* A wide transparent stroke makes thin lines easy to pick. */}
      <path
        d={designPathData(node.points, node.closed === true)}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
      />
      <path
        d={designPathData(node.points, node.closed === true)}
        fill={fill}
        stroke={stroke}
        strokeWidth={node.strokeWidth ?? 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * An opaque-origin frame: `allow-scripts` for agent HTML, nothing for
 * component previews, never `allow-same-origin`. It ignores the pointer so
 * the canvas can select and move the node.
 */
export function SandboxFrame({
  srcDoc,
  scripts,
  title,
}: {
  srcDoc: string;
  scripts: boolean;
  title: string;
}) {
  return (
    <iframe
      title={title}
      sandbox={scripts ? "allow-scripts" : ""}
      srcDoc={srcDoc}
      loading="lazy"
      tabIndex={-1}
      className="pointer-events-none block size-full border-0 [color-scheme:light]"
    />
  );
}
