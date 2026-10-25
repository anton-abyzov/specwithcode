import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2FileChangeDetail,
  OrchestrationV2GetTurnItemInput,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemDetailField,
  OrchestrationV2TurnItemPage,
  OrchestrationV2TurnItemPageInfo,
} from "@specweave-studio/contracts";
import { countPatchLines } from "@specweave-studio/shared/structuredPatch";
import { fileChangePatchText } from "./fileChangePatches.ts";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  sliceTextPage,
  type TextPage,
  toolOutputImages,
  toolOutputIndicatesFailure,
  TRANSPORT_TRUNCATION_MARKER,
} from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}${TRANSPORT_TRUNCATION_MARKER}`;
}

function hasBody(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function sumChangeCounts(changes: ReadonlyArray<OrchestrationV2FileChangeDetail> | undefined): {
  additions?: number;
  deletions?: number;
} {
  let additions: number | undefined;
  let deletions: number | undefined;
  for (const change of changes ?? []) {
    if (change.additions !== undefined) additions = (additions ?? 0) + change.additions;
    if (change.deletions !== undefined) deletions = (deletions ?? 0) + change.deletions;
  }
  return {
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
  };
}

/**
 * Fills in +/- counts the provider did not send, from the full patches before
 * any bounding. Text without a hunk (an error message) gives no count, so an
 * unknown count stays absent instead of reading as 0. The count is linear;
 * this runs on every item update, so it never computes a line diff.
 */
function withPatchCounts(item: FileChangeItem): FileChangeItem {
  const changes = item.changes?.map((change) => {
    if (change.additions !== undefined || change.deletions !== undefined) return change;
    const counts = change.diffStr ? countPatchLines(change.diffStr) : null;
    return counts === null ? change : { ...change, ...counts };
  });
  const withChanges = changes === undefined ? item : { ...item, changes };
  if (item.additions !== undefined || item.deletions !== undefined) return withChanges;
  // A failed edit keeps the provider's error text where the patch would be.
  const own = item.status !== "failed" && item.diffStr ? countPatchLines(item.diffStr) : null;
  return { ...withChanges, ...(own ?? sumChangeCounts(changes)) };
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)));
      return {
        ...projected,
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      // File identity and counts are enough for activity. Full diffs already
      // have a dedicated read path and remain intact in persistence.
      const { diffStr, oldStr, newStr, changes, ...projected } = withPatchCounts(item);
      // A failed edit stores the provider's error where the diff would be.
      const kept =
        item.status === "failed" && diffStr?.trim() ? truncateDetail(diffStr) : undefined;
      let diffOmitted =
        (kept === undefined ? hasBody(diffStr) : kept !== diffStr) ||
        hasBody(oldStr) ||
        hasBody(newStr);
      // Approval previews show each change's own patch, so it stays, bounded.
      const boundedChanges = changes?.map((change) => {
        const bounded = change.diffStr === undefined ? undefined : truncateDetail(change.diffStr);
        if (bounded === undefined || bounded === change.diffStr) return change;
        diffOmitted = true;
        return { ...change, diffStr: bounded };
      });
      return {
        ...projected,
        ...(boundedChanges === undefined ? {} : { changes: boundedChanges }),
        ...(kept === undefined ? {} : { diffStr: kept }),
        ...(diffOmitted ? { diffOmitted: true } : {}),
      };
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      const output = compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(hasDynamicValue(rawOutput) ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

/** What a detail read can page, as the contract names it. */
interface DetailTarget {
  readonly field: OrchestrationV2TurnItemDetailField;
  readonly changeIndex?: number | undefined;
  readonly structured?: boolean | undefined;
}

/** The fields a no-field detail read cut, all at one item revision. */
interface DetailCuts {
  readonly revision: string;
  readonly entries: Array<OrchestrationV2TurnItemPageInfo>;
}

function pageInfo(
  page: TextPage,
  target: DetailTarget,
  revision: string,
): OrchestrationV2TurnItemPageInfo {
  return {
    field: target.field,
    ...(target.changeIndex === undefined ? {} : { changeIndex: target.changeIndex }),
    offset: page.offset,
    end: page.end,
    totalLength: page.totalLength,
    nextOffset: page.nextOffset,
    revision,
    ...(target.structured === true ? { structured: true } : {}),
  };
}

/**
 * A text cut to its first page plus the transport marker older clients show.
 * A cut of a pageable field is recorded, so newer clients know its bounds.
 */
function firstPageText(text: string, cuts: DetailCuts, target?: DetailTarget): string {
  const page = sliceTextPage(text);
  if (page.nextOffset === null) return text;
  if (target !== undefined) cuts.entries.push(pageInfo(page, target, cuts.revision));
  return `${page.text}${TRANSPORT_TRUNCATION_MARKER}`;
}

/** A structured value's compact JSON, so measuring does not inflate it; clients indent it. */
function compactJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return null;
  }
}

function boundDynamicValue(value: unknown, field: "input" | "output", cuts: DetailCuts): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return firstPageText(value, cuts, { field });
  const json = compactJson(value);
  if (json === null) return "Unserializable tool value";
  const bounded = firstPageText(json, cuts, { field, structured: true });
  return bounded === json ? value : bounded;
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown, cuts: DetailCuts): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted, "output", cuts);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

function boundTurnItemForDetail(
  item: OrchestrationV2TurnItem,
  cuts: DetailCuts,
): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: firstPageText(item.input, cuts, { field: "input" }),
        ...(item.output === undefined
          ? {}
          : { output: firstPageText(item.output, cuts, { field: "output" }) }),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input, "input", cuts),
        output: boundToolOutput(item.output, cuts),
      };
    case "subagent":
      return {
        ...item,
        prompt: firstPageText(item.prompt, cuts),
        ...(item.progress === undefined ? {} : { progress: firstPageText(item.progress, cuts) }),
        result: item.result === null ? null : firstPageText(item.result, cuts),
      };
    case "file_change": {
      const { diffStr, oldStr, newStr, changes, ...counted } = withPatchCounts(item);
      return {
        ...counted,
        ...(diffStr === undefined
          ? {}
          : { diffStr: firstPageText(diffStr, cuts, { field: "body" }) }),
        // No field names these, so they cannot be paged; the marker still says they were cut.
        ...(oldStr === undefined ? {} : { oldStr: firstPageText(oldStr, cuts) }),
        ...(newStr === undefined ? {} : { newStr: firstPageText(newStr, cuts) }),
        ...(changes === undefined
          ? {}
          : {
              changes: changes.map((change, changeIndex) =>
                change.diffStr === undefined
                  ? change
                  : {
                      ...change,
                      diffStr: firstPageText(change.diffStr, cuts, {
                        field: "body",
                        changeIndex,
                      }),
                    },
              ),
            }),
      };
    }
    case "handoff":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

/** The full stored text a field read pages, or null when the item has no such field. */
function detailFieldText(
  item: OrchestrationV2TurnItem,
  field: OrchestrationV2TurnItemDetailField,
  changeIndex: number | undefined,
): { readonly text: string; readonly structured: boolean } | null {
  const dynamicValueText = (value: unknown) => {
    if (value === undefined) return null;
    if (typeof value === "string") return { text: value, structured: false };
    const json = compactJson(value);
    return json === null ? null : { text: json, structured: true };
  };
  switch (field) {
    case "output":
      if (item.type === "command_execution") {
        return item.output === undefined ? null : { text: item.output, structured: false };
      }
      return item.type === "dynamic_tool" && item.output !== undefined
        ? dynamicValueText(omitToolOutputImageData(item.output))
        : null;
    case "input":
      if (item.type === "command_execution") return { text: item.input, structured: false };
      return item.type === "dynamic_tool" ? dynamicValueText(item.input) : null;
    case "body": {
      if (item.type !== "file_change") return null;
      // Without a change index the body is the whole patch; Codex items keep it
      // only on their changes, so it is joined from them at read time.
      const body =
        changeIndex === undefined
          ? fileChangePatchText(item)
          : item.changes?.[changeIndex]?.diffStr;
      return body === undefined ? null : { text: body, structured: false };
    }
  }
}

/**
 * The item a field read returns beside its page. The timeline keeps a command's
 * input whole, and clients show the command from there; repeating it with every
 * page of a long output would multiply its size by the page count.
 */
function boundFieldReadItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return item.type === "command_execution"
    ? { ...item, input: truncateDetail(item.input) ?? "" }
    : item;
}

/** What a detail read asks for: the getTurnItem input without the item's identity. */
export type TurnItemDetailRequest = Pick<
  OrchestrationV2GetTurnItemInput,
  "field" | "changeIndex" | "offset" | "before" | "anchor" | "limit"
>;

export interface TurnItemDetail {
  readonly item: OrchestrationV2TurnItem;
  readonly page?: OrchestrationV2TurnItemPage;
  readonly truncated?: ReadonlyArray<OrchestrationV2TurnItemPageInfo>;
}

/**
 * Projects one item for an on-demand detail read. Without a field it keeps the
 * input, output and edit bodies the timeline withholds, each cut to its first
 * page so a huge result cannot stall the socket, and lists every cut in
 * `truncated`. With a field it returns the timeline item and one page of that
 * field's full stored text, with no marker. Image bytes are left out; clients
 * load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(
  item: OrchestrationV2TurnItem,
  request: TurnItemDetailRequest = {},
): TurnItemDetail {
  const revision = DateTime.formatIso(item.updatedAt);
  if (request.field !== undefined) {
    const projected = boundFieldReadItem(projectTurnItemForWire(item));
    const changeIndex = request.field === "body" ? request.changeIndex : undefined;
    const source = detailFieldText(item, request.field, changeIndex);
    if (source === null) return { item: projected };
    const page = sliceTextPage(source.text, {
      offset: request.offset,
      before: request.before,
      anchor: request.anchor,
      maxBytes: request.limit,
    });
    const target = { field: request.field, changeIndex, structured: source.structured };
    return { item: projected, page: { ...pageInfo(page, target, revision), text: page.text } };
  }
  const cuts: DetailCuts = { revision, entries: [] };
  const projected = boundTurnItemForDetail(item, cuts);
  return cuts.entries.length === 0
    ? { item: projected }
    : { item: projected, truncated: cuts.entries };
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

/** Wire form of one projected row; passes null and undefined through. */
export function projectProjectedTurnItemForWire<
  Row extends OrchestrationV2ProjectedTurnItem | null | undefined,
>(row: Row): Row {
  if (row === null || row === undefined) return row;
  return { ...row, item: projectTurnItemForWire(row.item) };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "context-handoff.updated"
      ? { ...event, payload: projectContextHandoffForWire(event.payload) }
      : event;
}
