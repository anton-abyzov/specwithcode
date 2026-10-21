import { describe, expect, it } from "vite-plus/test";

import { incrementListInput, statusChips } from "./LinkIncrementDialog";

describe("LinkIncrementDialog list input", () => {
  it("asks the server for one page per opened page, never past its cap", () => {
    expect(incrementListInput("  ", null, 1)).toEqual({ limit: 50 });
    expect(incrementListInput(" billing ", "active", 3)).toEqual({
      query: "billing",
      status: "active",
      limit: 150,
    });
    expect(incrementListInput("", null, 40)).toEqual({ limit: 300 });
  });

  it("orders status chips busiest first", () => {
    expect(statusChips({ active: 3, completed: 2900, unknown: 3 })).toEqual([
      ["completed", 2900],
      ["active", 3],
      ["unknown", 3],
    ]);
    expect(statusChips(undefined)).toEqual([]);
  });
});
