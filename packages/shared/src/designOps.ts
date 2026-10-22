import {
  DESIGN_DEFAULT_ACCESS,
  DESIGN_DOCUMENT_SCHEMA,
  DESIGN_MAX_NODES_PER_PAGE,
  DESIGN_MAX_PAGES,
  DesignNode,
  type DesignActor,
  type DesignDocument,
  type DesignKind,
  type DesignOperation,
  type DesignPage,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/**
 * The one reducer for design documents. Clients apply operations
 * optimistically and the server applies the same operations under its
 * revision check, so both sides always agree on the result.
 *
 * Pure: never mutates its input and does not touch `revision` or
 * `updatedAt`; the store owns those.
 */

export type DesignOperationErrorCode = "not_found" | "invalid" | "too_large";

export interface DesignOperationError {
  readonly code: DesignOperationErrorCode;
  readonly detail: string;
  /** Position of the failing operation in the batch. */
  readonly index: number;
}

export type DesignApplyOutcome =
  | { readonly ok: true; readonly document: DesignDocument }
  | { readonly ok: false; readonly error: DesignOperationError };

const decodeNode = Schema.decodeUnknownExit(DesignNode);

/** Frame sizes offered when creating a document. */
export const DESIGN_DEFAULT_FRAME = { width: 1440, height: 1024 } as const;
export const SLIDE_FRAME = { width: 1920, height: 1080 } as const;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A short random id with a readable prefix (`d_`, `n_`, `p_`, `c_`, `s_`). */
export function designId(prefix: "d" | "n" | "p" | "c" | "s", random: () => number = Math.random) {
  let out = `${prefix}_`;
  for (let index = 0; index < 12; index += 1) {
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? "0";
  }
  return out;
}

export function newDesignDocument(input: {
  readonly id: string;
  readonly kind: DesignKind;
  readonly title: string;
  readonly now: string;
  readonly createdBy: DesignActor;
  readonly designSystem?: string | null;
  readonly random?: () => number;
}): DesignDocument {
  const random = input.random ?? Math.random;
  const frame = input.kind === "slides" ? SLIDE_FRAME : DESIGN_DEFAULT_FRAME;
  const page: DesignPage = {
    id: designId("p", random),
    name: input.kind === "slides" ? "Slide 1" : "Page 1",
    nodes: [
      {
        id: designId("n", random),
        parentId: null,
        type: "frame",
        name: input.kind === "slides" ? "Slide 1" : "Frame 1",
        x: 0,
        y: 0,
        width: frame.width,
        height: frame.height,
        fill: "#ffffff",
        clip: true,
      },
    ],
  };
  return {
    schema: DESIGN_DOCUMENT_SCHEMA,
    id: input.id,
    kind: input.kind,
    title: input.title,
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    designSystem: input.designSystem ?? null,
    pages: [page],
    comments: [],
    createdBy: input.createdBy,
    copiedFrom: null,
  };
}

/** Ids of `rootId` and every node inside it, in paint order. */
export function designSubtreeIds(page: DesignPage, rootId: string): ReadonlySet<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of page.nodes) {
      if (node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

class OperationFailure {
  readonly code: DesignOperationErrorCode;
  readonly detail: string;
  constructor(code: DesignOperationErrorCode, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code: DesignOperationErrorCode, detail: string): never => {
  throw new OperationFailure(code, detail);
};

function pageIndex(document: DesignDocument, pageId: string): number {
  const index = document.pages.findIndex((page) => page.id === pageId);
  if (index < 0) fail("not_found", `No page ${pageId}.`);
  return index;
}

function nodeIndex(page: DesignPage, id: string): number {
  const index = page.nodes.findIndex((node) => node.id === id);
  if (index < 0) fail("not_found", `No node ${id} on page ${page.name}.`);
  return index;
}

function validNode(value: unknown): DesignNode {
  const exit = decodeNode(value);
  if (exit._tag === "Failure") {
    const id =
      typeof value === "object" && value !== null && "id" in value ? String(value.id) : "node";
    return fail("invalid", `Invalid ${id}: ${String(exit.cause).slice(0, 400)}`);
  }
  return exit.value;
}

function requireFrameParent(page: DesignPage, parentId: string | null, selfId?: string) {
  if (parentId === null) return;
  const parent = page.nodes.find((node) => node.id === parentId);
  if (parent === undefined) fail("not_found", `No parent ${parentId}.`);
  if (parent?.type !== "frame") fail("invalid", `Parent ${parentId} is not a frame.`);
  if (selfId !== undefined && designSubtreeIds(page, selfId).has(parentId))
    fail("invalid", `A frame cannot move into itself.`);
}

function insertAt<T>(items: readonly T[], item: T, index: number | undefined): T[] {
  const next = [...items];
  const at = index === undefined ? next.length : Math.min(index, next.length);
  next.splice(at, 0, item);
  return next;
}

function replacePage(document: DesignDocument, index: number, page: DesignPage): DesignDocument {
  const pages = [...document.pages];
  pages[index] = page;
  return { ...document, pages };
}

function allNodeIds(document: DesignDocument): Set<string> {
  const ids = new Set<string>();
  for (const page of document.pages) for (const node of page.nodes) ids.add(node.id);
  return ids;
}

function applyOne(document: DesignDocument, operation: DesignOperation): DesignDocument {
  switch (operation.op) {
    case "add_node": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      if (page.nodes.length >= DESIGN_MAX_NODES_PER_PAGE)
        fail("too_large", `Page ${page.name} already has ${DESIGN_MAX_NODES_PER_PAGE} nodes.`);
      if (allNodeIds(document).has(operation.node.id))
        fail("invalid", `Node id ${operation.node.id} is already used.`);
      const node = validNode(operation.node);
      requireFrameParent(page, node.parentId);
      return replacePage(document, index, {
        ...page,
        nodes: insertAt(page.nodes, node, operation.index),
      });
    }
    case "update_node": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      const at = nodeIndex(page, operation.id);
      const current = page.nodes[at]!;
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(operation.patch)) {
        if (key === "id" || key === "type" || key === "parentId")
          fail("invalid", `${key} cannot be patched; use move_node for parentId.`);
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const nodes = [...page.nodes];
      nodes[at] = validNode(next);
      return replacePage(document, index, { ...page, nodes });
    }
    case "delete_node": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      nodeIndex(page, operation.id);
      const removed = designSubtreeIds(page, operation.id);
      return {
        ...replacePage(document, index, {
          ...page,
          nodes: page.nodes.filter((node) => !removed.has(node.id)),
        }),
        comments: document.comments.map((comment) =>
          comment.nodeId !== null && removed.has(comment.nodeId)
            ? { ...comment, nodeId: null }
            : comment,
        ),
      };
    }
    case "move_node": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      const at = nodeIndex(page, operation.id);
      const node = page.nodes[at]!;
      const parentId = operation.parentId === undefined ? node.parentId : operation.parentId;
      requireFrameParent(page, parentId, node.id);
      const moved = { ...node, parentId } as DesignNode;
      const rest = page.nodes.filter((candidate) => candidate.id !== node.id);
      const target = operation.index === undefined ? Math.min(at, rest.length) : operation.index;
      return replacePage(document, index, { ...page, nodes: insertAt(rest, moved, target) });
    }
    case "add_page": {
      if (document.pages.length >= DESIGN_MAX_PAGES)
        fail("too_large", `A design has at most ${DESIGN_MAX_PAGES} pages.`);
      if (document.pages.some((page) => page.id === operation.page.id))
        fail("invalid", `Page id ${operation.page.id} is already used.`);
      const used = allNodeIds(document);
      const seen = new Set<string>();
      const nodes = operation.page.nodes.map((node) => {
        if (used.has(node.id) || seen.has(node.id))
          fail("invalid", `Node id ${node.id} is already used.`);
        seen.add(node.id);
        return validNode(node);
      });
      const page = { ...operation.page, nodes };
      for (const node of nodes) requireFrameParent(page, node.parentId);
      return { ...document, pages: insertAt(document.pages, page, operation.index) };
    }
    case "update_page": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      return replacePage(document, index, {
        ...page,
        ...(operation.name === undefined ? {} : { name: operation.name }),
        ...(operation.skipped === undefined ? {} : { skipped: operation.skipped }),
        ...(operation.notes === undefined ? {} : { notes: operation.notes }),
      });
    }
    case "delete_page": {
      pageIndex(document, operation.pageId);
      if (document.pages.length === 1) fail("invalid", "A design keeps at least one page.");
      return {
        ...document,
        pages: document.pages.filter((page) => page.id !== operation.pageId),
        comments: document.comments.filter((comment) => comment.pageId !== operation.pageId),
      };
    }
    case "move_page": {
      const index = pageIndex(document, operation.pageId);
      const page = document.pages[index]!;
      const rest = document.pages.filter((candidate) => candidate.id !== operation.pageId);
      return { ...document, pages: insertAt(rest, page, operation.index) };
    }
    case "set_title":
      return { ...document, title: operation.title };
    case "set_design_system":
      return { ...document, designSystem: operation.systemId };
    case "add_comment": {
      const { comment } = operation;
      if (document.comments.some((existing) => existing.id === comment.id))
        fail("invalid", `Comment id ${comment.id} is already used.`);
      const page = document.pages[pageIndex(document, comment.pageId)]!;
      if (comment.nodeId !== null) nodeIndex(page, comment.nodeId);
      return { ...document, comments: [...document.comments, comment] };
    }
    case "resolve_comment": {
      if (!document.comments.some((comment) => comment.id === operation.commentId))
        fail("not_found", `No comment ${operation.commentId}.`);
      return {
        ...document,
        comments: document.comments.map((comment) =>
          comment.id === operation.commentId
            ? { ...comment, resolved: operation.resolved }
            : comment,
        ),
      };
    }
    case "delete_comment": {
      if (!document.comments.some((comment) => comment.id === operation.commentId))
        fail("not_found", `No comment ${operation.commentId}.`);
      return {
        ...document,
        comments: document.comments.filter((comment) => comment.id !== operation.commentId),
      };
    }
    case "set_thread": {
      if (operation.thread === null) {
        const { thread: _removed, ...rest } = document;
        return rest;
      }
      return { ...document, thread: operation.thread };
    }
    case "set_access": {
      const current = document.access ?? DESIGN_DEFAULT_ACCESS;
      return {
        ...document,
        access: {
          members: operation.members ?? current.members,
          agents: operation.agents ?? current.agents,
        },
      };
    }
  }
}

