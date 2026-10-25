import type {
  DesignDocument,
  DesignNode,
  DesignPage,
  DesignSystem,
  DesignThreadBinding,
} from "@specweave-studio/contracts";
import { designSubtreeIds } from "@specweave-studio/shared/designOps";
import { designPageBounds, designTokenValue } from "@specweave-studio/shared/designRender";
import { indexNodes, pageRect, unionRect } from "../canvas/geometry";
import type { DesignEditorBackend, DesignImage, DesignMessage } from "./backend";
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
  /** Why the frame's PNG could not be rendered; the message then goes without one. */
  pngProblem?: string | null;
}): { title: string; text: string } {
  const { document, page, frame, system, mode } = input;
  const pngProblem = input.pngProblem?.trim().replace(/[.!]+$/, "") ?? null;
  const nodes = frameNodes(page, frame.id);
  const tokens = usedTokens(nodes);
  const components = matchingComponents(nodes, system);
  const name = frame.name ?? "Frame";
  const lines = [
    `Implement the frame "${name}" from the design "${document.title}" (${input.designKey}, page "${page.name}", revision ${document.revision}) in this codebase.`,
    "",
    pngProblem === null
      ? "The attached PNG is the frame as rendered. Match it with the project's existing components and tokens; do not hard-code values that a token below already names."
      : `No PNG is attached: the frame could not be rendered${pngProblem === "" ? "" : ` (${pngProblem})`}. Build it from the frame JSON below with the project's existing components and tokens; do not hard-code values that a token below already names.`,
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

/** Where "Implement this frame" sends the frame. */
export type ImplementTarget = { kind: "new" } | { kind: "existing"; binding: DesignThreadBinding };

const NO_CODING_PROJECT = "This design has no project to start a coding thread in.";

/** What "Implement this frame" needs from the editor's session and backend. */
export interface FrameHandoffDeps {
  /** Saves every pending edit; false while a conflict or a failed save holds one back. */
  readonly settle: () => Promise<boolean>;
  /** The last saved document, and whether anything is still unsaved. */
  readonly saved: () => { readonly document: DesignDocument; readonly saveState: string };
  /** The frame's PNG; throws when it cannot be rendered. */
  readonly render: (frame: DesignNode) => Promise<DesignImage[]>;
  readonly startCodingThread: DesignEditorBackend["startCodingThread"];
  readonly sendToThread: DesignEditorBackend["sendToThread"];
}

export interface FrameHandoffResult {
  readonly thread: DesignThreadBinding;
  readonly frameName: string;
  /** The new thread was created with no turn, the handoff waiting in its composer. */
  readonly waiting: boolean;
  /** Why no PNG went with the frame (no closing period; may be empty), or null when one did. */
  readonly pngProblem: string | null;
}

/**
 * "Implement this frame": saves every edit first and refuses while one is
 * unsaved, so the handoff names a revision the coding thread can read. The
 * frame goes from that saved revision, with its PNG, or with a line saying
 * why it has none.
 */
export async function sendFrameHandoff(
  deps: FrameHandoffDeps,
  input: {
    readonly pageId: string;
    readonly frameId: string;
    readonly system: DesignSystem | null;
    readonly mode: string;
    readonly designKey: string;
    readonly target: ImplementTarget;
  },
): Promise<FrameHandoffResult> {
  const { target } = input;
  const startCodingThread = deps.startCodingThread;
  if (target.kind === "new" && startCodingThread === null) throw new Error(NO_CODING_PROJECT);
  if (!(await deps.settle()) || deps.saved().saveState !== "saved")
    throw new Error(
      "Your changes are not saved yet, so the frame was not sent. Try again once they are saved.",
    );
  const document = deps.saved().document;
  const page = document.pages.find((candidate) => candidate.id === input.pageId);
  const frame = page?.nodes.find((node) => node.id === input.frameId);
  if (page === undefined || frame === undefined)
    throw new Error("This frame is not in the saved design any more.");
  let images: DesignImage[] = [];
  let pngProblem: string | null = null;
  try {
    images = await deps.render(frame);
  } catch (cause) {
    pngProblem = (cause instanceof Error ? cause.message : String(cause))
      .trim()
      .replace(/[.!]+$/, "");
  }
  const { title, text } = implementFrameMessage({
    document,
    page,
    frame,
    system: input.system,
    mode: input.mode,
    designKey: input.designKey,
    pngProblem,
  });
  const message: DesignMessage = { text, images };
  const frameName = frame.name ?? "the frame";
  if (target.kind === "existing") {
    await deps.sendToThread(target.binding, message);
    return { thread: target.binding, frameName, waiting: false, pngProblem };
  }
  if (startCodingThread === null) throw new Error(NO_CODING_PROJECT);
  const { waiting, ...thread } = await startCodingThread(message, title);
  return { thread, frameName, waiting: waiting === true, pngProblem };
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
