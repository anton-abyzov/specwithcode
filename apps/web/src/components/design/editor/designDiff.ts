import {
  DESIGN_DEFAULT_ACCESS,
  type DesignComment,
  type DesignDocument,
  type DesignNode,
  type DesignOperation,
  type DesignPage,
} from "@specweave-studio/contracts";

/**
 * Operations that turn `from` into `to`, touching only what differs. Undo
 * records `designDiff(after, before)` for each change (local or agent), so
 * undoing one change never clobbers unrelated edits that landed since.
 */
export function designDiff(from: DesignDocument, to: DesignDocument): DesignOperation[] {
  const ops: DesignOperation[] = [];
  if (from.title !== to.title) ops.push({ op: "set_title", title: to.title });
  if (from.designSystem !== to.designSystem)
    ops.push({ op: "set_design_system", systemId: to.designSystem });
  if (!sameValue(from.thread, to.thread)) ops.push({ op: "set_thread", thread: to.thread ?? null });
  if (!sameValue(from.reuse, to.reuse)) ops.push({ op: "set_reuse", reuse: to.reuse ?? null });
  if (!sameValue(from.access, to.access)) {
    const access = to.access ?? DESIGN_DEFAULT_ACCESS;
    ops.push({ op: "set_access", members: access.members, agents: access.agents });
  }

  const toPageIds = new Set(to.pages.map((page) => page.id));
  const fromPages = new Map(from.pages.map((page) => [page.id, page]));
  const commentsBefore = new Map(from.comments.map((comment) => [comment.id, comment]));
  const commentsAfter = new Map(to.comments.map((comment) => [comment.id, comment]));

  // Comments on a page that goes away vanish with it; delete the others first.
  for (const comment of from.comments) {
    const next = commentsAfter.get(comment.id);
    if (next === undefined || !sameComment(comment, next, true)) {
      if (toPageIds.has(comment.pageId) || next !== undefined)
        ops.push({ op: "delete_comment", commentId: comment.id });
    }
  }

  for (const [index, page] of to.pages.entries()) {
    const before = fromPages.get(page.id);
    if (before === undefined) ops.push({ op: "add_page", page, index });
    else ops.push(...pageDiff(before, page));
  }
  for (const page of from.pages)
    if (!toPageIds.has(page.id)) ops.push({ op: "delete_page", pageId: page.id });

  const order = from.pages.map((page) => page.id).filter((id) => toPageIds.has(id));
  for (const page of to.pages) if (!order.includes(page.id)) order.push(page.id);
  for (const [index, page] of to.pages.entries()) {
    if (order[index] === page.id) continue;
    ops.push({ op: "move_page", pageId: page.id, index });
    order.splice(order.indexOf(page.id), 1);
    order.splice(index, 0, page.id);
  }

  for (const comment of to.comments) {
    const before = commentsBefore.get(comment.id);
    if (before === undefined || !sameComment(before, comment, true))
      ops.push({ op: "add_comment", comment });
    else if (before.resolved !== comment.resolved)
      ops.push({ op: "resolve_comment", commentId: comment.id, resolved: comment.resolved });
  }
  return ops;
}

function sameComment(a: DesignComment, b: DesignComment, ignoreResolved: boolean) {
  return (
    a.pageId === b.pageId &&
    a.nodeId === b.nodeId &&
    a.x === b.x &&
    a.y === b.y &&
    a.text === b.text &&
    (ignoreResolved || a.resolved === b.resolved)
  );
}

function pageDiff(from: DesignPage, to: DesignPage): DesignOperation[] {
  const ops: DesignOperation[] = [];
  if (from.name !== to.name || from.skipped !== to.skipped || from.notes !== to.notes) {
    ops.push({
      op: "update_page",
      pageId: to.id,
      ...(from.name === to.name ? {} : { name: to.name }),
      ...(from.skipped === to.skipped ? {} : { skipped: to.skipped ?? false }),
      ...(from.notes === to.notes ? {} : { notes: to.notes ?? "" }),
    });
  }
  if (from.nodes === to.nodes) return ops;
  const fromById = new Map(from.nodes.map((node) => [node.id, node]));
  const toById = new Map(to.nodes.map((node) => [node.id, node]));

  // Deletes: skip nodes whose ancestor is deleted too (the reducer removes the subtree).
  for (const node of from.nodes) {
    if (toById.has(node.id)) continue;
    let parent = node.parentId;
    let covered = false;
    while (parent !== null) {
      if (!toById.has(parent)) covered = true;
      parent = fromById.get(parent)?.parentId ?? null;
    }
    if (!covered) ops.push({ op: "delete_node", pageId: to.id, id: node.id });
  }

  // Adds in paint order, so a frame exists before its children.
  for (const node of to.nodes) {
    const before = fromById.get(node.id);
    if (before === undefined) {
      ops.push({ op: "add_node", pageId: to.id, node });
      continue;
    }
    if (before === node) continue;
    if (before.parentId !== node.parentId)
      ops.push({ op: "move_node", pageId: to.id, id: node.id, parentId: node.parentId });
    const patch = nodePatch(before, node);
    if (patch !== null) ops.push({ op: "update_node", pageId: to.id, id: node.id, patch });
  }

  // Paint order.
  const order = from.nodes.map((node) => node.id).filter((id) => toById.has(id));
  for (const node of to.nodes) if (!fromById.has(node.id)) order.push(node.id);
  for (const [index, node] of to.nodes.entries()) {
    if (order[index] === node.id) continue;
    ops.push({ op: "move_node", pageId: to.id, id: node.id, index });
    order.splice(order.indexOf(node.id), 1);
    order.splice(index, 0, node.id);
  }
  return ops;
}

/** Changed fields of a node (null removes one), or null when only identity changed. */
export function nodePatch(from: DesignNode, to: DesignNode): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const a = from as unknown as Record<string, unknown>;
  const b = to as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "id" || key === "type" || key === "parentId") continue;
    if (!(key in b)) patch[key] = null;
    else if (!sameValue(a[key], b[key])) patch[key] = b[key];
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
