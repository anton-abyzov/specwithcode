/**
 * Caps the bodies of tool items when they are saved.
 *
 * A tool item's output is stored whole in its `turn-item.updated` event and
 * again in its projection row, and a few very large outputs hold most of the
 * bytes: on one machine the items over 100 KB were 1.7% of items and 57% of
 * item bytes. EventSink applies this cap to every turn-item snapshot before it
 * appends the events, so the event, the projection row and the live update
 * all carry the same capped item, whichever provider adapter produced it.
 *
 * What is cut, keeping a head and a tail with a note between them:
 * - `command_execution.output`;
 * - every long string inside `dynamic_tool.output` and `dynamic_tool.input`.
 *
 * What is never cut: file changes (their patches are the user's edits, read
 * back page by page for review, and 3.6% of item bytes on the measured
 * machine), images a tool returned (the timeline shows them and
 * serves them as assets by index), HTML render and preview tools (their
 * output names attachments the UI opens), and every other item type
 * (messages, plans, subagents, handoffs).
 *
 * The item records `bodyCut` with the fields, the original and kept sizes and
 * the original's SHA-256, so the UI can say what was cut and a re-read can be
 * checked against it. A capped item caps again to itself: running and
 * completed snapshots stay consistent.
 *
 * @module TurnItemBodyCap
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest of the cut text.
import * as NodeCrypto from "node:crypto";

import type {
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemBodyCut,
} from "@specweave-studio/contracts";
import { HTML_RENDER_TOOL_NAME, HTML_VISUAL_TOOL_NAME } from "@specweave-studio/shared/htmlRender";
import { readToolOutputImage } from "@specweave-studio/shared/toolOutput";

export interface TurnItemBodyCapPolicy {
  /** Characters kept of a command's or an ordinary tool's body. */
  readonly defaultChars: number;
  /** Characters kept of a read whose source still exists (a file, another thread). */
  readonly readChars: number;
}

export const DEFAULT_TURN_ITEM_BODY_CAP: TurnItemBodyCapPolicy = {
  defaultChars: 64 * 1024,
  readChars: 16 * 1024,
};

/** Share of a cut field kept from its start; the rest comes from its end. */
const HEAD_SHARE = 0.75;
/** No string shorter than this is cut, however many long ones an output holds. */
const MIN_LEAF_CHARS = 1024;

/** Tools whose output is a copy of something that still exists elsewhere. */
const READ_TOOL =
  /(?:^|[._])(?:Read|read_file|studio_thread_read|studio_thread_list|orchestrator_capabilities|list_scheduled_tasks)$/u;
const EXEMPT_TOOL = new RegExp(
  `(?:^|[._])(?:${HTML_RENDER_TOOL_NAME}|${HTML_VISUAL_TOOL_NAME}|html_preview)$`,
  "u",
);

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const kib = (count: number) =>
  count >= 1024 * 1024
    ? `${(count / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(count / 1024))} KB`;

/** A cut index that does not split a surrogate pair. */
const boundary = (text: string, index: number) => {
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
};

/** The note between the kept head and tail; it says what went. */
export const cutNote = (originalChars: number, keptChars: number) =>
  `\n\n[… SpecWithCode saved ${kib(keptChars)} of ${kib(originalChars)} here: the start and the end, ${kib(originalChars - keptChars)} cut …]\n\n`;

/**
 * Head and tail of `text` with the note between them, `limit` characters at
 * most in all, or `text` when it fits. The result fits `limit`, so cutting it
 * again returns it unchanged, whatever text it quotes.
 */
export const cutText = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  const note = cutNote(text.length, limit);
  const kept = Math.max(0, limit - note.length);
  const head = boundary(text, Math.floor(kept * HEAD_SHARE));
  const tailStart = boundary(text, text.length - (kept - head));
  return `${text.slice(0, head)}${note}${text.slice(tailStart)}`;
};

type Leaf = { readonly length: number };

/** Set when a walked value holds an image block, which is never cut or flattened. */
type Walk = { hasImage: boolean };

