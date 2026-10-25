import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

import { readableSyntaxColor } from "./syntaxHighlighting";
it("strengthens low contrast Pierre tokens while keeping readable colors", () => {
  expect(readableSyntaxColor("#199f43", "light")).not.toBe("#199f43");
  expect(readableSyntaxColor("#0a0a0a", "light")).toBe("#0a0a0a");
  expect(readableSyntaxColor("#555555", "dark")).not.toBe("#555555");
  expect(readableSyntaxColor("#eeeeee", "dark")).toBe("#eeeeee");
});
