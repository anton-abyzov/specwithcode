import { describe, expect, it } from "@effect/vitest";

import { fileChangePatchText } from "./fileChangePatches.ts";

const base = {
  type: "file_change",
  fileName: "a.ts",
} as unknown as Parameters<typeof fileChangePatchText>[0];

describe("fileChangePatchText", () => {
  it("keeps an item's own patch", () => {
    expect(
      fileChangePatchText({
        ...base,
        diffStr: "own",
        changes: [{ operation: "modify", path: "a.ts", diffStr: "x" }],
      }),
    ).toBe("own");
  });

  it("joins change patches with a newline only where one is missing", () => {
    expect(
      fileChangePatchText({
        ...base,
        changes: [
          { operation: "modify", path: "a.ts", diffStr: "--- a\n+++ a\n" },
          { operation: "add", path: "b.ts" },
          { operation: "modify", path: "c.ts", diffStr: "--- c\n+++ c" },
          { operation: "delete", path: "d.ts", diffStr: "--- d" },
        ],
      }),
    ).toBe("--- a\n+++ a\n--- c\n+++ c\n--- d");
  });

  it("has no text when no change carries a patch", () => {
    expect(fileChangePatchText(base)).toBeUndefined();
    expect(
      fileChangePatchText({ ...base, changes: [{ operation: "add", path: "a.ts" }] }),
    ).toBeUndefined();
  });
});
