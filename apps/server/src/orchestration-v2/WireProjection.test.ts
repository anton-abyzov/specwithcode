import {
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2TurnItemPage,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import { countPatchLines, headedPatch } from "@specweave-studio/shared/structuredPatch";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  projectTurnItemForWire,
  projectTurnItemForDetail,
  projectDomainEventForWire,
  type TurnItemDetailRequest,
} from "./WireProjection.ts";
import { threadShellFromProjection } from "./ProjectionStore.ts";
import {
  DETAIL_PAGE_MAX_BYTES,
  MAX_TOOL_OUTPUT_IMAGES,
  omitToolOutputImageData,
  toolOutputImages,
  TRANSPORT_TRUNCATION_MARKER,
} from "@specweave-studio/shared/toolOutput";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
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
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const item = {
      ...base,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({ viewedImagePath: "/workspace/reference.png" });
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("preserves provider notices in bounded items and live events", () => {
    const item = {
      ...base,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    expect(projectTurnItemForWire(item)).toEqual(item);
    const event = {
      id: EventId.make("notice-wire-event"),
      type: "turn-item.updated" as const,
      threadId: item.threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
    expect(projectDomainEventForWire(event)).toEqual(event);
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
      },
      runs: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          role: "assistant",
          text: "x".repeat(1_000_000),
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } as unknown as OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected).not.toHaveProperty("output");
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual({ ...base, outputOmitted: true });
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it.each([
    [" \t\r\n\n  first\t line  \r\n" + "x\n".repeat(10_000), "first line"],
    [" \n".repeat(10_000), "Large tool output"],
    ["a".repeat(160) + "\n" + "x".repeat(20_000), "a".repeat(160)],
    ["a".repeat(161) + "\n" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["a".repeat(159) + "\t b" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["  café\u00a0\u2003😀 \t\r\n" + "x".repeat(20_000), "café 😀"],
  ])("preserves bounded input summary normalization for case %#", (input, summary) => {
    const projected = projectTurnItemForWire({ ...base, input });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary,
      truncated: true,
    });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("serializes an oversized structured input only once for its summary", () => {
    let serializations = 0;
    const input = {
      toJSON() {
        serializations += 1;
        return { text: "x".repeat(100_000) };
      },
    };
    const projected = projectTurnItemForWire({ ...base, input });
    expect(serializations).toBe(1);
    expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
      truncated: true,
    });
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const progress = "a".repeat(32_767) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect code",
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(32_767) + "\n… output truncated for transport",
    );
    expect(item.progress).toBe(progress);
  });

  it.each(["", "small output", "x".repeat(1_048_576)])(
    "omits command output of every size, case %#",
    (output) => {
      const item = { ...base, type: "command_execution" as const, input: "test", output };
      const projected = projectTurnItemForWire(item);
      expect(projected).not.toHaveProperty("output");
      expect(projected).toMatchObject({ input: "test", status: "completed" });
      // Clients fetch withheld output on demand, so they need to know it exists.
      expect(projected.type === "command_execution" ? projected.outputOmitted : null).toBe(
        output ? true : undefined,
      );
      expect(item.output).toBe(output);
    },
  );

  it.each([
    ["echo ok", "echo ok"],
    ["a".repeat(262_143) + "😀", "a".repeat(262_143) + "\n… output truncated for transport"],
  ])("bounds fetched command input without changing persistence, case %#", (input, expected) => {
    const item = { ...base, type: "command_execution" as const, input, output: "ok" };
    const projected = projectTurnItemForDetail(item).item;
    expect(projected).toMatchObject({ input: expected, output: "ok" });
    expect(item.input).toBe(input);
  });

  it("leaves a screenshot's bytes out of the fetched tool output", () => {
    const data = "A".repeat(600_000);
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "mcp__studio-code__device_screenshot",
      input: { deviceId: "phone" },
      output: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    };
    expect(projectTurnItemForDetail(item).item).toMatchObject({
      output: { content: [{ type: "image", mimeType: "image/png" }] },
    });
    expect(item.output.content[0]?.source.data).toBe(data);
  });

  it("keeps image markers when the rest of a tool output is too large to send", () => {
    const image = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }, image] },
    };
    const projected = projectTurnItemForDetail(item).item;
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    expect(Array.isArray(output) ? output.slice(1) : null).toEqual([
      { type: "image", mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output).length).toBeLessThan(270_000);
  });

  it("bounds a tool output made of many images", () => {
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      output: Array.from({ length: 10_000 }, () => image),
    };
    const projected = projectTurnItemForDetail(item).item;
    const output = projected.type === "dynamic_tool" ? projected.output : null;
    // The truncated text block plus a fixed number of markers, however many images there are.
    expect(Array.isArray(output) ? output.length : null).toBe(1 + MAX_TOOL_OUTPUT_IMAGES);
    expect(Array.isArray(output) ? String(output[0]?.text).length : null).toBeLessThan(263_000);
    expect(toolOutputImages(output)).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
    // A failed edit keeps the provider's error so expanding the row can show it.
    const failed = projectTurnItemForWire({
      ...item,
      status: "failed",
      diffStr: "String to replace not found",
    });
    expect(failed).toMatchObject({ diffStr: "String to replace not found" });
    expect(failed).not.toHaveProperty("newStr");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("does not serialize raw dynamic output to discard it", () => {
    const output = {
      toJSON: () => {
        throw new Error("Raw output must not be serialized");
      },
    };
    expect(projectTurnItemForWire({ ...base, output })).not.toHaveProperty("output");
  });
});

