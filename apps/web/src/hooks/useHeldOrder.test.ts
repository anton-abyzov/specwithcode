import { describe, expect, it } from "vite-plus/test";

import { holdOrder } from "./useHeldOrder";

describe("holdOrder", () => {
  it("keeps the order taken when the menu opened", () => {
    const now = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(holdOrder(["a", "b", "c"], now, (item) => item.id).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("puts new rows at the end and drops rows that left", () => {
    const now = [{ id: "d" }, { id: "c" }, { id: "a" }];
    expect(holdOrder(["a", "b", "c"], now, (item) => item.id).map((item) => item.id)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });
});
