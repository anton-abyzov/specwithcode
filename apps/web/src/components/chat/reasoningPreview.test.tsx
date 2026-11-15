import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const parsed = vi.hoisted(() => ({ lengths: [] as number[] }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Markdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof Markdown>) => {
      parsed.lengths.push(typeof props.children === "string" ? props.children.length : 0);
      return createElement(Markdown, props);
    },
  };
});

import {
  REASONING_PREVIEW_SOURCE_MAX_LENGTH,
  ReasoningPreviewMarkdown,
  reasoningPreviewSource,
} from "./reasoningPreview";

function longReasoning(length: number): string {
  const paragraph =
    "I should check the **session** store first, then read `apps/server/src/index.ts` and compare.";
  const parts: string[] = [];
  let size = 0;
  for (let index = 0; size < length; index += 1) {
    const next = `Step ${index}. ${paragraph}`;
    parts.push(next);
    size += next.length + 2;
  }
  return parts.join("\n\n").slice(0, length);
}

describe("collapsed reasoning preview", () => {
  beforeEach(() => {
    parsed.lengths = [];
  });

  it("hands the parser a bounded prefix of a 200,000-character block", () => {
    const text = longReasoning(200_000);
    expect(text).toHaveLength(200_000);
    const html = renderToStaticMarkup(
      createElement(ReasoningPreviewMarkdown, { text, fallback: "Thought" }),
    );
    expect(parsed.lengths).toHaveLength(1);
    expect(parsed.lengths[0]).toBeGreaterThan(0);
    expect(parsed.lengths[0]).toBeLessThanOrEqual(REASONING_PREVIEW_SOURCE_MAX_LENGTH);
    expect(html.startsWith("Step 0. I should check the session store first")).toBe(true);
  });

  it("renders a short block whole and falls back when it has no text", () => {
    const html = renderToStaticMarkup(
      createElement(ReasoningPreviewMarkdown, {
        text: "Plan:\n\n- read the **spec**\n- run `tests`",
        fallback: "Thought",
      }),
    );
    expect(html).toBe("Plan: read the spec run tests");
    expect(parsed.lengths).toEqual([40]);
    expect(
      renderToStaticMarkup(
        createElement(ReasoningPreviewMarkdown, { text: "<br>", fallback: "Thought" }),
      ),
    ).toBe("Thought");
  });

  it("cuts at a paragraph break, else at whitespace, never inside a surrogate pair", () => {
    const paragraphs = `${"a".repeat(7_000)}\n\n${"b".repeat(5_000)}`;
    expect(reasoningPreviewSource(paragraphs)).toBe("a".repeat(7_000));

    const words = "word ".repeat(4_000);
    const cut = reasoningPreviewSource(words);
    expect(cut.length).toBeLessThanOrEqual(REASONING_PREVIEW_SOURCE_MAX_LENGTH);
    expect(cut.endsWith("word")).toBe(true);

    const emoji = "\u{1F600}".repeat(6_000);
    const emojiCut = reasoningPreviewSource(emoji);
    expect(emojiCut.length % 2).toBe(0);
    expect(emojiCut.length).toBeLessThanOrEqual(REASONING_PREVIEW_SOURCE_MAX_LENGTH);

    expect(reasoningPreviewSource("short")).toBe("short");
  });
});