const { toolName: _toolName, input: _input, ...itemBase } = base;
const revision = "2026-08-13T00:00:01.000Z";

function fileChangeItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "file_change" }>>,
) {
  return {
    ...itemBase,
    type: "file_change" as const,
    title: "Edit files",
    fileName: "src/large.ts",
    ...fields,
  } satisfies OrchestrationV2TurnItem;
}

/** A Codex update: a bare hunk the adapter gives file headers and counted ranges. */
function codexUpdatePatch(path: string, removed: number, added: number): string {
  const lines = [
    "@@",
    " export const header = true;",
    ...Array.from({ length: removed }, (_, index) => `-export const removed${index} = ${index};`),
    ...Array.from({ length: added }, (_, index) => `+export const added${index} = ${index};`),
    "",
  ];
  return headedPatch({ operation: "update", path, body: lines.join("\n") }).patch;
}

function joinPatches(patches: ReadonlyArray<string>): string {
  return patches.map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("");
}

/** The UTF-8 bytes Copy full writes; equal bytes mean equal SHA-256 digests. */
function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Reads every page of a field forward from offset 0. */
function readAllPages(
  item: OrchestrationV2TurnItem,
  request: Omit<TurnItemDetailRequest, "offset">,
) {
  const pages: Array<OrchestrationV2TurnItemPage> = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const { page } = projectTurnItemForDetail(item, { ...request, offset });
    if (page === undefined) throw new Error("Expected a page");
    pages.push(page);
    offset = page.nextOffset;
  }
  return pages;
}