/** The thread a design is bound to, if any. */
export function designBoundThread(document: DesignDocument) {
  return document.thread ?? null;
}

/** Effective access, with defaults filled in. */
export function designAccess(document: Pick<DesignDocument, "access">) {
  return document.access ?? DESIGN_DEFAULT_ACCESS;
}

/** Operations a `comment` level may still apply: comments only. */
export function isCommentOperation(operation: DesignOperation): boolean {
  return (
    operation.op === "add_comment" ||
    operation.op === "resolve_comment" ||
    operation.op === "delete_comment"
  );
}

/** Whether an audience with `level` may apply every operation in the batch. */
export function designAccessAllows(
  level: "edit" | "comment" | "view",
  operations: readonly DesignOperation[],
): boolean {
  if (level === "edit") return true;
  if (level === "view") return false;
  return operations.every(isCommentOperation);
}

/** Applies a batch atomically: every operation lands, or none does. */
export function applyDesignOperations(
  document: DesignDocument,
  operations: readonly DesignOperation[],
): DesignApplyOutcome {
  let current = document;
  for (const [index, operation] of operations.entries()) {
    try {
      current = applyOne(current, operation);
    } catch (cause) {
      if (cause instanceof OperationFailure)
        return { ok: false, error: { code: cause.code, detail: cause.detail, index } };
      throw cause;
    }
  }
  return { ok: true, document: current };
}

