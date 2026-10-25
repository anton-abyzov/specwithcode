import { isProviderSendTurnSupportedImageMimeType } from "@specweave-studio/contracts";
import * as Predicate from "effect/Predicate";

import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./htmlRender.ts";
import { resolveStudioMcpToolId } from "./studioMcpToolPresentation.ts";

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

interface ResultReadBudget {
  remainingBytes: number;
  remainingNodes: number;
  exceeded: boolean;
}

interface ResultEnvelope {
  data?: Record<PropertyKey, unknown>;
  failed: boolean;
}

interface CompactToolOutput {
  isError?: true;
  threadId?: string;
  messageId?: string;
  taskId?: string;
  scheduledTaskId?: string;
  status?: "rolled_back";
  htmlRender?: HtmlRenderReference;
  thread?: { threadId: string };
  threads?: Array<{ threadId?: string; status?: "rolled_back" }>;
}

function readResult(value: unknown, budget: ResultReadBudget, depth = 0): ResultEnvelope {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data: ResultEnvelope["data"];
    let failed = false;
    for (const block of value) {
      const text = Predicate.isObject(block) ? block.text : undefined;
      const result = readResult(
        Predicate.isObject(text) ? (text.text ?? text) : text,
        budget,
        depth + 1,
      );
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!Predicate.isObject(value)) return { failed: false };
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const content = value.structuredContent ?? value.content;
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

/** Keeps only IDs and failure metadata used by Studio's grouped tool summaries. */
export function compactDynamicToolOutput(value: unknown): CompactToolOutput | undefined {
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output: CompactToolOutput = result.failed ? { isError: true } : {};
  const data = budget.exceeded ? undefined : result.data;
  if (data !== undefined) {
    for (const key of ["threadId", "messageId", "taskId", "scheduledTaskId"] as const) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const nestedThreadId = Predicate.isObject(data.thread)
      ? boundedId(data.thread.threadId)
      : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads: NonNullable<CompactToolOutput["threads"]> = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!Predicate.isObject(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" as const } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // A partial batch or a top-level ID would turn an unknown creation
        // count into a confidently wrong one in the existing summary parser.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  if (encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

/** The page a completed `html_render` tool call published, if this item is one. */
export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  if (resolveStudioMcpToolId(item.toolName) !== HTML_RENDER_TOOL_NAME) return undefined;
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    /file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
    (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
    (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

/** One detail page: at most this many UTF-8 bytes. */
export const DETAIL_PAGE_MAX_BYTES = 256 * 1024;

/** What older clients see after a field a detail read cut to its first page. */
export const TRANSPORT_TRUNCATION_MARKER = "\n… output truncated for transport";

export interface TextPage {
  readonly text: string;
  /** UTF-16 offset of the first character. */
  readonly offset: number;
  /** UTF-16 offset just past the last character. */
  readonly end: number;
  readonly totalLength: number;
  /** Where the next page starts, or null on the last page. */
  readonly nextOffset: number | null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves a boundary that would split a surrogate pair to just before the pair. */
function codePointBoundary(text: string, index: number): number {
  const bounded = Math.max(0, Math.min(text.length, Math.trunc(index)));
  return bounded > 0 &&
    bounded < text.length &&
    isHighSurrogate(text.charCodeAt(bounded - 1)) &&
    isLowSurrogate(text.charCodeAt(bounded))
    ? bounded - 1
    : bounded;
}

/** UTF-8 bytes of the code point at `index` and how many UTF-16 units it spans. */
function codePointAt(text: string, index: number): { bytes: number; units: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, units: 1 };
  if (code < 0x800) return { bytes: 2, units: 1 };
  if (
    isHighSurrogate(code) &&
    index + 1 < text.length &&
    isLowSurrogate(text.charCodeAt(index + 1))
  ) {
    return { bytes: 4, units: 2 };
  }
  // A lone surrogate encodes as U+FFFD, three bytes.
  return { bytes: 3, units: 1 };
}

/** The code point that ends just before `index`, read backward. */
function codePointBefore(text: string, index: number): { bytes: number; units: number } {
  const code = text.charCodeAt(index - 1);
  if (isLowSurrogate(code) && index >= 2 && isHighSurrogate(text.charCodeAt(index - 2))) {
    return { bytes: 4, units: 2 };
  }
  return codePointAt(text, index - 1);
}

/**
 * One page of `text` within a UTF-8 byte budget, on code point boundaries so a
 * page never splits a surrogate pair. Offsets are UTF-16 indices. `offset`
 * pages forward from there; `before` pages backward to there and wins over
 * `offset`; with neither, `anchor: "end"` reads the last page and the default
 * reads the first. A page always holds at least one code point, so paging
 * always advances. Joining every page from offset 0 gives back `text` exactly.
 */
export function sliceTextPage(
  text: string,
  options: {
    readonly offset?: number | undefined;
    readonly before?: number | undefined;
    readonly anchor?: "start" | "end" | undefined;
    readonly maxBytes?: number | undefined;
  } = {},
): TextPage {
  const budget = Math.max(
    4,
    Math.min(DETAIL_PAGE_MAX_BYTES, Math.trunc(options.maxBytes ?? DETAIL_PAGE_MAX_BYTES)),
  );
  const totalLength = text.length;
  const page = (offset: number, end: number): TextPage => ({
    text: offset === 0 && end === totalLength ? text : text.slice(offset, end),
    offset,
    end,
    totalLength,
    nextOffset: end < totalLength ? end : null,
  });
  const backward =
    options.before !== undefined || (options.offset === undefined && options.anchor === "end");
  if (backward) {
    const end = codePointBoundary(text, options.before ?? totalLength);
    let offset = end;
    let bytes = 0;
    while (offset > 0) {
      const point = codePointBefore(text, offset);
      if (bytes + point.bytes > budget && offset < end) break;
      bytes += point.bytes;
      offset -= point.units;
    }
    return page(offset, end);
  }
  const offset = codePointBoundary(text, options.offset ?? 0);
  let end = offset;
  let bytes = 0;
  while (end < totalLength) {
    const point = codePointAt(text, end);
    if (bytes + point.bytes > budget && end > offset) break;
    bytes += point.bytes;
    end += point.units;
  }
  return page(offset, end);
}

/** An image a tool returned inline. `data` is base64; a detail read omits it. */
export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/**
 * Reads one image block in the MCP `{ data, mimeType }` shape or the Anthropic
 * `{ source: { type: "base64", media_type, data } }` shape Claude stores.
 * Only raster types are recognized, so the server never serves an agent's SVG
 * or HTML inline.
 */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

/** Tools return a block, a list of blocks, or an MCP result with a `content` list. */
function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

/** A tool returns one screenshot or a few frames; more would only flood the timeline. */
export const MAX_TOOL_OUTPUT_IMAGES = 8;

/**
 * The first images in a tool output, in order. The order is the
 * `tool-output-image` asset index, so servers and clients agree on it.
 */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  const images: ToolOutputImage[] = [];
  for (const block of outputBlocks(value)) {
    const image = readToolOutputImage(block);
    if (image === null) continue;
    images.push(image);
    if (images.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return images;
}

/**
 * Replaces each image's bytes with `{ type: "image", mimeType }` and keeps its
 * position, so detail reads stay small and clients load the bytes as assets.
 */
export function omitToolOutputImageData(value: unknown): unknown {
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
