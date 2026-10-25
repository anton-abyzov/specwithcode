import type { DesignDocument } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it } from "vite-plus/test";

import { pageMoves } from "./DesignToolbar";

const threePages = (): DesignDocument => {
  const base = newDesignDocument({
    id: "d_pages",
    kind: "design",
    title: "Pages",
    now: "2026-10-24T12:00:00.000Z",
    createdBy: { kind: "user" },
  });
  return {
    ...base,
    pages: [
      { id: "p_a", name: "A", nodes: [] },
      { id: "p_b", name: "B", nodes: [] },
      { id: "p_c", name: "C", nodes: [] },
    ],
  };
};

const order = (document: DesignDocument) => document.pages.map((page) => page.name).join("");

describe("pageMoves", () => {
  it("offers no Move up on the first page and no Move down on the last", () => {
    const document = threePages();
    expect(pageMoves(document, "p_a").up).toBeNull();
    expect(pageMoves(document, "p_a").down).not.toBeNull();
    expect(pageMoves(document, "p_c").down).toBeNull();
    expect(pageMoves(document, "p_c").up).not.toBeNull();
    expect(pageMoves(document, "p_missing")).toEqual({ up: null, down: null });
  });

  it("moves a page one place with move_page", () => {
    const document = threePages();
    const down = applyDesignOperations(document, [pageMoves(document, "p_a").down!]);
    expect(down.ok && order(down.document)).toBe("BAC");
    const up = applyDesignOperations(document, [pageMoves(document, "p_c").up!]);
    expect(up.ok && order(up.document)).toBe("ACB");
    const middle = applyDesignOperations(document, [pageMoves(document, "p_b").down!]);
    expect(middle.ok && order(middle.document)).toBe("ACB");
  });
});