/** The string leaves a value holds outside image blocks. */
const collectLeaves = (
  value: unknown,
  leaves: Array<Leaf>,
  walk: Walk = { hasImage: false },
  depth = 0,
): void => {
  if (depth > 64) return;
  if (typeof value === "string") {
    leaves.push({ length: value.length });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLeaves(entry, leaves, walk, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (readToolOutputImage(value) !== null) {
      walk.hasImage = true;
      return;
    }
    for (const entry of Object.values(value)) collectLeaves(entry, leaves, walk, depth + 1);
  }
};

/**
 * The longest a leaf may stay so that all leaves together fit `budget`
 * (water filling), never below MIN_LEAF_CHARS; null when they already fit.
 */
const leafLimit = (leaves: ReadonlyArray<Leaf>, budget: number): number | null => {
  const total = leaves.reduce((sum, leaf) => sum + leaf.length, 0);
  if (total <= budget) return null;
  const lengths = leaves.map((leaf) => leaf.length).toSorted((left, right) => left - right);
  let remaining = budget;
  for (let index = 0; index < lengths.length; index += 1) {
    const share = remaining / (lengths.length - index);
    const length = lengths[index] ?? 0;
    if (length > share) return Math.max(MIN_LEAF_CHARS, Math.floor(share));
    remaining -= length;
  }
  return null;
};

/** `value` with every string leaf over `limit` cut; images stay as they are. */
const cutLeaves = (value: unknown, limit: number, depth = 0): unknown => {
  if (depth > 64) return value;
  if (typeof value === "string") return value.length > limit ? cutText(value, limit) : value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const cut = cutLeaves(entry, limit, depth + 1);
      if (cut !== entry) changed = true;
      return cut;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    if (readToolOutputImage(value) !== null) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cut = cutLeaves(entry, limit, depth + 1);
      if (cut !== entry) changed = true;
      next[key] = cut;
    }
    return changed ? next : value;
  }
  return value;
};

/**
 * Past this many times its budget, a structured output whose leaves were cut
 * as far as MIN_LEAF_CHARS allows (many short strings) is saved as cut JSON text.
 */
const FLATTEN_OVER_BUDGET = 2;

/**
 * `value` capped to about `budget` characters of text, or `value` itself.
 * With `flatten`, a structure that stays far over budget after its leaves
 * were cut (thousands of short strings) is kept as the head and tail of its
 * JSON text; one holding an image keeps its shape.
 */
const capValue = (value: unknown, budget: number, flatten = false): unknown => {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return cutText(value, budget);
  const leaves: Array<Leaf> = [];
  const walk: Walk = { hasImage: false };
  collectLeaves(value, leaves, walk);
  const limit = leafLimit(leaves, budget);
  if (limit === null) return value;
  const cut = cutLeaves(value, limit);
  if (!flatten || walk.hasImage) return cut;
  const keptLeaves: Array<Leaf> = [];
  collectLeaves(cut, keptLeaves);
  const kept = keptLeaves.reduce((sum, leaf) => sum + leaf.length, 0);
  return kept > budget * FLATTEN_OVER_BUDGET ? cutText(JSON.stringify(value), budget) : cut;
};

const textOf = (value: unknown) =>
  typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);

/**
 * Records a cut: the fields that changed, their sizes before and after, and
 * the original's digest. An item cut before keeps its first record, which
 * describes the provider's original.
 */
const withBodyCut = <I extends { readonly bodyCut?: OrchestrationV2TurnItemBodyCut | undefined }>(
  item: I,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): I => {
  const fields = Object.keys(before).filter((field) => before[field] !== after[field]);
  if (fields.length === 0) return item;
  const next = { ...item, ...after } as I;
  if (item.bodyCut !== undefined) return next;
  const original = fields.map((field) => textOf(before[field])).join("\n");
  const kept = fields.map((field) => textOf(after[field])).join("\n");
  return {
    ...next,
    bodyCut: {
      fields,
      originalBytes: bytes(original),
      keptBytes: bytes(kept),
      sha256: NodeCrypto.createHash("sha256").update(original).digest("hex"),
      reason: "write-cap",
    },
  };
};

/**
 * The item with its tool body capped by `policy`; any other item, and any
 * body within its cap, comes back as the same object.
 */
export const capTurnItemBody = (
  item: OrchestrationV2TurnItem,
  policy: TurnItemBodyCapPolicy = DEFAULT_TURN_ITEM_BODY_CAP,
): OrchestrationV2TurnItem => {
  switch (item.type) {
    case "command_execution": {
      if (item.output === undefined) return item;
      return withBodyCut(
        item,
        { output: item.output },
        { output: capValue(item.output, policy.defaultChars) },
      );
    }
    case "dynamic_tool": {
      const toolName = item.toolName ?? "";
      if (EXEMPT_TOOL.test(toolName)) return item;
      const budget = READ_TOOL.test(toolName) ? policy.readChars : policy.defaultChars;
      return withBodyCut(
        item,
        { input: item.input, output: item.output },
        {
          input: capValue(item.input, policy.defaultChars),
          output: capValue(item.output, budget, true),
        },
      );
    }
    default:
      return item;
  }
};
