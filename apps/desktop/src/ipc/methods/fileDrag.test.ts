import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ webContents: { fromId: () => undefined }, nativeImage: {} }));

import { isDraggableFilePath } from "./fileDrag.ts";

describe("isDraggableFilePath", () => {
  const file = () => ({ isFile: () => true });
  const folder = () => ({ isFile: () => false });

  it("accepts an absolute path to a regular file", () => {
    expect(isDraggableFilePath("/Users/me/Downloads/icon-128.png", file)).toBe(true);
  });

  it("refuses relative paths, folders, missing files and NUL bytes", () => {
    expect(isDraggableFilePath("icon-128.png", file)).toBe(false);
    expect(isDraggableFilePath("/Users/me/Downloads", folder)).toBe(false);
    expect(isDraggableFilePath("/Users/me/missing.png", () => undefined)).toBe(false);
    expect(isDraggableFilePath("/Users/me/a\0.png", file)).toBe(false);
  });

  it("refuses a path it cannot read", () => {
    expect(
      isDraggableFilePath("/private/secret", () => {
        throw new Error("EACCES");
      }),
    ).toBe(false);
  });
});
