// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { DesignNode } from "@specweave-studio/contracts";
import {
  shouldCanvasHandleKey,
  textNodeAt,
  trackCanvasPresses,
  withoutDoubleClickPoint,
} from "./canvasInput";

let release: () => void;

beforeEach(() => {
  release = trackCanvasPresses(document);
});

afterEach(() => {
  release();
  document.body.innerHTML = "";
});

/** A pointer press, as the document's capture listener sees it. */
function pressOn(target: Element) {
  target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
}

function editor() {
  document.body.innerHTML = `
    <div data-testid="design-editor">
      <div data-testid="design-thread">
        <p data-testid="transcript">Done. I added the hero.</p>
        <button data-testid="thread-button">Send</button>
      </div>
      <aside data-testid="panel"><span data-testid="panel-text">Fill</span></aside>
      <div role="toolbar"><button data-testid="tool">Rectangle</button></div>
      <input data-testid="input" />
      <textarea data-testid="textarea"></textarea>
      <div contenteditable="true"><span data-testid="rich">x</span></div>
      <div contenteditable="false"><button data-testid="not-editable">x</button></div>
      <div role="combobox" tabindex="0" data-testid="combobox"></div>
      <div role="radiogroup"><button role="radio" data-testid="radio">Left</button></div>
      <div role="menu"><div role="menuitem" tabindex="-1" data-testid="menuitem">Duplicate</div></div>
      <div data-testid="canvas" tabindex="0"><button data-testid="label">Slide 1</button></div>
    </div>
    <button data-testid="outside">Sidebar</button>
    <p data-testid="shell-text">Projects</p>`;
  const get = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;
  return { scope: get("design-editor"), canvas: get("canvas"), get };
}

const key = (target: EventTarget | null, value: string, defaultPrevented = false) => ({
  target,
  key: value,
  defaultPrevented,
});