describe("orchestration V2 edit bodies and detail pages", () => {
  it("counts a Codex change over 32 KiB from its full patch before bounding it", () => {
    const large = codexUpdatePatch("src/large.ts", 700, 2_000);
    const small = headedPatch({ operation: "add", path: "src/new.ts", body: "one\ntwo\n" }).patch;
    expect(Buffer.byteLength(large, "utf8")).toBeGreaterThan(32_768);
    const item = fileChangeItem({
      diffStr: joinPatches([large, small]),
      changes: [
        { operation: "update", path: "src/large.ts", diffStr: large },
        { operation: "add", path: "src/new.ts", diffStr: small },
      ],
    });

    const projected = projectTurnItemForWire(item);
    if (projected.type !== "file_change") throw new Error("Expected an edit");
    expect(countPatchLines(large)).toEqual({ additions: 2_000, deletions: 700 });
    expect(projected.changes?.[0]).toMatchObject({ additions: 2_000, deletions: 700 });
    expect(projected.changes?.[1]).toMatchObject({ additions: 2, deletions: 0, diffStr: small });
    expect(projected).toMatchObject({ additions: 2_002, deletions: 700, diffOmitted: true });
    expect(countPatchLines(item.diffStr ?? "")).toEqual({ additions: 2_002, deletions: 700 });
    expect(projected).not.toHaveProperty("diffStr");
    const bounded = projected.changes?.[0]?.diffStr ?? "";
    expect(bounded.endsWith(TRANSPORT_TRUNCATION_MARKER)).toBe(true);
    expect(
      Buffer.byteLength(bounded.slice(0, -TRANSPORT_TRUNCATION_MARKER.length), "utf8"),
    ).toBeLessThanOrEqual(32_768);
    expect(item.changes?.[0]?.diffStr).toBe(large);
    // Projecting the wire item again changes nothing, and it decodes as an item.
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(decodeTurnItem(projected)).toMatchObject({ diffOmitted: true });
  });

  it("keeps every change's patch for approval previews, bounded with the marker", () => {
    const patches = [
      codexUpdatePatch("src/a.ts", 10, 1_500),
      headedPatch({ operation: "add", path: "src/b.ts", body: "b\n" }).patch,
      codexUpdatePatch("src/c.ts", 1_200, 600),
    ];
    const item = fileChangeItem({
      status: "waiting",
      diffStr: joinPatches(patches),
      changes: patches.map((diffStr, index) => ({
        operation: index === 1 ? "add" : "update",
        path: `src/${"abc"[index]}.ts`,
        diffStr,
      })),
    });
    const projected = projectTurnItemForWire(item);
    if (projected.type !== "file_change") throw new Error("Expected an edit");
    const wirePatches = projected.changes?.map((change) => change.diffStr) ?? [];
    expect(wirePatches).toHaveLength(3);
    expect(wirePatches[1]).toBe(patches[1]);
    for (const index of [0, 2]) {
      const patch = wirePatches[index] ?? "";
      expect(patch.endsWith(TRANSPORT_TRUNCATION_MARKER)).toBe(true);
      expect(patches[index]?.startsWith(patch.slice(0, -TRANSPORT_TRUNCATION_MARKER.length))).toBe(
        true,
      );
    }
    expect(projected.diffOmitted).toBe(true);
    // The full patch stays readable from the row.
    expect(projectTurnItemForDetail(item, { field: "body", changeIndex: 2 }).page?.text).toBe(
      patches[2],
    );
  });

  it("keeps provider counts and never counts error text or a missing patch", () => {
    const patch = codexUpdatePatch("src/a.ts", 1, 1);
    const reported = projectTurnItemForWire(
      fileChangeItem({
        additions: 5,
        deletions: 1,
        diffStr: patch,
        changes: [{ operation: "update", path: "src/a.ts", additions: 3, deletions: 0 }],
      }),
    );
    expect(reported).toMatchObject({
      additions: 5,
      deletions: 1,
      changes: [{ additions: 3, deletions: 0 }],
    });

    // A failed edit's error text may quote a hunk; it is never counted.
    const failed = projectTurnItemForWire(
      fileChangeItem({ status: "failed", diffStr: "Patch did not apply:\n@@ -1 +1 @@\n-a\n+b\n" }),
    );
    expect(failed).not.toHaveProperty("additions");
    expect(failed).not.toHaveProperty("deletions");
    expect(failed).toMatchObject({ diffStr: "Patch did not apply:\n@@ -1 +1 @@\n-a\n+b\n" });
    expect(failed).not.toHaveProperty("diffOmitted");

    const unknown = projectTurnItemForWire(
      fileChangeItem({
        diffStr: "Wrote the file",
        changes: [{ operation: "update", path: "src/a.ts" }],
      }),
    );
    expect(unknown).not.toHaveProperty("additions");
    expect(unknown).not.toHaveProperty("deletions");
    expect(unknown).toMatchObject({ diffOmitted: true, changes: [{ path: "src/a.ts" }] });
    if (unknown.type !== "file_change") throw new Error("Expected an edit");
    expect(unknown.changes?.[0]).not.toHaveProperty("additions");

    // The item count falls back to the sum over the changes that have one.
    expect(
      projectTurnItemForWire(
        fileChangeItem({
          changes: [
            { operation: "update", path: "src/a.ts", diffStr: patch },
            { operation: "update", path: "src/b.ts" },
          ],
        }),
      ),
    ).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("pages a 600 KiB output back to the exact stored text, emoji on page boundaries", () => {
    // Each segment fills a page up to just before an emoji, so pages 2 and 3
    // both start with one. "é" is two UTF-8 bytes in one UTF-16 unit.
    const output =
      "a".repeat(262_143) +
      "😀" +
      "é".repeat(100_000) +
      "😀" +
      "b".repeat(62_135) +
      "😀" +
      "c".repeat(90_110);
    expect(Buffer.byteLength(output, "utf8")).toBe(600 * 1024);
    const item = {
      ...itemBase,
      type: "command_execution" as const,
      title: "Run tests",
      input: "pnpm test",
      output,
    } satisfies OrchestrationV2TurnItem;

    const pages = readAllPages(item, { field: "output" });
    expect(pages).toHaveLength(3);
    const joined = pages.map((page) => page.text).join("");
    expect(joined).toBe(output);
    expect(utf8Bytes(joined)).toEqual(utf8Bytes(output));
    expect(pages[1]?.text.startsWith("😀")).toBe(true);
    expect(pages[2]?.text.startsWith("😀")).toBe(true);
    for (const page of pages) {
      expect(page.text).not.toContain(TRANSPORT_TRUNCATION_MARKER);
      expect(Buffer.byteLength(page.text, "utf8")).toBeLessThanOrEqual(DETAIL_PAGE_MAX_BYTES);
      expect(page).toMatchObject({ field: "output", totalLength: output.length, revision });
      expect(page).not.toHaveProperty("structured");
    }
    const { item: projected } = projectTurnItemForDetail(item, { field: "output" });
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputOmitted: true });

    // Command output opens on its last page and reads backward from there.
    const last = projectTurnItemForDetail(item, { field: "output", anchor: "end" }).page;
    expect(last).toMatchObject({ end: output.length, nextOffset: null });
    expect(last?.text).toBe(output.slice(last?.offset));
    const backward = [last?.text ?? ""];
    let before = last?.offset ?? 0;
    while (before > 0) {
      const page = projectTurnItemForDetail(item, { field: "output", before }).page;
      backward.unshift(page?.text ?? "");
      before = page?.offset ?? 0;
    }
    expect(backward.join("")).toBe(output);

    // A smaller limit pages the same text in more, smaller pages.
    const small = readAllPages(item, { field: "output", limit: 100_000 });
    expect(small.length).toBeGreaterThan(pages.length);
    expect(small.map((page) => page.text).join("")).toBe(output);

    // Each page comes with the item, so a long command is not repeated whole with every page;
    // its own field still pages all of it.
    const longCommand = { ...item, input: `cat <<'EOF'\n${"d".repeat(300_000)}\nEOF` };
    const withPage = projectTurnItemForDetail(longCommand, { field: "output" }).item;
    expect(withPage.type === "command_execution" && withPage.input.length).toBeLessThan(40_000);
    expect(withPage.type === "command_execution" && withPage.input).toContain(
      TRANSPORT_TRUNCATION_MARKER,
    );
    expect(
      readAllPages(longCommand, { field: "input" })
        .map((page) => page.text)
        .join(""),
    ).toBe(longCommand.input);
  });

  it("reads one change's body by index, and the item's own body without one", () => {
    const first = codexUpdatePatch("src/a.ts", 2, 3);
    const second = codexUpdatePatch("src/b.ts", 3_000, 9_000);
    const item = fileChangeItem({
      diffStr: joinPatches([first, second]),
      oldStr: "old",
      newStr: "new",
      changes: [
        { operation: "update", path: "src/a.ts", diffStr: first },
        { operation: "update", path: "src/b.ts", diffStr: second },
      ],
    });
    const detail = projectTurnItemForDetail(item, { field: "body", changeIndex: 1 });
    expect(detail.page).toMatchObject({ field: "body", changeIndex: 1, offset: 0, revision });
    expect(detail.page?.nextOffset).not.toBeNull();
    expect(
      readAllPages(item, { field: "body", changeIndex: 1 })
        .map((page) => page.text)
        .join(""),
    ).toBe(second);
    // The item is the small timeline projection.
    expect(detail.item).not.toHaveProperty("oldStr");
    expect(detail.item).not.toHaveProperty("diffStr");
    expect(detail).not.toHaveProperty("truncated");

    const own = projectTurnItemForDetail(item, { field: "body" }).page;
    expect(own).not.toHaveProperty("changeIndex");
    expect(
      readAllPages(item, { field: "body" })
        .map((page) => page.text)
        .join(""),
    ).toBe(item.diffStr);
    expect(projectTurnItemForDetail(item, { field: "body", changeIndex: 5 })).not.toHaveProperty(
      "page",
    );
    expect(projectTurnItemForDetail(item, { field: "output" })).not.toHaveProperty("page");

    // A failed edit's full error text pages like any body.
    const error = `String to replace not found\n${"x".repeat(300_000)}`;
    const failed = fileChangeItem({ status: "failed", diffStr: error });
    expect(
      readAllPages(failed, { field: "body" })
        .map((page) => page.text)
        .join(""),
    ).toBe(error);
  });

  it("reads a Codex edit's whole body from its change patches at read time", () => {
    const first = codexUpdatePatch("src/a.ts", 2, 3);
    const second = codexUpdatePatch("src/b.ts", 3_000, 9_000);
    const item = fileChangeItem({
      changes: [
        { operation: "update", path: "src/a.ts", diffStr: first },
        { operation: "update", path: "src/b.ts", diffStr: second },
      ],
    });
    expect(item).not.toHaveProperty("diffStr");
    expect(
      readAllPages(item, { field: "body" })
        .map((page) => page.text)
        .join(""),
    ).toBe(joinPatches([first, second]));
  });

  it("pages structured tool input and output over their compact JSON, without image bytes", () => {
    const output = {
      content: [
        { type: "text", text: `report\n${"x".repeat(400_000)}` },
        { type: "image", data: "SECRET_IMAGE_BYTES", mimeType: "image/png" },
      ],
    };
    const item = { ...base, input: { pr: 42 }, output } satisfies OrchestrationV2TurnItem;

    const pages = readAllPages(item, { field: "output" });
    expect(pages.length).toBeGreaterThan(1);
    const joined = pages.map((page) => page.text).join("");
    expect(joined).toBe(JSON.stringify(omitToolOutputImageData(output)));
    expect(joined).not.toContain("SECRET_IMAGE_BYTES");
    expect(JSON.parse(joined)).toMatchObject({
      content: [{ type: "text" }, { type: "image", mimeType: "image/png" }],
    });
    for (const page of pages) expect(page).toMatchObject({ field: "output", structured: true });

    expect(projectTurnItemForDetail(item, { field: "input" }).page).toMatchObject({
      field: "input",
      text: '{"pr":42}',
      structured: true,
      nextOffset: null,
    });
    const stringOutput = projectTurnItemForDetail(
      { ...item, output: "plain text" },
      { field: "output" },
    ).page;
    expect(stringOutput).toMatchObject({ text: "plain text" });
    expect(stringOutput).not.toHaveProperty("structured");
    expect(
      projectTurnItemForDetail({ ...item, output: undefined }, { field: "output" }),
    ).not.toHaveProperty("page");
  });

  it("still bounds a read without a field, with the marker and each cut's bounds", () => {
    const output = "o".repeat(300_000);
    const command = {
      ...itemBase,
      type: "command_execution" as const,
      title: "Build",
      input: "pnpm build",
      output,
    } satisfies OrchestrationV2TurnItem;
    const read = projectTurnItemForDetail(command);
    const firstPage = projectTurnItemForDetail(command, { field: "output" }).page;
    expect(read.item).toMatchObject({
      input: "pnpm build",
      output: `${firstPage?.text}${TRANSPORT_TRUNCATION_MARKER}`,
    });
    expect(read.truncated).toEqual([
      {
        field: "output",
        offset: 0,
        end: firstPage?.end,
        totalLength: output.length,
        nextOffset: firstPage?.end,
        revision,
      },
    ]);
    expect(projectTurnItemForDetail({ ...command, output: "ok" })).toEqual({
      item: { ...command, output: "ok" },
    });

    // Edit bodies come back instead of being stripped, each bounded the same way.
    const large = codexUpdatePatch("src/b.ts", 4_000, 8_000);
    const edit = fileChangeItem({
      diffStr: large,
      oldStr: "before",
      newStr: "after",
      changes: [
        { operation: "update", path: "src/a.ts", diffStr: "@@ -1 +1 @@\n-a\n+b\n" },
        { operation: "update", path: "src/b.ts", diffStr: large },
      ],
    });
    const editRead = projectTurnItemForDetail(edit);
    if (editRead.item.type !== "file_change") throw new Error("Expected an edit");
    expect(editRead.item).toMatchObject({
      oldStr: "before",
      newStr: "after",
      additions: 8_000,
      deletions: 4_000,
      changes: [{ diffStr: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1 }, {}],
    });
    expect(editRead.item.diffStr?.endsWith(TRANSPORT_TRUNCATION_MARKER)).toBe(true);
    expect(editRead.item.changes?.[1]?.diffStr?.endsWith(TRANSPORT_TRUNCATION_MARKER)).toBe(true);
    expect(editRead.truncated).toEqual([
      expect.objectContaining({ field: "body", offset: 0, totalLength: large.length }),
      expect.objectContaining({ field: "body", changeIndex: 1, totalLength: large.length }),
    ]);
    expect(editRead.truncated?.[0]).not.toHaveProperty("changeIndex");

    // A structured value is cut over its compact JSON and says so.
    const tool = {
      ...base,
      output: { content: [{ type: "text", text: "x".repeat(300_000) }] },
    } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForDetail(tool).truncated).toEqual([
      expect.objectContaining({ field: "output", structured: true, offset: 0 }),
    ]);
  });
});
