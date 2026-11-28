import { describe, expect, it } from "vite-plus/test";

import { followSearchHighlight } from "./sidebarSearchHighlight";

describe("followSearchHighlight", () => {
  it("stays on the same thread when results reorder", () => {
    expect(followSearchHighlight(["a", "b", "c", "d"], ["d", "a", "b", "c"], 2)).toBe(3);
  });

  it("keeps the row when the highlighted thread leaves, and never passes the end", () => {
    expect(followSearchHighlight(["a", "b", "c"], ["a", "c"], 1)).toBe(1);
    expect(followSearchHighlight(["a", "b", "c"], ["a"], 2)).toBe(0);
    expect(followSearchHighlight(["a"], [], 0)).toBe(0);
  });
});
