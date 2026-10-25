// @effect-diagnostics globalDate:off globalTimers:off - Fake timers stand in for the browser timer that re-renders an open row.
import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemDetailField,
  type OrchestrationV2TurnItemPage,
} from "@specweave-studio/contracts";
import { sliceTextPage, TRANSPORT_TRUNCATION_MARKER } from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  LIVE_DETAIL_REFRESH_MS,
  readFullTurnItemText,
  streamsToolOutputForDriver,
  stripTransportMarker,
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputImages,
  turnItemOutputText,
} from "./itemDetail.ts";

const screenshot = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__studio-code__device_screenshot",
  input: { deviceId: "phone" },
  // What a detail read returns: the image's position without its bytes.
  output: {
    content: [
      { type: "text", text: "Captured the home screen." },
      { type: "image", mimeType: "image/png" },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

describe("tool output images", () => {
  it("shows a screenshot as an image asset, not as text", () => {
    expect(turnItemOutputImages(screenshot)).toEqual([
      {
        _tag: "tool-output-image",
        threadId: screenshot.threadId,
        itemId: screenshot.id,
        index: 0,
      },
    ]);
    expect(turnItemOutputText(screenshot)).toBe("Captured the home screen.");
    expect(
      turnItemOutputText({ ...screenshot, output: { content: [screenshot.output.content[1]] } }),
    ).toBeNull();
  });

  it("keeps a placeholder for images it cannot show", () => {
    const output = { content: [{ type: "image", mimeType: "image/svg+xml" }] };
    expect(turnItemOutputImages({ ...screenshot, output })).toEqual([]);
    expect(turnItemOutputText({ ...screenshot, output })).toBe("[image]");
  });
});

const itemBase = {
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const command: OrchestrationV2TurnItem = {
  ...itemBase,
  id: TurnItemId.make("command"),
  type: "command_execution",
  status: "running",
  input: "pnpm test",
};

describe("detail fetches", () => {
  it("fetches an edit whose body the wire withheld", () => {
    const edit: OrchestrationV2TurnItem = {
      ...itemBase,
      id: TurnItemId.make("edit"),
      type: "file_change",
      status: "completed",
      fileName: "/repo/src/App.tsx",
    };
    expect(turnItemNeedsDetailFetch(edit)).toBe(false);
    expect(turnItemNeedsDetailFetch({ ...edit, diffOmitted: true })).toBe(true);
  });

  it("streams tool output only for providers that handle output deltas", () => {
    expect(streamsToolOutputForDriver("acpRegistry", true)).toBe(true);
    expect(streamsToolOutputForDriver("codex", true)).toBe(false);
    expect(streamsToolOutputForDriver("claudeAgent", false)).toBe(false);
    expect(streamsToolOutputForDriver("opencode", undefined)).toBe(false);
  });

  it("keys a finished item by revision and a running one by its refresh bucket", () => {
    const completed = { ...command, status: "completed" as const };
    expect(turnItemDetailRevision(completed, { streamsToolOutput: true })).toBe(
      "2026-10-05T00:00:01.000Z",
    );
    expect(turnItemDetailRevision(command, { nowMs: 0 })).toBe("live");
    expect(turnItemDetailRevision(command, { streamsToolOutput: false, nowMs: 9_999 })).toBe(
      "live",
    );
    const at = (nowMs: number) =>
      turnItemDetailRevision(command, { streamsToolOutput: true, nowMs });
    expect(at(10_000)).toBe(at(10_000 + LIVE_DETAIL_REFRESH_MS - 1));
    expect(at(10_000)).not.toBe(at(10_000 + LIVE_DETAIL_REFRESH_MS));
  });
});

describe("live detail refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An open row re-rendered by a 1-second timer, fetching whenever its cache key changes. */
  function openRow(item: () => OrchestrationV2TurnItem, streamsToolOutput: boolean) {
    const fetches: number[] = [];
    let key: string | null = null;
    const render = () => {
      const next = turnItemDetailRevision(item(), { streamsToolOutput });
      if (next !== key) fetches.push(Date.now());
      key = next;
    };
    render();
    const timer = setInterval(render, 1_000);
    return { fetches, close: () => clearInterval(timer) };
  }

  it("refetches at most once every 2 s and at least once every 3 s while open", () => {
    vi.useFakeTimers();
    const start = 1_760_000_000_700;
    vi.setSystemTime(start);
    let current: OrchestrationV2TurnItem = command;
    const row = openRow(() => current, true);
    vi.advanceTimersByTime(20_000);

    expect(row.fetches[0]).toBe(start);
    const gaps = row.fetches.slice(1).map((at, index) => at - row.fetches[index]!);
    expect(gaps.length).toBeGreaterThanOrEqual(9);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(2_000);
      expect(gap).toBeLessThanOrEqual(3_000);
    }

    // Completion fetches once more, then the key stays put.
    const beforeCompletion = row.fetches.length;
    current = { ...command, status: "completed", updatedAt: DateTime.makeUnsafe(start + 20_500) };
    vi.advanceTimersByTime(10_000);
    expect(row.fetches.length).toBe(beforeCompletion + 1);

    row.close();
    current = command;
    vi.advanceTimersByTime(10_000);
    expect(row.fetches.length).toBe(beforeCompletion + 1);
  });

  it("stops refetching when the row closes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    const row = openRow(() => command, true);
    vi.advanceTimersByTime(4_500);
    const fetched = row.fetches.length;
    row.close();
    vi.advanceTimersByTime(20_000);
    expect(row.fetches.length).toBe(fetched);
  });

  it("fetches a running row of a non-streaming provider once until it ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    const row = openRow(() => command, false);
    vi.advanceTimersByTime(20_000);
    row.close();
    expect(row.fetches).toHaveLength(1);
  });
});

