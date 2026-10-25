// @vitest-environment jsdom
import type { DesignDocument } from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DesignSession, type DesignTransport } from "../editor/designSession";
import { CameraStore } from "./camera";
import { DesignCanvas } from "./DesignCanvas";
import type { CanvasTool } from "./tools";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.setPointerCapture ??= () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** A slide-sized frame holding a title text and a shape. */
function slideDocument(): DesignDocument {
  const doc = newDesignDocument({
    id: "d_canvas",
    kind: "slides",
    title: "Deck",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.42,
  });
  const page = doc.pages[0]!;
  const slide = page.nodes[0]!;
  const outcome = applyDesignOperations(doc, [
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_title",
        parentId: slide.id,
        type: "text",
        x: 128,
        y: 340,
        width: 1120,
        height: 280,
        text: "Matchday",
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_shape",
        parentId: slide.id,
        type: "ellipse",
        x: 1400,
        y: 300,
        width: 400,
        height: 400,
      },
    },
  ]);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  return outcome.document;
}

const transport: DesignTransport = {
  apply: async () => ({ ok: false, reason: "error", detail: "offline" }),
  get: async () => {
    throw new Error("offline");
  },
};

function mount(initialSelection: readonly string[] = [], initialTool: CanvasTool = "select") {
  const session = new DesignSession(slideDocument(), transport, 60_000);
  const camera = new CameraStore();
  const tools: CanvasTool[] = [];
  const selections: (readonly string[])[] = [];
  function Harness() {
    const [tool, setTool] = useState<CanvasTool>(initialTool);
    const [selection, setSelection] = useState<readonly string[]>(initialSelection);
    const page = session.document.pages[0]!;
    return (
      <div data-testid="design-editor">
        <button type="button" data-testid="toolbar-button">
          Rectangle
        </button>
        <input aria-label="Layer name" data-testid="panel-input" />
        <p data-testid="bare-panel">Fill</p>
        <div data-testid="design-thread">
          <p data-testid="transcript">Done. I added the hero.</p>
        </div>
        <DesignCanvas
          session={session}
          page={page}
          comments={[]}
          camera={camera}
          tool={tool}
          onToolChange={(next) => {
            tools.push(next);
            setTool(next);
          }}
          selection={selection}
          onSelectionChange={(ids) => {
            selections.push(ids);
            setSelection(ids);
          }}
          readOnly={false}
          canComment
          activeCommentId={null}
          onOpenComment={() => {}}
          onPlaceComment={() => {}}
          onPickImage={() => {}}
          onDropFiles={() => {}}
          onExportFrame={() => {}}
          onError={vi.fn()}
        />
      </div>
    );
  }
  act(() => root.render(<Harness />));
  const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { session, tools, selections, get };
}

function press(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("DesignCanvas shortcuts", () => {
  it("keep working after a toolbar click, from the focused button", () => {
    const { tools, get } = mount();
    const button = get("toolbar-button");
    button.focus();
    expect(press(button, "r").defaultPrevented).toBe(true);
    expect(tools).toEqual(["rect"]);
    // The button keeps Enter for itself.
    expect(press(button, "Enter").defaultPrevented).toBe(false);
  });

  it("keep working with focus on the page body, as after a click on a bare panel", () => {
    const { session, get } = mount(["n_shape"]);
    pointer(get("bare-panel"), "pointerdown");
    get("panel-input").blur();
    expect(press(document.body, "Delete").defaultPrevented).toBe(true);
    expect(session.document.pages[0]!.nodes.some((node) => node.id === "n_shape")).toBe(false);
  });

  it("never fire from the page body after a click on thread or app text", () => {
    const { session, get } = mount(["n_shape"]);
    const shell = document.createElement("p");
    shell.textContent = "Projects";
    document.body.append(shell);
    for (const target of [get("transcript"), shell]) {
      pointer(target, "pointerdown");
      for (const key of ["Delete", "Backspace", "a", "ArrowLeft"])
        expect(press(document.body, key).defaultPrevented).toBe(false);
    }
    const nodes = session.document.pages[0]!.nodes;
    expect(nodes.find((node) => node.id === "n_shape")).toMatchObject({ x: 1400, y: 300 });
  });

  it("still run on the canvas itself", () => {
    const { tools, get } = mount();
    expect(press(get("design-canvas"), "t").defaultPrevented).toBe(true);
    expect(tools).toEqual(["text"]);
  });

  it("never fire while typing in a field", () => {
    const { session, tools, get } = mount(["n_shape"]);
    const field = get("panel-input");
    field.focus();
    for (const key of ["r", "Delete", "Backspace", "v"]) press(field, key);
    expect(tools).toEqual([]);
    expect(session.document.pages[0]!.nodes.some((node) => node.id === "n_shape")).toBe(true);
  });

  it("never fire while a menu or dialog is open", () => {
    const { tools, get } = mount();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML = `<div role="menuitem" tabindex="-1">Duplicate</div>`;
    document.body.append(menu);
    press(menu.firstElementChild!, "r");
    press(document.body, "r");
    expect(tools).toEqual([]);
    menu.remove();
    get("toolbar-button").focus();
    press(get("toolbar-button"), "r");
    expect(tools).toEqual(["rect"]);
  });
});

function pointer(target: Element, type: string, x = 0, y = 0, detail = 0) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
        detail,
      }),
    );
  });
}

