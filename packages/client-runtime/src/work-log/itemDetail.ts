import type {
  AssetResource,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemDetailField,
  OrchestrationV2TurnItemPage,
  OrchestrationV2TurnItemPageInfo,
} from "@specweave-studio/contracts";
import {
  readToolOutputImage,
  toolOutputImages,
  TRANSPORT_TRUNCATION_MARKER,
} from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";

const MAX_TEXT_BLOCK_DEPTH = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Wire projection replaces a large dynamic input with `{ summary, truncated: true }`. */
function isSummarizedValue(value: unknown): boolean {
  return isRecord(value) && value.truncated === true && typeof value.summary === "string";
}

function textFromBlocks(value: unknown, depth: number): string | null {
  if (depth > MAX_TEXT_BLOCK_DEPTH) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((block) => textFromBlocks(block, depth + 1));
    return parts.every((part) => part !== null)
      ? parts.filter((part) => part !== "").join("\n")
      : null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "text" && typeof value.text === "string") return value.text;
  // Images clients can show render on their own (see turnItemOutputImages).
  if (value.type === "image") return readToolOutputImage(value) ? "" : "[image]";
  if (value.type === "resource_link" && typeof value.uri === "string") return value.uri;
  if (value.type === "resource" && isRecord(value.resource)) {
    const resource = value.resource;
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.uri === "string") return resource.uri;
  }
  const keys = Object.keys(value).filter((key) => key !== "isError" && key !== "is_error");
  // MCP results and provider tool results wrap their text in `content`.
  // `structuredContent` usually repeats it as data, so it only shows when the
  // text is empty.
  if (keys.length === 1 && keys[0] === "content") return textFromBlocks(value.content, depth + 1);
  if (keys.length === 2 && keys.includes("content") && keys.includes("structuredContent")) {
    const text = textFromBlocks(value.content, depth + 1);
    return text?.trim() ? text : null;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** MCP tools often return JSON as minified text, one document per line. Indent each. */
function prettyJsonText(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  const whole = parseJson(trimmed);
  if (whole !== undefined) return JSON.stringify(whole, null, 2);
  const lines = trimmed.split("\n").filter((line) => line.trim());
  const documents = lines.map((line) => parseJson(line.trim()));
  if (documents.some((document) => document === undefined)) return text;
  return documents.map((document) => JSON.stringify(document, null, 2)).join("\n\n");
}

/** Formats a tool input or output for display: text blocks as text, the rest as JSON. */
function formatToolValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = textFromBlocks(value, 0);
  if (text !== null) return text.trim() ? prettyJsonText(text) : null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (json === undefined || json === "{}" || json === "[]") return null;
  return json;
}

/**
 * The call a tool row's body shows above its result: the full command, the
 * arguments as `key value` pairs, or formatted text when they are not flat.
 */
export function toolCallLines(input: {
  readonly command?: string | undefined;
  readonly args?: unknown;
}): {
  readonly command: string | null;
  readonly args: ReadonlyArray<readonly [string, string]> | null;
  readonly argsText: string | null;
} {
  if (input.command !== undefined) {
    // The row title truncates to its width, so the body always has the full command.
    const command = input.command.trim();
    return { command: command || null, args: null, argsText: null };
  }
  const args = input.args;
  if (isRecord(args) && !isSummarizedValue(args)) {
    const entries = Object.entries(args).flatMap(
      ([key, value]): Array<readonly [string, string]> => {
        if (value === undefined) return [];
        // An empty string or null can be the point of a call (a clear or reset), so show it.
        return [
          [
            key,
            typeof value === "string" && value !== ""
              ? value
              : (JSON.stringify(value) ?? String(value)),
          ],
        ];
      },
    );
    return { command: null, args: entries.length > 0 ? entries : null, argsText: null };
  }
  return { command: null, args: null, argsText: formatToolValue(args) };
}

function toolCallHasLines(lines: ReturnType<typeof toolCallLines>): boolean {
  return lines.command !== null || lines.args !== null || lines.argsText !== null;
}

const LIVE_TURN_ITEM_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

/** How often an open row of a running item refetches its detail, for providers that stream output. */
export const LIVE_DETAIL_REFRESH_MS = 2_000;