/** A server that pages its stored text with the real slicer. */
function pagingServer(stored: { text: string; revision: string }, maxBytes?: number) {
  const offsets: number[] = [];
  const fetchPage = async (input: {
    readonly offset: number;
    readonly field: OrchestrationV2TurnItemDetailField;
    readonly changeIndex?: number;
  }): Promise<{ readonly page?: OrchestrationV2TurnItemPage }> => {
    offsets.push(input.offset);
    const page = sliceTextPage(stored.text, { offset: input.offset, maxBytes });
    return {
      page: {
        field: input.field,
        ...(input.changeIndex === undefined ? {} : { changeIndex: input.changeIndex }),
        offset: page.offset,
        end: page.end,
        totalLength: page.totalLength,
        nextOffset: page.nextOffset,
        revision: stored.revision,
        text: page.text,
      },
    };
  };
  return { fetchPage, offsets };
}

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

describe("readFullTurnItemText", () => {
  it("joins every page into the exact stored text across emoji on page boundaries", async () => {
    const text = `${"x".repeat(5)}😀é中\n`.repeat(40) + "🧪";
    for (const maxBytes of [4, 5, 7, 13]) {
      const server = pagingServer({ text, revision: "r1" }, maxBytes);
      const result = await readFullTurnItemText(server.fetchPage, { field: "output" });
      expect(result).toEqual({ text, revision: "r1" });
      expect(await sha256(result.text)).toBe(await sha256(text));
      expect(server.offsets.length).toBeGreaterThan(10);
    }
  });

  it("reads text longer than one 256 KiB page without the transport marker", async () => {
    const text = "line 😀 with é and 中\n".repeat(30_000);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(256 * 1024 * 2);
    const server = pagingServer({ text, revision: "r1" });
    const result = await readFullTurnItemText(server.fetchPage, { field: "body", changeIndex: 2 });
    expect(await sha256(result.text)).toBe(await sha256(text));
    expect(result.text).not.toContain(TRANSPORT_TRUNCATION_MARKER);
    expect(server.offsets.length).toBeGreaterThanOrEqual(3);
  });

  it("restarts from the first page when the revision changes mid-copy", async () => {
    const stored = { text: "a😀".repeat(20), revision: "r1" };
    const server = pagingServer(stored, 8);
    const fetchPage: typeof server.fetchPage = async (input) => {
      const result = await server.fetchPage(input);
      if (server.offsets.length === 2) {
        // The running command wrote more output after the first two pages.
        stored.text += "b🧪".repeat(10);
        stored.revision = "r2";
      }
      return result;
    };
    const result = await readFullTurnItemText(fetchPage, { field: "output" });
    expect(result).toEqual({ text: stored.text, revision: "r2" });
    expect(server.offsets.filter((offset) => offset === 0)).toHaveLength(2);
  });

  it("rejects after three restarts and when the server does not page", async () => {
    let revision = 0;
    const changing = async (input: { readonly offset: number }) => {
      const page = sliceTextPage("abcdef", { offset: input.offset, maxBytes: 4 });
      revision += 1;
      return { page: { field: "output" as const, ...page, revision: `r${revision}` } };
    };
    await expect(readFullTurnItemText(changing, { field: "output" })).rejects.toThrow(
      "The item kept changing while it was read.",
    );
    expect(revision).toBe(8);
    await expect(readFullTurnItemText(async () => ({}), { field: "input" })).rejects.toThrow();
  });
});

describe("stripTransportMarker", () => {
  it("removes the marker an older client would show", () => {
    expect(stripTransportMarker(`page${TRANSPORT_TRUNCATION_MARKER}`)).toBe("page");
    expect(stripTransportMarker("whole text")).toBe("whole text");
    expect(
      stripTransportMarker(`page${TRANSPORT_TRUNCATION_MARKER}`, {
        field: "output",
        offset: 0,
        end: 4,
        totalLength: 9,
        nextOffset: 4,
        revision: "r1",
      }),
    ).toBe("page");
    // A field the read did not cut is returned as stored, even if it ends like the marker.
    expect(stripTransportMarker(`text${TRANSPORT_TRUNCATION_MARKER}`, null)).toBe(
      `text${TRANSPORT_TRUNCATION_MARKER}`,
    );
  });
});