describe("shouldCanvasHandleKey", () => {
  it("takes every key pressed on the canvas itself", () => {
    const { scope, canvas } = editor();
    for (const value of ["v", "Enter", " ", "Tab", "Delete", "ArrowLeft"])
      expect(shouldCanvasHandleKey(key(canvas, value), canvas, scope)).toBe(true);
  });

  it("keeps shortcuts working after a toolbar or panel click", () => {
    const { scope, canvas, get } = editor();
    for (const value of ["r", "Delete", "Backspace", "ArrowLeft", "Escape", "z"])
      expect(shouldCanvasHandleKey(key(get("tool"), value), canvas, scope)).toBe(true);
    // A button inside the canvas (a frame label) and the page body after a click on a bare
    // panel; the fixture's menu is closed first.
    expect(shouldCanvasHandleKey(key(get("label"), "v"), canvas, scope)).toBe(true);
    get("menuitem").parentElement!.remove();
    pressOn(get("panel-text"));
    expect(shouldCanvasHandleKey(key(document.body, "v"), canvas, scope)).toBe(true);
    expect(shouldCanvasHandleKey(key(document.body, "Enter"), canvas, scope)).toBe(true);
  });

  it("leaves Enter, Space and Tab to a focused control", () => {
    const { scope, canvas, get } = editor();
    for (const value of ["Enter", " ", "Tab"])
      expect(shouldCanvasHandleKey(key(get("tool"), value), canvas, scope)).toBe(false);
  });

  it("never fires from text fields, contenteditable or a combobox", () => {
    const { scope, canvas, get } = editor();
    for (const id of ["input", "textarea", "rich", "combobox"])
      for (const value of ["v", "Delete", "Backspace", "ArrowLeft", "a"])
        expect(shouldCanvasHandleKey(key(get(id), value), canvas, scope)).toBe(false);
    // contenteditable="false" is not a typing field.
    expect(shouldCanvasHandleKey(key(get("not-editable"), "v"), canvas, scope)).toBe(true);
  });

  it("takes undo and redo from a closed picker's trigger, right after a pick", () => {
    const { scope, canvas, get } = editor();
    const picker = get("combobox");
    for (const value of ["z", "Z", "y"])
      expect(shouldCanvasHandleKey({ ...key(picker, value), metaKey: true }, canvas, scope)).toBe(
        true,
      );
    expect(shouldCanvasHandleKey({ ...key(picker, "z"), ctrlKey: true }, canvas, scope)).toBe(true);
    expect(
      shouldCanvasHandleKey({ ...key(picker, "z"), metaKey: true, altKey: true }, canvas, scope),
    ).toBe(false);
    expect(shouldCanvasHandleKey({ ...key(picker, "d"), metaKey: true }, canvas, scope)).toBe(
      false,
    );
    picker.setAttribute("aria-expanded", "true");
    expect(shouldCanvasHandleKey({ ...key(picker, "z"), metaKey: true }, canvas, scope)).toBe(
      false,
    );
  });

  it("never fires from an open menu, a dialog or the thread pane", () => {
    const { scope, canvas, get } = editor();
    expect(shouldCanvasHandleKey(key(get("menuitem"), "Delete"), canvas, scope)).toBe(false);
    expect(shouldCanvasHandleKey(key(get("thread-button"), "Delete"), canvas, scope)).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<button>Close</button>`;
    scope.append(dialog);
    expect(shouldCanvasHandleKey(key(dialog.firstElementChild, "v"), canvas, scope)).toBe(false);
  });

  it("takes body keys after a press in the editor, even on a control that went away", () => {
    const { scope, canvas, get } = editor();
    get("menuitem").parentElement!.remove();
    pressOn(get("tool"));
    get("tool").remove();
    for (const value of ["Delete", "Backspace", "a", "ArrowLeft"])
      expect(shouldCanvasHandleKey(key(document.body, value), canvas, scope)).toBe(true);
  });

  it("ignores body keys after a press on thread text, the app shell or nothing yet", () => {
    const { scope, canvas, get } = editor();
    get("menuitem").parentElement!.remove();
    expect(shouldCanvasHandleKey(key(document.body, "Delete"), canvas, scope)).toBe(false);
    for (const id of ["transcript", "shell-text", "outside"]) {
      pressOn(get(id));
      for (const value of ["Delete", "Backspace", "a", "ArrowLeft"]) {
        expect(shouldCanvasHandleKey(key(document.body, value), canvas, scope)).toBe(false);
        expect(shouldCanvasHandleKey(key(document.documentElement, value), canvas, scope)).toBe(
          false,
        );
      }
    }
    // A press back in the editor brings them back.
    pressOn(get("panel"));
    expect(shouldCanvasHandleKey(key(document.body, "Delete"), canvas, scope)).toBe(true);
  });

  it("ignores the body while a menu or dialog is open elsewhere in the page", () => {
    const { scope, canvas, get } = editor();
    get("menuitem").parentElement!.remove();
    pressOn(get("panel"));
    expect(shouldCanvasHandleKey(key(document.body, "v"), canvas, scope)).toBe(true);
    const portal = document.createElement("div");
    portal.setAttribute("role", "dialog");
    document.body.append(portal);
    expect(shouldCanvasHandleKey(key(document.body, "v"), canvas, scope)).toBe(false);
  });

  it("leaves arrow keys to a radio group but takes its letters", () => {
    const { scope, canvas, get } = editor();
    expect(shouldCanvasHandleKey(key(get("radio"), "ArrowRight"), canvas, scope)).toBe(false);
    expect(shouldCanvasHandleKey(key(get("radio"), "v"), canvas, scope)).toBe(true);
  });

  it("ignores keys outside the editor and keys another component handled", () => {
    const { scope, canvas, get } = editor();
    expect(shouldCanvasHandleKey(key(get("outside"), "v"), canvas, scope)).toBe(false);
    expect(shouldCanvasHandleKey(key(get("tool"), "v", true), canvas, scope)).toBe(false);
    expect(shouldCanvasHandleKey(key(canvas, "v", true), canvas, scope)).toBe(false);
    expect(shouldCanvasHandleKey(key(null, "v"), canvas, scope)).toBe(false);
  });
});

describe("textNodeAt", () => {
  const nodes: DesignNode[] = [
    { id: "slide", parentId: null, type: "frame", x: 0, y: 0, width: 1920, height: 1080 },
    { id: "title", parentId: "slide", type: "text", x: 0, y: 0, width: 400, height: 80, text: "T" },
    { id: "note", parentId: "slide", type: "note", x: 0, y: 0, width: 200, height: 200, text: "N" },
    {
      id: "locked",
      parentId: "slide",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: "L",
      locked: true,
    },
    { id: "shape", parentId: "slide", type: "rect", x: 0, y: 0, width: 10, height: 10 },
  ];
  const index = new Map(nodes.map((node) => [node.id, node]));

  it("finds the text or note pressed inside a slide, never an ancestor", () => {
    document.body.innerHTML = `<div data-node="slide"><div data-node="title">T</div>
      <div data-node="note">N</div><div data-node="locked">L</div><div data-node="shape"></div></div>`;
    const at = (id: string) => document.querySelector(`[data-node="${id}"]`);
    expect(textNodeAt(at("title"), index)?.id).toBe("title");
    expect(textNodeAt(at("note"), index)?.id).toBe("note");
    expect(textNodeAt(at("locked"), index)).toBeNull();
    expect(textNodeAt(at("shape"), index)).toBeNull();
    expect(textNodeAt(at("slide"), index)).toBeNull();
    expect(textNodeAt(document.body, index)).toBeNull();
    expect(textNodeAt(null, index)).toBeNull();
  });
});

describe("withoutDoubleClickPoint", () => {
  it("drops the second press's point however far it jittered", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 30, y: 0 },
    ];
    for (const jitter of [
      { x: 30, y: 0 },
      { x: 33, y: 2 },
      { x: 36, y: 5 },
    ])
      expect(withoutDoubleClickPoint([...path, jitter])).toEqual(path);
  });
});