/**
 * Whether a provider's running tool output grows while it runs. Codex declares
 * the capability but handles no output deltas, so its output appears at the end.
 */
export function streamsToolOutputForDriver(
  driver: string | null | undefined,
  capability: boolean | undefined,
): boolean {
  return capability === true && driver !== "codex";
}

/**
 * Cache key for a fetched item. A finished item is keyed by its revision. A
 * running item of a provider that streams output is keyed by a 2-second time
 * bucket, so an open row re-rendered by a timer whose period divides
 * LIVE_DETAIL_REFRESH_MS (1 s works) refetches every 2 s, and never within one
 * bucket. Other running items keep one key: one fetch while running and one
 * when they finish, not one per update.
 */
export function turnItemDetailRevision(
  item: OrchestrationV2TurnItem,
  options?: { readonly streamsToolOutput?: boolean; readonly nowMs?: number },
): string {
  if (!LIVE_TURN_ITEM_STATUSES.has(item.status)) return DateTime.formatIso(item.updatedAt);
  if (options?.streamsToolOutput !== true) return "live";
  // @effect-diagnostics-next-line globalDate:off
  const nowMs = options.nowMs ?? Date.now();
  return `live:${Math.floor(nowMs / LIVE_DETAIL_REFRESH_MS)}`;
}

/** True when the timeline item withholds content that `getTurnItem` returns. */
export function turnItemNeedsDetailFetch(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "command_execution":
      return item.outputOmitted === true;
    case "dynamic_tool":
      return item.outputOmitted === true || isSummarizedValue(item.input);
    case "file_change":
      return item.diffOmitted === true;
    default:
      return false;
  }
}

/**
 * The text a detail read returned for a field, without the transport marker.
 * With the field's `truncated` entry the text is that page plus the marker, so
 * exactly the page is kept. `undefined` means an older server, which marks a
 * cut only in the text; `null` means the read reported no cut for this field,
 * so the text is returned as stored.
 */
export function stripTransportMarker(
  text: string,
  info?: OrchestrationV2TurnItemPageInfo | null,
): string {
  if (info === null || !text.endsWith(TRANSPORT_TRUNCATION_MARKER)) return text;
  const kept = text.slice(0, -TRANSPORT_TRUNCATION_MARKER.length);
  return info === undefined ? kept : kept.slice(0, info.end - info.offset);
}

/** How many times a full read starts over because the item changed under it. */
const FULL_TEXT_MAX_RESTARTS = 3;

/** Joins one revision's pages, or returns null when the revision changed part way. */
async function readPagesAtOneRevision(
  fetchPage: Parameters<typeof readFullTurnItemText>[0],
  target: { readonly field: OrchestrationV2TurnItemDetailField; readonly changeIndex?: number },
): Promise<{ readonly text: string; readonly revision: string } | null> {
  const first = (await fetchPage({ ...target, offset: 0 })).page;
  if (!first) throw new Error("The server returned no page for this field.");
  const pages: string[] = [];
  let page = first;
  for (;;) {
    if (page.revision !== first.revision || page.totalLength !== first.totalLength) return null;
    if (page.end - page.offset !== page.text.length) {
      throw new Error("The server returned a page whose text does not match its bounds.");
    }
    pages.push(page.text);
    if (page.nextOffset === null) break;
    if (page.nextOffset <= page.offset) {
      throw new Error("The server returned a page that does not advance.");
    }
    const offset = page.nextOffset;
    const next = (await fetchPage({ ...target, offset })).page;
    if (!next) throw new Error("The server returned no page for this field.");
    if (next.offset !== offset && next.revision === first.revision) {
      throw new Error("The server returned a page out of order.");
    }
    page = next;
  }
  const text = pages.join("");
  if (text.length !== first.totalLength) {
    throw new Error("The joined pages do not match the stored length.");
  }
  return { text, revision: first.revision };
}

/**
 * Reads a field's whole stored text page by page from offset 0, for Copy full.
 * Every page must come from one revision: when a page's revision differs from
 * the first page's, the read starts over (at most 3 times, then rejects). The
 * text is joined from pages only, so it never includes the transport marker.
 * Rejects when the server returns no page (an older server, or a field the
 * item does not have); the caller then falls back to the bounded text.
 */
