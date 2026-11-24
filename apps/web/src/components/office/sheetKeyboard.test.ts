import { describe, expect, it } from "vite-plus/test";

import {
  acceptsReference,
  cycleAbsolute,
  functionPrefixAt,
  sheetEditorKeyAction,
  sheetKeyAction,
  stepAlong,
} from "./sheetKeyboard";

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; code: string }> = {}) => ({
  key: k,
  ...(mods.code ? { code: mods.code } : {}),
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("sheetKeyAction", () => {
  it("uses Cmd on macOS and Ctrl elsewhere", () => {
    expect(sheetKeyAction(key("z", { meta: true }), "mac")).toEqual({ type: "undo" });
    expect(sheetKeyAction(key("z", { ctrl: true }), "other")).toEqual({ type: "undo" });
    expect(sheetKeyAction(key("z", { ctrl: true }), "mac")).toBeNull();
    expect(sheetKeyAction(key("z", { meta: true }), "other")).toBeNull();
    expect(sheetKeyAction(key("Z", { meta: true, shift: true }), "mac")).toEqual({ type: "redo" });
    expect(sheetKeyAction(key("y", { ctrl: true }), "other")).toEqual({ type: "redo" });
    expect(sheetKeyAction(key("b", { ctrl: true }), "other")).toEqual({ type: "toggle", style: "bold" });
    expect(sheetKeyAction(key("/", { meta: true }), "mac")).toEqual({ type: "shortcuts" });
    expect(sheetKeyAction(key("%", { ctrl: true, shift: true, code: "Digit5" }), "other")).toEqual({ type: "format", kind: "percent" });
  });

  it("moves, extends and jumps", () => {
    expect(sheetKeyAction(key("ArrowDown"), "mac")).toEqual({ type: "move", direction: "down", extend: false, edge: false });
    expect(sheetKeyAction(key("ArrowLeft", { shift: true, meta: true }), "mac")).toEqual({ type: "move", direction: "left", extend: true, edge: true });
    expect(sheetKeyAction(key("Home", { ctrl: true }), "other")).toEqual({ type: "home", extend: false, sheet: true });
    expect(sheetKeyAction(key("PageDown"), "other")).toEqual({ type: "page", direction: "down", extend: false });
    expect(sheetKeyAction(key("PageDown", { ctrl: true }), "other")).toEqual({ type: "switchTab", delta: 1 });
    expect(sheetKeyAction(key(" ", { ctrl: true }), "mac")).toEqual({ type: "selectColumn" });
    expect(sheetKeyAction(key(" ", { shift: true }), "mac")).toEqual({ type: "selectRow" });
  });

  it("edits, types and clears", () => {
    expect(sheetKeyAction(key("F2"), "mac")).toEqual({ type: "edit" });
    expect(sheetKeyAction(key("x"), "mac")).toEqual({ type: "type", text: "x" });
    expect(sheetKeyAction(key("Backspace"), "mac")).toEqual({ type: "clear" });
    expect(sheetKeyAction(key("Tab", { shift: true }), "mac")).toEqual({ type: "tab", back: true });
    expect(sheetKeyAction(key("c", { meta: true }), "mac")).toBeNull();
  });
});

describe("sheetEditorKeyAction", () => {
  it("commits, cancels and moves", () => {
    expect(sheetEditorKeyAction(key("Enter"), "mac", false)).toEqual({ type: "commit", move: "down" });
    expect(sheetEditorKeyAction(key("Enter", { shift: true }), "mac", false)).toEqual({ type: "commit", move: "up" });
    expect(sheetEditorKeyAction(key("Enter", { alt: true }), "other", false)).toEqual({ type: "newline" });
    expect(sheetEditorKeyAction(key("Tab"), "mac", false)).toEqual({ type: "commit", move: "right" });
    expect(sheetEditorKeyAction(key("Escape"), "mac", false)).toEqual({ type: "cancel" });
    expect(sheetEditorKeyAction(key("ArrowRight"), "mac", true)).toEqual({ type: "commit", move: "right" });
    expect(sheetEditorKeyAction(key("ArrowRight"), "mac", false)).toBeNull();
  });
});

describe("helpers", () => {
  it("jumps to the edge of the data like Cmd/Ctrl+arrow", () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const filled = (i: number) => [1, 2, 3, 6].includes(i);
    expect(stepAlong(order, 1, 1, true, filled)).toBe(3);
    expect(stepAlong(order, 3, 1, true, filled)).toBe(6);
    expect(stepAlong(order, 6, 1, true, filled)).toBe(9);
    expect(stepAlong(order, 6, -1, true, filled)).toBe(3);
    expect(stepAlong(order, 0, -1, true, filled)).toBe(0);
    expect(stepAlong([0, 2, 3], 0, 1, false, filled)).toBe(2);
  });

  it("cycles $ marks with F4", () => {
    expect(cycleAbsolute("=A1+B2", 3)).toEqual({ text: "=$A$1+B2", caret: 5 });
    expect(cycleAbsolute("=$A$1", 5).text).toBe("=A$1");
    expect(cycleAbsolute("=A$1", 4).text).toBe("=$A1");
    expect(cycleAbsolute("=$A1", 4).text).toBe("=A1");
  });

  it("knows where a reference or a function name may go", () => {
    expect(acceptsReference("=SUM(", 5)).toBe(true);
    expect(acceptsReference("=A1", 3)).toBe(false);
    expect(acceptsReference("plain", 5)).toBe(false);
    expect(functionPrefixAt("=1+su", 5)).toEqual({ start: 3, prefix: "SU" });
    expect(functionPrefixAt("=B12", 4)).toBeNull();
  });
});