/**
 * The node ids and fields an operation writes. Two concurrent batches only
 * conflict when they write the same key; everything else rebases cleanly.
 */
export function designOperationWrites(operation: DesignOperation): readonly string[] {
  switch (operation.op) {
    case "add_node":
      return [`node:${operation.node.id}`];
    case "update_node":
      return Object.keys(operation.patch).map((key) => `node:${operation.id}:${key}`);
    case "delete_node":
      return [`node:${operation.id}`];
    case "move_node":
      // Node-scoped: reorders of different nodes commute, and deleting the node overlaps its move.
      return [`node:${operation.id}:parentId`, `node:${operation.id}:order`];
    case "add_page":
    case "move_page":
      return ["pages"];
    case "update_page":
      return [
        ...(operation.name === undefined ? [] : [`page:${operation.pageId}:name`]),
        ...(operation.skipped === undefined ? [] : [`page:${operation.pageId}:skipped`]),
        ...(operation.notes === undefined ? [] : [`page:${operation.pageId}:notes`]),
      ];
    case "delete_page":
      return ["pages", `page:${operation.pageId}`];
    case "set_title":
      return ["title"];
    case "set_design_system":
      return ["designSystem"];
    case "add_comment":
      return [`comment:${operation.comment.id}`];
    case "resolve_comment":
    case "delete_comment":
      return [`comment:${operation.commentId}`];
    case "set_thread":
      return ["thread"];
    case "set_access":
      return [
        ...(operation.members === undefined ? [] : ["access:members"]),
        ...(operation.agents === undefined ? [] : ["access:agents"]),
      ];
  }
}

/** True when `write` (from one batch) touches the same thing as any key in `others`. */
export function designWritesOverlap(
  writes: readonly string[],
  others: ReadonlySet<string>,
): boolean {
  for (const write of writes) {
    if (others.has(write)) return true;
    // A whole-node write (add or delete) overlaps every field write on that node.
    const [kind, id] = write.split(":");
    if (kind === "node" && write.split(":").length === 2) {
      for (const other of others) if (other.startsWith(`node:${id}:`)) return true;
    } else if (kind === "node" && others.has(`node:${id}`)) return true;
  }
  return false;
}
