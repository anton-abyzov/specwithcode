import type {
  DesignDocument,
  DesignNode,
  DesignPage,
  DesignSystem,
} from "@specweave-studio/contracts";
import { designSubtreeIds } from "@specweave-studio/shared/designOps";
import { designPageBounds, designTokenValue } from "@specweave-studio/shared/designRender";
import { indexNodes, pageRect, unionRect } from "../canvas/geometry";
import { labelFor } from "./PropertiesPanel";

/** Token names a set of nodes references, in first-use order. */
export function usedTokens(nodes: readonly DesignNode[]): string[] {
  const names = new Set<string>();
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.token === "string" && Object.keys(record).length === 1) {
      names.add(record.token);
      return;
    }
    for (const field of Object.values(record)) visit(field);
  };
  for (const node of nodes) visit(node);
  return [...names];
}

/** Design-system components the frame uses directly or whose name matches a layer name. */
export function matchingComponents(nodes: readonly DesignNode[], system: DesignSystem | null) {
  if (system === null) return [];
  const used = new Set(
    nodes.flatMap((node) => (node.type === "component" ? [node.componentId] : [])),
  );
  const names = new Set(
    nodes.flatMap((node) => (node.name === undefined ? [] : [node.name.toLowerCase()])),
  );
  return system.components.filter(
    (component) => used.has(component.id) || names.has(component.name.toLowerCase()),
  );
}

export function frameNodes(page: DesignPage, frameId: string): DesignNode[] {
  const ids = designSubtreeIds(page, frameId);
  return page.nodes.filter((node) => ids.has(node.id));
}

/** The node the selection belongs to for export: the top-level frame that contains it. */
export function containingArtboard(page: DesignPage, id: string): DesignNode | null {
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  let node = byId.get(id);
  while (node !== undefined && node.parentId !== null) node = byId.get(node.parentId);
  return node?.type === "frame" ? node : null;
}

function describe(node: DesignNode) {
  return `${labelFor(node)} (${node.type}, ${Math.round(node.width)}x${Math.round(node.height)}, id ${node.id})`;
}

/**
 * What to export for a PNG of the selection, and where the selection sits in
 * that export: the shared artboard when every selected layer is in one, the
 * whole page otherwise (layers outside frames). Padded by `padding` and
 * clamped to the export.
 */
export function selectionCrop(
  page: DesignPage,
  ids: readonly string[],
  padding = 8,
): { frameId?: string; rect: { x: number; y: number; width: number; height: number } } | null {
  const index = indexNodes(page);
  const rects = ids.flatMap((id) => {
    const node = index.get(id);
    return node === undefined ? [] : [pageRect(index, node)];
  });
  const bounds = unionRect(rects);
  if (bounds === null) return null;
  const frames = new Set(ids.map((id) => containingArtboard(page, id)?.id ?? null));
  const frameId = frames.size === 1 ? [...frames][0]! : null;
  const frame = frameId === null ? undefined : index.get(frameId);
  const origin =
    frame !== undefined
      ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
      : designPageBounds(page);
  const x = Math.max(0, Math.floor(bounds.x - origin.x - padding));
  const y = Math.max(0, Math.floor(bounds.y - origin.y - padding));
  const right = Math.min(origin.width, Math.ceil(bounds.x - origin.x + bounds.width + padding));
  const bottom = Math.min(origin.height, Math.ceil(bounds.y - origin.y + bounds.height + padding));
  const rect = { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  return frame === undefined ? { rect } : { frameId: frame.id, rect };
}

/** The message "Implement this frame" sends with the frame's PNG. */
export function implementFrameMessage(input: {
  document: DesignDocument;
  page: DesignPage;
  frame: DesignNode;
  system: DesignSystem | null;
  mode: string;
  designKey: string;
}): { title: string; text: string } {
  const { document, page, frame, system, mode } = input;
  const nodes = frameNodes(page, frame.id);
  const tokens = usedTokens(nodes);
  const components = matchingComponents(nodes, system);
  const name = frame.name ?? "Frame";
  const lines = [
    `Implement the frame "${name}" from the design "${document.title}" (${input.designKey}, page "${page.name}", revision ${document.revision}) in this codebase.`,
    "",
    "The attached PNG is the frame as rendered. Match it with the project's existing components and tokens; do not hard-code values that a token below already names.",
    "",
    `## Tokens used (${tokens.length})`,
    tokens.length === 0
      ? "None: the frame uses literal values only."
      : tokens
          .map(
            (token) =>
              `- \`${token}\`: ${designTokenValue(system, token, mode) ?? "not in the design system"}`,
          )
          .join("\n"),
    "",
    `## Matching design-system components (${components.length})`,
    components.length === 0
      ? system === null
        ? "The design has no design system."
        : "None matched by component instance or layer name."
      : components
          .map(
            (component) =>
              `- ${component.name}${component.importPath === undefined ? "" : ` from \`${component.importPath}\``}${component.exportName === undefined ? "" : ` (export \`${component.exportName}\`)`}`,
          )
          .join("\n"),
    "",
    `## Frame JSON (${nodes.length} nodes; x and y are relative to each node's parent frame)`,
    "```json",
    JSON.stringify(
      { frame: { id: frame.id, name, width: frame.width, height: frame.height }, nodes },
      null,
      1,
    ),
    "```",
  ];
  return { title: `Implement ${name}`, text: lines.join("\n") };
}

/** Short description of the selection for "Ask agent". */
export function selectionMessage(input: {
  document: DesignDocument;
  page: DesignPage;
  ids: readonly string[];
  designKey: string;
  request: string;
}): string {
  const byId = new Map(input.page.nodes.map((node) => [node.id, node]));
  const nodes = input.ids.map((id) => byId.get(id)).filter((node) => node !== undefined);
  return [
    input.request.trim() === "" ? "Look at this selection on the canvas." : input.request.trim(),
    "",
    `Design "${input.document.title}" (${input.designKey}), page "${input.page.name}" (${input.page.id}), revision ${input.document.revision}.`,
    `Selected ${nodes.length === 1 ? "layer" : "layers"}: ${nodes.map(describe).join("; ")}.`,
    "The attached PNG shows the frame that contains the selection. Read and change it with the design tools (design_get, design_apply).",
  ].join("\n");
}