/** Chromium's double-click: pointerdown carries no click count, and pointer capture
 * retargets pointerup, click and dblclick to the canvas. */
function doubleClick(target: Element, canvas: Element, x = 0, y = 0) {
  for (const detail of [1, 2]) {
    pointer(target, "pointerdown", x, y);
    pointer(canvas, "pointerup", x, y);
    pointer(canvas, "click", x, y, detail);
  }
  pointer(canvas, "dblclick", x, y, 2);
}

const nodeElement = (id: string) => document.querySelector<HTMLElement>(`[data-node="${id}"]`)!;

describe("DesignCanvas double-click", () => {
  it("edits a text layer inside a slide in place", () => {
    const { selections, get } = mount();
    doubleClick(nodeElement("n_title"), get("design-canvas"));
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]');
    expect(field).not.toBeNull();
    expect(field!.value).toBe("Matchday");
    expect(document.activeElement).toBe(field);
    expect(nodeElement("n_title").style.visibility).toBe("hidden");
    expect(selections.at(-1)).toEqual(["n_title"]);
  });

  it("edits the text even while its slide is selected", () => {
    const { session, get } = mount([slideId()]);
    doubleClick(nodeElement("n_title"), get("design-canvas"));
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]')!;
    expect(field).not.toBeNull();
    field.value = "Matchday is live";
    act(() => field.blur());
    const title = session.document.pages[0]!.nodes.find((node) => node.id === "n_title");
    expect(title?.type === "text" && title.text).toBe("Matchday is live");
  });

  it("does not edit shapes or the slide itself", () => {
    const { get } = mount();
    doubleClick(nodeElement("n_shape"), get("design-canvas"));
    doubleClick(nodeElement(slideId()), get("design-canvas"));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("finishes a pen path without the double-click's repeated point", () => {
    const { session, get } = mount([], "pen");
    const canvas = get("design-canvas");
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointerdown", 200, 100);
    doubleClick(canvas, canvas, 300, 160);
    const path = session.document.pages[0]!.nodes.find((node) => node.type === "path");
    expect(path?.type === "path" && path.points.length).toBe(3);
  });

  it("finishes a pen path without a stray segment when the double-click jitters", () => {
    const { session, get } = mount([], "pen");
    const canvas = get("design-canvas");
    pointer(canvas, "pointerdown", 100, 100);
    pointer(canvas, "pointerdown", 200, 100);
    // The second press lands 6 px from the first, past any repeat tolerance.
    pointer(canvas, "pointerdown", 300, 160);
    pointer(canvas, "pointerup", 300, 160);
    pointer(canvas, "click", 300, 160, 1);
    pointer(canvas, "pointerdown", 306, 160);
    pointer(canvas, "pointerup", 306, 160);
    pointer(canvas, "click", 306, 160, 2);
    pointer(canvas, "dblclick", 306, 160, 2);
    const path = session.document.pages[0]!.nodes.find((node) => node.type === "path");
    expect(path?.type === "path" && path.points.length).toBe(3);
  });
});

function slideId() {
  return slideDocument().pages[0]!.nodes[0]!.id;
}