export async function readFullTurnItemText(
  fetchPage: (input: {
    readonly offset: number;
    readonly field: OrchestrationV2TurnItemDetailField;
    readonly changeIndex?: number;
  }) => Promise<{ readonly page?: OrchestrationV2TurnItemPage | undefined }>,
  request: {
    readonly field: OrchestrationV2TurnItemDetailField;
    readonly changeIndex?: number | undefined;
  },
): Promise<{ readonly text: string; readonly revision: string }> {
  const target = {
    field: request.field,
    ...(request.changeIndex === undefined ? {} : { changeIndex: request.changeIndex }),
  };
  for (let attempt = 0; attempt <= FULL_TEXT_MAX_RESTARTS; attempt += 1) {
    const text = await readPagesAtOneRevision(fetchPage, target);
    if (text !== null) return text;
  }
  throw new Error("The item kept changing while it was read.");
}

/** Older Claude bash rows stored the raw `{ stdout, stderr, interrupted, ... }` result. */
function commandOutputText(output: string): string {
  if (!output.trimStart().startsWith('{"stdout"')) return output;
  const parsed = parseJson(output.trim());
  if (
    !isRecord(parsed) ||
    typeof parsed.stdout !== "string" ||
    typeof parsed.stderr !== "string" ||
    typeof parsed.interrupted !== "boolean"
  ) {
    return output;
  }
  return [parsed.stdout, parsed.stderr]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

/** The tool output carried by a fetched item, formatted for display. */
export function turnItemOutputText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.output?.trim() ? commandOutputText(item.output) || null : null;
    case "dynamic_tool":
      return item.outputOmitted === true ? null : formatToolValue(item.output);
    case "file_search":
      return item.results?.length
        ? item.results
            .map((result) =>
              [
                `${result.fileName}${result.line === undefined ? "" : `:${result.line}`}`,
                result.preview?.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n")
        : null;
    case "web_search":
      return item.results?.length
        ? item.results
            .map((result) =>
              [
                result.title?.trim() || result.url,
                result.title ? result.url : undefined,
                result.snippet?.trim(),
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")
        : null;
    default:
      return null;
  }
}

/**
 * Images in a fetched item's tool output, as assets. The detail read leaves
 * the bytes out, so each loads over HTTP by its index.
 */
export function turnItemOutputImages(
  item: OrchestrationV2TurnItem,
): ReadonlyArray<Extract<AssetResource, { readonly _tag: "tool-output-image" }>> {
  if (item.type !== "dynamic_tool" || item.outputOmitted === true) return [];
  return toolOutputImages(item.output).map((_, index) => ({
    _tag: "tool-output-image",
    threadId: item.threadId,
    itemId: item.id,
    index,
  }));
}

/**
 * Whether expanding the item shows anything. Rows without content must not
 * offer a disclosure, otherwise they open to an empty panel.
 */
export function turnItemHasDetail(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "reasoning":
      return item.text.trim().length > 0;
    case "command_execution":
      return (
        toolCallLines({ command: item.input }).command !== null ||
        item.outputOmitted === true ||
        Boolean(item.output?.trim()) ||
        (item.exitCode !== undefined && item.exitCode !== 0)
      );
    case "file_change":
    case "checkpoint":
    case "fork":
    case "handoff":
      return true;
    case "file_search":
      return (item.results?.length ?? 0) > 0 || Boolean(item.pattern?.trim());
    case "web_search":
      return (item.results?.length ?? 0) > 0 || (item.patterns?.length ?? 0) > 0;
    case "dynamic_tool":
      return item.outputOmitted === true || toolCallHasLines(toolCallLines({ args: item.input }));
    case "approval_request":
      return Boolean(item.prompt?.trim());
    case "user_input_request":
      return item.questions.length > 0;
    case "notification":
      return Boolean(item.detail?.trim());
    case "system_notice":
      return item.message.trim().length > 0;
    case "error":
      return item.failure.message.trim().length > 0;
    case "proposed_plan":
      return item.markdown.trim().length > 0;
    case "todo_list":
      return item.steps.length > 0;
    case "subagent":
      return item.childThreadId !== null;
    default:
      return false;
  }
}
