import type { OrchestrationV2ProjectedTurnItem } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  runOnDeviceCard,
  runOnDeviceHintText,
  runOnDeviceRowId,
  runOnDeviceSource,
} from "./runOnDeviceCard.logic";

const host = {
  id: "local",
  kind: "local",
  label: "Studio Mac",
  platforms: [
    { platform: "ios", available: true },
    { platform: "android", available: true },
  ],
  hubInstalled: true,
  agentDeviceInstalled: true,
};
const iphone = {
  hostId: "local",
  id: "IPHONE-UDID",
  platform: "ios",
  name: "iPhone 17 Pro",
  version: "iOS 26.0",
  booted: true,
  physical: false,
};
const pixel = {
  hostId: "local",
  id: "emulator-5554",
  platform: "android",
  name: "Pixel 9",
  version: "Android 15.0",
  booted: false,
  physical: false,
};
const listResult = (overrides: Record<string, unknown> = {}) => ({
  hostStatuses: { local: { status: "ready" } },
  hosts: [host],
  devices: [pixel, iphone],
  open: [],
  ...overrides,
});
/** What an MCP server returns: the same result as text and as structured content. */
const envelope = (result: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});

let position = 0;
function call(
  toolName: string,
  options: { status?: string; output?: unknown; at?: string } = {},
): OrchestrationV2ProjectedTurnItem {
  position += 1;
  const at = DateTime.makeUnsafe(options.at ?? `2026-11-12T10:00:0${position % 10}.000Z`);
  return {
    position,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: `item-${position}`,
    item: {
      id: `item-${position}`,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      status: options.status ?? "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "dynamic_tool",
      toolName,
      input: {},
      ...("output" in options ? { output: options.output } : { output: {}, outputOmitted: true }),
    },
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

describe("runOnDeviceSource", () => {
  it("finds no card in a thread without device tools", () => {
    expect(runOnDeviceSource([])).toBeNull();
    expect(
      runOnDeviceSource([call("mcp__studio-code__html_render"), call("Bash", { output: "ok" })]),
    ).toBeNull();
  });

  it("finds no card when the device call failed", () => {
    expect(runOnDeviceSource([call("mcp__studio-code__device_list", { status: "failed" })])).toBe(
      null,
    );
    expect(
      runOnDeviceSource([
        call("mcp__studio-code__device_open", {
          output: { isError: true, content: [{ type: "text", text: "Device support is off." }] },
        }),
      ]),
    ).toBeNull();
    expect(runOnDeviceSource([call("mcp__studio-code__device_list", { status: "running" })])).toBe(
      null,
    );
  });

  it("puts the card at the newest successful call and keeps the newest list", () => {
    const first = call("mcp__studio-code__device_list");
    const second = call("studio-code.device_list");
    const opened = call("mcp__studio-code__device_open");
    const failed = call("mcp__studio-code__device_list", { status: "failed" });
    const source = runOnDeviceSource([first, second, opened, failed]);
    expect(source?.anchor.itemId).toBe(opened.item.id);
    expect(source?.list).toBe(second);
    expect(source?.open).toBe(opened);
    expect(source?.anchor.createdAt).toBe(
      DateTime.formatIso(opened.item.startedAt ?? opened.item.updatedAt),
    );
  });

  it("orders calls by their timeline position, not array order", () => {
    const older = call("mcp__studio-code__device_list");
    const newer = call("mcp__studio-code__device_list");
    expect(runOnDeviceSource([newer, older])?.list).toBe(newer);
  });
});

describe("runOnDeviceCard", () => {
  it("lists every device from the list result, iOS first and running first", () => {
    const card = runOnDeviceCard({
      list: envelope(listResult({ open: [{ hostId: "local", deviceId: "IPHONE-UDID" }] })),
    });
    expect(card?.devices.map((entry) => entry.device.name)).toEqual(["iPhone 17 Pro", "Pixel 9"]);
    expect(card?.devices[0]?.hostLabel).toBe("Studio Mac");
    expect(card?.openKeys).toEqual(["local\u0000IPHONE-UDID"]);
    expect(card?.hint).toBeNull();
  });

  it("reads a result kept as text only or as a bare object", () => {
    const asText = runOnDeviceCard({
      list: [{ type: "text", text: JSON.stringify(listResult()) }],
    });
    expect(asText?.devices).toHaveLength(2);
    expect(runOnDeviceCard({ list: JSON.stringify(listResult()) })?.devices).toHaveLength(2);
    expect(runOnDeviceCard({ list: listResult() })?.devices).toHaveLength(2);
  });

  it("shows no card for an empty or malformed result, without throwing", () => {
    expect(runOnDeviceCard({})).toBeNull();
    expect(runOnDeviceCard({ list: envelope(listResult({ devices: [] })) })).toBeNull();
    expect(runOnDeviceCard({ list: "not json" })).toBeNull();
    expect(runOnDeviceCard({ list: { devices: "many" } })).toBeNull();
    expect(
      runOnDeviceCard({ list: envelope(listResult({ devices: [{ ...iphone, name: "" }] })) }),
    ).toBeNull();
    expect(runOnDeviceCard({ open: { device: { id: 5 } } })).toBeNull();
  });

  it("falls back to the opened device when nothing was listed", () => {
    const card = runOnDeviceCard({
      open: envelope({
        device: iphone,
        agentDevice: { command: "agent-device", targetArgs: ["--udid", "IPHONE-UDID"] },
        quickStart: "The user is watching iPhone 17 Pro.",
      }),
    });
    expect(card?.devices.map((entry) => entry.device.name)).toEqual(["iPhone 17 Pro"]);
    expect(card?.openKeys).toEqual(["local\u0000IPHONE-UDID"]);
  });

  it("surfaces the only-another-Mac hint, without the agent's instructions", () => {
    const hint =
      'This machine cannot run iOS Simulators and has no device host set up. Connected Mac that can: Studio Mac. Run this work there: start it with studio_thread_launch and needs:["ios_simulator"] (or machine:"Studio Mac"), or move this thread with studio_thread_migrate.';
    const card = runOnDeviceCard({ list: envelope(listResult({ devices: [], hint })) });
    expect(card?.devices).toEqual([]);
    expect(card?.hint).toBe(
      "This machine cannot run iOS Simulators and has no device host set up. Connected Mac that can: Studio Mac.",
    );
    const withAndroid = runOnDeviceCard({ list: envelope(listResult({ devices: [pixel], hint })) });
    expect(withAndroid?.devices.map((entry) => entry.device.name)).toEqual(["Pixel 9"]);
    expect(withAndroid?.hint).toContain("Studio Mac");
  });

  it("keeps a hint without agent instructions whole", () => {
    const hint =
      "This machine cannot run iOS Simulators and has no device host set up, and no connected Mac reports that it can.";
    expect(runOnDeviceHintText(hint)).toBe(hint);
  });
});

describe("runOnDeviceRowId", () => {
  const anchor = { itemId: "item-b", createdAt: "2026-11-12T10:00:02.000Z" };

  it("follows the row that shows the call", () => {
    const rows = [
      { id: "user", kind: "message", createdAt: "2026-11-12T10:00:00.000Z" },
      {
        id: "work",
        kind: "work",
        createdAt: "2026-11-12T10:00:01.000Z",
        groupedEntries: [{ id: "item-a" }, { id: "item-b" }],
      },
      { id: "reply", kind: "message", createdAt: "2026-11-12T10:00:02.000Z" },
    ];
    expect(runOnDeviceRowId(rows, anchor)).toBe("work");
  });

  it("follows the folded row when the call is not shown", () => {
    const rows = [
      { id: "user", kind: "message", createdAt: "2026-11-12T10:00:00.000Z" },
      { id: "fold", kind: "turn-fold", createdAt: "2026-11-12T10:00:01.000Z" },
      { id: "working", kind: "working", createdAt: null },
      { id: "reply", kind: "message", createdAt: "2026-11-12T10:00:09.000Z" },
    ];
    expect(runOnDeviceRowId(rows, anchor)).toBe("fold");
    expect(runOnDeviceRowId([], anchor)).toBeNull();
  });

  it("compares times as instants when their formats differ", () => {
    const rows = [
      { id: "user", kind: "message", createdAt: "2026-11-12T10:00:01+00:00" },
      { id: "later", kind: "message", createdAt: "2026-11-12T10:00:02.400+00:00" },
    ];
    // As text, ".400+00:00" sorts before "Z", so the later row would wrongly match.
    expect(runOnDeviceRowId(rows, { itemId: "item-b", createdAt: "2026-11-12T10:00:02Z" })).toBe(
      "user",
    );
  });

  it("matches no row when a time does not parse", () => {
    const rows = [
      { id: "user", kind: "message", createdAt: "2026-11-12T10:00:00.000Z" },
      { id: "broken", kind: "message", createdAt: "not a time" },
    ];
    expect(runOnDeviceRowId(rows, anchor)).toBe("user");
    expect(runOnDeviceRowId(rows, { itemId: "item-b", createdAt: "not a time" })).toBeNull();
  });
});
