import {
  DeviceToolListResult,
  DeviceToolOpenResult,
  type DeviceSummary,
  type OrchestrationV2ProjectedTurnItem,
} from "@specweave-studio/contracts";
import { resolveStudioMcpToolId } from "@specweave-studio/shared/studioMcpToolPresentation";
import { compactDynamicToolOutput } from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The card lists this many devices; the rest are in the Device panel. */
export const RUN_ON_DEVICE_CARD_LIMIT = 6;

export const runOnDeviceKey = (device: { readonly hostId: string; readonly deviceId: string }) =>
  `${device.hostId}\u0000${device.deviceId}`;

/** The device tool calls one card is built from. */
export interface RunOnDeviceSource {
  /** The newest successful device_list or device_open call: the card sits there. */
  readonly anchor: { readonly itemId: string; readonly createdAt: string };
  /** The newest successful device_list call, which names the devices. */
  readonly list: OrchestrationV2ProjectedTurnItem | null;
  /** The newest successful device_open call, used when nothing was listed. */
  readonly open: OrchestrationV2ProjectedTurnItem | null;
}

export interface RunOnDeviceCardDevice {
  readonly device: DeviceSummary;
  readonly hostLabel: string | undefined;
}

export interface RunOnDeviceCardModel {
  readonly devices: ReadonlyArray<RunOnDeviceCardDevice>;
  /** Devices the tool result reported open in this thread, by `runOnDeviceKey`. */
  readonly openKeys: ReadonlyArray<string>;
  /** Which Macs elsewhere can run iOS Simulators, when this machine cannot. */
  readonly hint: string | null;
}

type DeviceTool = "device_list" | "device_open";

function deviceTool(row: OrchestrationV2ProjectedTurnItem): DeviceTool | null {
  const { item } = row;
  if (item.type !== "dynamic_tool" || item.status !== "completed") return null;
  const tool = resolveStudioMcpToolId(item.toolName);
  if (tool !== "device_list" && tool !== "device_open") return null;
  // MCP errors can come back as a completed call that carries an error result.
  return compactDynamicToolOutput(item.output)?.isError ? null : tool;
}

/** Picks the calls behind the thread's one card; null when no device tool succeeded. */
export function runOnDeviceSource(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): RunOnDeviceSource | null {
  let list: OrchestrationV2ProjectedTurnItem | null = null;
  let open: OrchestrationV2ProjectedTurnItem | null = null;
  for (const row of rows) {
    const tool = deviceTool(row);
    if (tool === null) continue;
    const current = tool === "device_list" ? list : open;
    if (current !== null && current.position > row.position) continue;
    if (tool === "device_list") list = row;
    else open = row;
  }
  const anchor =
    list === null ? open : open === null || list.position > open.position ? list : open;
  if (anchor === null) return null;
  return {
    anchor: {
      itemId: anchor.item.id,
      createdAt: DateTime.formatIso(anchor.item.startedAt ?? anchor.item.updatedAt),
    },
    list,
    open,
  };
}

const MAX_RESULT_DEPTH = 4;

/** The result object inside the MCP envelopes the providers keep, or undefined. */
function toolResultData(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > MAX_RESULT_DEPTH) return undefined;
  if (typeof value === "string") {
    try {
      return toolResultData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const text =
        block !== null && typeof block === "object" && "text" in block ? block.text : undefined;
      const data = toolResultData(text, depth + 1);
      if (data !== undefined) return data;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const structured = record.structuredContent;
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  if (record.content !== undefined) return toolResultData(record.content, depth + 1);
  return record;
}

const decodeListResult = Schema.decodeUnknownOption(DeviceToolListResult);
const decodeOpenResult = Schema.decodeUnknownOption(DeviceToolOpenResult);

/** The part of the hint a person can act on; the rest tells the agent how to move the work. */
export function runOnDeviceHintText(hint: string): string {
  return hint.split(/\s+Run this work there\b/)[0]!.trim();
}

const byPlatformThenRunning = (left: DeviceSummary, right: DeviceSummary) =>
  (left.platform === right.platform ? 0 : left.platform === "ios" ? -1 : 1) ||
  Number(right.booted) - Number(left.booted) ||
  left.name.localeCompare(right.name);

/**
 * Builds the card from the full tool results. A result that does not decode
 * counts as missing, so a malformed or empty one shows no card.
 */
export function runOnDeviceCard(results: {
  readonly list?: unknown;
  readonly open?: unknown;
}): RunOnDeviceCardModel | null {
  const listed = Option.getOrUndefined(decodeListResult(toolResultData(results.list)));
  if (listed !== undefined) {
    const hint = listed.hint?.trim() ? runOnDeviceHintText(listed.hint) : null;
    if (listed.devices.length === 0 && hint === null) return null;
    return {
      devices: listed.devices.toSorted(byPlatformThenRunning).map((device) => ({
        device,
        hostLabel: listed.hosts.find((host) => host.id === device.hostId)?.label,
      })),
      openKeys: listed.open.map(runOnDeviceKey),
      hint,
    };
  }
  const opened = Option.getOrUndefined(decodeOpenResult(toolResultData(results.open)));
  if (opened === undefined) return null;
  return {
    devices: [{ device: opened.device, hostLabel: undefined }],
    openKeys: [runOnDeviceKey({ hostId: opened.device.hostId, deviceId: opened.device.id })],
    hint: null,
  };
}

interface TimelineRowLike {
  readonly id: string;
  readonly createdAt: string | null;
}

/**
 * The timeline row the card follows: the row that shows the anchoring call,
 * or, while that call is folded away, the last row from before it ended.
 */
export function runOnDeviceRowId(
  rows: ReadonlyArray<TimelineRowLike>,
  anchor: RunOnDeviceSource["anchor"],
): string | null {
  const showing = rows.findLast(
    (row) =>
      "groupedEntries" in row &&
      Array.isArray(row.groupedEntries) &&
      row.groupedEntries.some((entry: { readonly id?: unknown }) => entry.id === anchor.itemId),
  );
  if (showing !== undefined) return showing.id;
  // Times can differ in format, so they are compared as instants; one that does not parse never matches.
  const anchorAt = Date.parse(anchor.createdAt);
  if (Number.isNaN(anchorAt)) return null;
  return (
    rows.findLast((row) => row.createdAt !== null && Date.parse(row.createdAt) <= anchorAt)?.id ??
    null
  );
}
