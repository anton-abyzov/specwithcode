import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  DETAIL_PAGE_MAX_BYTES,
  MAX_TOOL_OUTPUT_IMAGES,
  omitToolOutputImageData,
  sliceTextPage,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by Studio summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });

  it("is idempotent for compact metadata", () => {
    const compact = compactDynamicToolOutput({
      isError: true,
      structuredContent: {
        threadId: "thread-1",
        threads: [{ threadId: "thread-1" }, { status: "rolled_back" }],
        output: "Private output",
      },
    });
    expect(compactDynamicToolOutput(compact)).toEqual(compact);
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("drops the bytes but keeps each image's position", () => {
    const omitted = omitToolOutputImageData({ content: [text, claudeImage, mcpImage] });
    expect(omitted).toEqual({
      content: [
        text,
        { type: "image", mimeType: "image/jpeg" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(toolOutputImages(omitted)).toEqual([
      { mimeType: "image/jpeg" },
      { mimeType: "image/png" },
    ]);
  });
});

describe("sliceTextPage", () => {
  const encoder = new TextEncoder();
  const utf8Bytes = (text: string) => encoder.encode(text).byteLength;
  const forwardPages = (text: string, maxBytes?: number) => {
    const pages = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = sliceTextPage(text, { offset, maxBytes });
      pages.push(page);
      offset = page.nextOffset;
    }
    return pages;
  };
  const backwardPages = (text: string, maxBytes?: number) => {
    const pages = [sliceTextPage(text, { anchor: "end", maxBytes })];
    while (pages[0]!.offset > 0) {
      pages.unshift(sliceTextPage(text, { before: pages[0]!.offset, maxBytes }));
    }
    return pages;
  };

  it("returns small text whole as one page", () => {
    expect(sliceTextPage("hello")).toEqual({
      text: "hello",
      offset: 0,
      end: 5,
      totalLength: 5,
      nextOffset: null,
    });
    expect(sliceTextPage("", { anchor: "end" })).toEqual({
      text: "",
      offset: 0,
      end: 0,
      totalLength: 0,
      nextOffset: null,
    });
  });

  it("joins every page back to the exact text, emoji and multibyte characters on boundaries", () => {
    // 4-byte emoji (surrogate pairs), 3-byte CJK and 2-byte accents, so most
    // budgets land inside a character.
    const unit = "a😀é中🧑‍💻\n";
    const text = unit.repeat(5_000);
    for (const maxBytes of [4, 5, 7, 13, 64, 1000]) {
      for (const pages of [forwardPages(text, maxBytes), backwardPages(text, maxBytes)]) {
        const joined = pages.map((page) => page.text).join("");
        expect(joined === text).toBe(true);
        expect(encoder.encode(joined)).toEqual(encoder.encode(text));
        for (const page of pages) {
          expect(utf8Bytes(page.text)).toBeLessThanOrEqual(maxBytes);
          expect(page.text.length).toBeGreaterThan(0);
          expect(page.text).toBe(text.slice(page.offset, page.end));
          // No page starts on the second half of a surrogate pair.
          expect(/^[\uDC00-\uDFFF]/.test(page.text)).toBe(false);
          expect(/[\uD800-\uDBFF]$/.test(page.text)).toBe(false);
        }
      }
    }
  });

  it("pages a large text within the 256 KiB default budget", () => {
    const text = "x".repeat(DETAIL_PAGE_MAX_BYTES * 2 + 17);
    const first = sliceTextPage(text);
    expect(first).toMatchObject({ offset: 0, end: DETAIL_PAGE_MAX_BYTES });
    expect(first.nextOffset).toBe(DETAIL_PAGE_MAX_BYTES);
    const last = sliceTextPage(text, { anchor: "end" });
    expect(last).toMatchObject({ end: text.length, nextOffset: null });
    expect(last.offset).toBe(text.length - DETAIL_PAGE_MAX_BYTES);
    // A larger budget than one page is capped.
    expect(sliceTextPage(text, { maxBytes: 10 * DETAIL_PAGE_MAX_BYTES }).end).toBe(
      DETAIL_PAGE_MAX_BYTES,
    );
  });

  it("moves an offset that splits a surrogate pair to the start of the pair", () => {
    const text = "ab😀cd";
    expect(sliceTextPage(text, { offset: 3, maxBytes: 4 })).toMatchObject({
      offset: 2,
      text: "😀",
    });
    expect(sliceTextPage(text, { before: 3, maxBytes: 4 })).toMatchObject({ end: 2, text: "ab" });
  });

  it("lets before win over offset and clamps offsets outside the text", () => {
    expect(sliceTextPage("abcdef", { offset: 1, before: 3 })).toMatchObject({
      offset: 0,
      end: 3,
    });
    expect(sliceTextPage("abc", { offset: 99 })).toMatchObject({
      offset: 3,
      end: 3,
      text: "",
      nextOffset: null,
    });
  });

  it("counts a lone surrogate as the three bytes it encodes to", () => {
    const text = "\uD800".repeat(10);
    const page = sliceTextPage(text, { maxBytes: 9 });
    expect(page.end).toBe(3);
    expect(
      forwardPages(text, 9)
        .map((entry) => entry.text)
        .join(""),
    ).toBe(text);
  });
});
