import type {
  DesignDocument,
  DesignNode,
  DesignOperation,
  DesignSystem,
} from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it } from "vite-plus/test";
import {
  containingArtboard,
  implementFrameMessage,
  matchingComponents,
  selectionCrop,
  usedTokens,
} from "./handoff";

const system = {
  modes: [],
  tokens: [],
  components: [
    { id: "button-primary", name: "Button", importPath: "~/ui/button", exportName: "Button" },
    { id: "card", name: "Card" },
    { id: "badge", name: "Badge" },
  ],
} as unknown as DesignSystem;

function seeded() {
  let seed = 7;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function booking(): DesignDocument {
  const document = newDesignDocument({
    id: "d_test",
    kind: "design",
    title: "Marina booking",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: seeded(),
  });
  const pageId = document.pages[0]!.id;
  const frame: DesignNode = {
    id: "f_booking",
    parentId: null,
    type: "frame",
    name: "Booking",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    fill: { token: "surface" },
  };
  const operations: DesignOperation[] = [
    { op: "add_node", pageId, node: frame },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_card",
        parentId: "f_booking",
        type: "frame",
        name: "card",
        x: 20,
        y: 20,
        width: 200,
        height: 100,
        fill: { token: "surface-muted" },
        stroke: { token: "line" },
      },
    },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_cta",
        parentId: "n_card",
        type: "component",
        componentId: "button-primary",
        x: 8,
        y: 8,
        width: 120,
        height: 40,
      },
    },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_loose",
        parentId: null,
        type: "rect",
        name: "Badge",
        x: 900,
        y: 0,
        width: 40,
        height: 40,
        fill: "#ff0000",
      },
    },
  ];
  const outcome = applyDesignOperations(document, operations);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

describe("handoff", () => {
  it("collects token references once, ignoring literal values", () => {
    const nodes = booking().pages[0]!.nodes;
    expect(usedTokens(nodes).toSorted()).toEqual(["line", "surface", "surface-muted"]);
  });

  it("matches components by instance and by layer name, case-insensitively", () => {
    const nodes = booking().pages[0]!.nodes.filter((node) => node.id !== "n_loose");
    expect(matchingComponents(nodes, system).map((component) => component.id)).toEqual([
      "button-primary",
      "card",
    ]);
    expect(matchingComponents(nodes, null)).toEqual([]);
  });

  it("finds the artboard that contains a nested layer", () => {
    const page = booking().pages[0]!;
    expect(containingArtboard(page, "n_cta")?.id).toBe("f_booking");
    expect(containingArtboard(page, "n_loose")).toBeNull();
  });

  it("builds the implement message from the frame subtree only", () => {
    const document = booking();
    const page = document.pages[0]!;
    const frame = page.nodes.find((node) => node.id === "f_booking")!;
    const message = implementFrameMessage({
      document,
      page,
      frame,
      system,
      mode: "light",
      designKey: "pg.d_test",
    });
    expect(message.title).toBe("Implement Booking");
    expect(message.text).toContain(
      'Implement the frame "Booking" from the design "Marina booking" (pg.d_test',
    );
    expect(message.text).toContain("## Tokens used (3)");
    expect(message.text).toContain("- Button from `~/ui/button` (export `Button`)");
    expect(message.text).not.toContain("Badge");
    const json = message.text.split("```json\n")[1]!.split("\n```")[0]!;
    const parsed = JSON.parse(json) as { frame: { id: string }; nodes: { id: string }[] };
    expect(parsed.frame.id).toBe("f_booking");
    expect(parsed.nodes.map((node) => node.id)).toEqual(["f_booking", "n_card", "n_cta"]);
  });

  it("crops Ask agent's PNG to the selection, inside a frame or on the page", () => {
    const page = booking().pages[0]!;
    expect(selectionCrop(page, ["n_cta"])).toEqual({
      frameId: "f_booking",
      rect: { x: 20, y: 20, width: 136, height: 56 },
    });
    // Outside any frame: the page export, whose origin is the page bounds.
    expect(selectionCrop(page, ["n_loose"])).toEqual({
      rect: { x: 892, y: 0, width: 56, height: 48 },
    });
    expect(selectionCrop(page, ["n_cta", "n_loose"])?.frameId).toBeUndefined();
    expect(selectionCrop(page, ["missing"])).toBeNull();
  });
});
