import { describe, expect, it } from "vite-plus/test";

import {
  compareIncrementFolders,
  compareIncrementFoldersNewestFirst,
  incrementNumber,
} from "./specweaveIncrement.ts";

describe("specweaveIncrement", () => {
  it("reads the leading number of a folder", () => {
    expect(incrementNumber("0973-budget")).toBe(973);
    expect(incrementNumber("10001-export")).toBe(10001);
    expect(incrementNumber("0123A-hotfix")).toBe(123);
    expect(incrementNumber("_archive")).toBeNull();
  });

  it("sorts by number past 9999, then by name", () => {
    const folders = ["10000-ten-thousand", "9999-last-four", "0001-first", "0973-b", "0973-a"];
    expect(folders.toSorted(compareIncrementFolders)).toEqual([
      "0001-first",
      "0973-a",
      "0973-b",
      "9999-last-four",
      "10000-ten-thousand",
    ]);
    expect(folders.toSorted(compareIncrementFoldersNewestFirst)).toEqual([
      "10000-ten-thousand",
      "9999-last-four",
      "0973-b",
      "0973-a",
      "0001-first",
    ]);
  });
});
