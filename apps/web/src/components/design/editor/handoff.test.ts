import type {
  DesignDocument,
  DesignNode,
  DesignOperation,
  DesignSystem,
  DesignThreadBinding,
  EnvironmentId,
  ThreadId,
} from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { describe, expect, it } from "vite-plus/test";
import type { DesignImage, DesignMessage } from "./backend";
import {
  containingArtboard,
  implementFrameMessage,
  matchingComponents,
  selectionCrop,
  sendFrameHandoff,
  usedTokens,
  type FrameHandoffDeps,
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

  it("says why no PNG is attached when the frame could not be rendered", () => {
    const document = booking();
    const page = document.pages[0]!;
    const frame = page.nodes.find((node) => node.id === "f_booking")!;
    const input = { document, page, frame, system, mode: "light", designKey: "pg.d_test" };
    const without = implementFrameMessage({ ...input, pngProblem: "Chrome did not start." });
    expect(without.text).toContain(
      "No PNG is attached: the frame could not be rendered (Chrome did not start). Build it from the frame JSON below",
    );
    expect(without.text).not.toContain("The attached PNG is the frame as rendered");
    expect(implementFrameMessage({ ...input, pngProblem: null }).text).toBe(
      implementFrameMessage(input).text,
    );
    expect(implementFrameMessage(input).text).toContain(
      "The attached PNG is the frame as rendered",
    );
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

describe("sendFrameHandoff", () => {
  const environmentId = "env-a" as EnvironmentId;
  const existing = { environmentId, threadId: "t-existing" as ThreadId };
  const png: DesignImage = {
    name: "Booking.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    sizeBytes: 8,
  };

  /** Deps that record every call; the saved document is revision 7 of the booking design. */
  function deps(
    options: {
      settled?: boolean;
      saveState?: string;
      render?: () => Promise<DesignImage[]>;
      waiting?: boolean;
    } = {},
  ) {
    const saved = { ...booking(), revision: 7 };
    const calls = {
      settle: 0,
      render: [] as string[],
      started: [] as { message: DesignMessage; title: string }[],
      sent: [] as { thread: DesignThreadBinding; message: DesignMessage }[],
    };
    const handoff: FrameHandoffDeps = {
      settle: async () => {
        calls.settle += 1;
        return options.settled ?? true;
      },
      saved: () => ({ document: saved, saveState: options.saveState ?? "saved" }),
      render: async (frame) => {
        calls.render.push(frame.id);
        return options.render === undefined ? [png] : options.render();
      },
      startCodingThread: async (message, title) => {
        calls.started.push({ message, title });
        return {
          environmentId,
          threadId: "t-new" as ThreadId,
          ...(options.waiting === undefined ? {} : { waiting: options.waiting }),
        };
      },
      sendToThread: async (thread, message) => {
        calls.sent.push({ thread, message });
      },
    };
    return { handoff, calls };
  }
  const input = (target: Parameters<typeof sendFrameHandoff>[1]["target"]) => ({
    pageId: booking().pages[0]!.id,
    frameId: "f_booking",
    system,
    mode: "light",
    designKey: "pg.d_test",
    target,
  });

  it("refuses while an edit is unsaved and sends nothing", async () => {
    for (const options of [{ settled: false }, { saveState: "error" }]) {
      const { handoff, calls } = deps(options);
      await expect(sendFrameHandoff(handoff, input({ kind: "new" }))).rejects.toThrow(
        "Your changes are not saved yet, so the frame was not sent.",
      );
      expect(calls.settle).toBe(1);
      expect(calls.render).toEqual([]);
      expect(calls.started).toEqual([]);
      expect(calls.sent).toEqual([]);
    }
  });

  it("starts a new thread from the saved revision with the frame's PNG", async () => {
    const { handoff, calls } = deps({ waiting: false });
    const sent = await sendFrameHandoff(handoff, input({ kind: "new" }));
    expect(sent).toEqual({
      thread: { environmentId, threadId: "t-new" },
      frameName: "Booking",
      waiting: false,
      pngProblem: null,
    });
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0]!.title).toBe("Implement Booking");
    expect(calls.started[0]!.message.images).toEqual([png]);
    expect(calls.started[0]!.message.text).toContain("(pg.d_test, page");
    expect(calls.started[0]!.message.text).toContain("revision 7)");
    expect(calls.sent).toEqual([]);
  });

  it("reports a new thread that waits for a provider", async () => {
    const { handoff, calls } = deps({ waiting: true });
    const sent = await sendFrameHandoff(handoff, input({ kind: "new" }));
    expect(sent.waiting).toBe(true);
    expect(sent.thread).toEqual({ environmentId, threadId: "t-new" });
    expect(calls.started).toHaveLength(1);
  });

  it("sends without a PNG, saying why, when the frame cannot be rendered", async () => {
    const { handoff, calls } = deps({
      render: async () => {
        throw new Error("Headless Chrome could not start.");
      },
    });
    const sent = await sendFrameHandoff(handoff, input({ kind: "existing", binding: existing }));
    expect(sent).toEqual({
      thread: existing,
      frameName: "Booking",
      waiting: false,
      pngProblem: "Headless Chrome could not start",
    });
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]!.message.images).toEqual([]);
    expect(calls.sent[0]!.message.text).toContain(
      "No PNG is attached: the frame could not be rendered (Headless Chrome could not start).",
    );
    expect(calls.started).toEqual([]);
  });

  it("refuses a new thread without a project before saving anything", async () => {
    const { handoff, calls } = deps();
    await expect(
      sendFrameHandoff({ ...handoff, startCodingThread: null }, input({ kind: "new" })),
    ).rejects.toThrow("This design has no project to start a coding thread in.");
    expect(calls.settle).toBe(0);
  });
});
