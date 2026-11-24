/**
 * The Sheet editor's keys, as Excel and Google Sheets use them: Cmd on macOS,
 * Ctrl on Windows and Linux. Pure: a key press in, an action out, so every
 * binding is testable on every platform.
 */
import type { CellAddress } from "@specweave-studio/shared/officeSheet";

export type SheetPlatform = "mac" | "other";

/** The platform the app runs on, from the browser. */
export function detectSheetPlatform(): SheetPlatform {
  if (typeof navigator === "undefined") return "other";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const name = data?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(name) ? "mac" : "other";
}

export interface SheetKey {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export type SheetDirection = "up" | "down" | "left" | "right";

export type SheetKeyAction =
  | { readonly type: "move"; readonly direction: SheetDirection; readonly extend: boolean; readonly edge: boolean }
  | { readonly type: "page"; readonly direction: "up" | "down"; readonly extend: boolean }
  | { readonly type: "home"; readonly extend: boolean; readonly sheet: boolean }
  | { readonly type: "end"; readonly extend: boolean; readonly sheet: boolean }
  | { readonly type: "tab"; readonly back: boolean }
  | { readonly type: "enter"; readonly back: boolean }
  | { readonly type: "edit" }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "clear" }
  | { readonly type: "escape" }
  | { readonly type: "selectAll" }
  | { readonly type: "selectRow" }
  | { readonly type: "selectColumn" }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  | { readonly type: "toggle"; readonly style: "bold" | "italic" | "underline" }
  | { readonly type: "format"; readonly kind: "number" | "currency" | "percent" }
  | { readonly type: "fill"; readonly direction: "down" | "right" }
  | { readonly type: "today" }
  | { readonly type: "shortcuts" }
  | { readonly type: "switchTab"; readonly delta: 1 | -1 }
  | { readonly type: "newTab" };

const ARROWS: Readonly<Record<string, SheetDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The platform's command key is down: Cmd on macOS, Ctrl elsewhere. */
export function primaryKey(event: SheetKey, platform: SheetPlatform): boolean {
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}

/** What a key press on the grid (not inside a cell editor) does, or null to let it through. */
export function sheetKeyAction(event: SheetKey, platform: SheetPlatform): SheetKeyAction | null {
  const mod = primaryKey(event, platform);
  // On macOS a bare Ctrl press is not a command; elsewhere Meta is the OS key.
  const otherMod = platform === "mac" ? event.ctrlKey : event.metaKey;
  const { key, shiftKey: shift, altKey: alt } = event;
  const arrow = ARROWS[key];
  if (arrow && !alt && !otherMod) return { type: "move", direction: arrow, extend: shift, edge: mod };
  // Ctrl+Space selects the column on every platform, as in Excel.
  if (key === " " && !shift && !alt && (mod || event.ctrlKey)) return { type: "selectColumn" };
  if (otherMod) return null;
  if (key === "PageUp" || key === "PageDown") {
    if (mod || alt) return { type: "switchTab", delta: key === "PageDown" ? 1 : -1 };
    return { type: "page", direction: key === "PageDown" ? "down" : "up", extend: shift };
  }
  if (alt && shift && !mod && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "switchTab", delta: key === "ArrowDown" ? 1 : -1 };
  }
  if (key === "Home") return { type: "home", extend: shift, sheet: mod };
  if (key === "End") return { type: "end", extend: shift, sheet: mod };
  if (key === "F11" && shift) return { type: "newTab" };
  if (mod) {
    const lower = key.toLowerCase();
    if (lower === "z") return shift ? { type: "redo" } : { type: "undo" };
    if (lower === "y" && !shift) return { type: "redo" };
    if (lower === "a" && !shift) return { type: "selectAll" };
    if (lower === "b" && !shift) return { type: "toggle", style: "bold" };
    if (lower === "i" && !shift) return { type: "toggle", style: "italic" };
    if (lower === "u" && !shift) return { type: "toggle", style: "underline" };
    if (lower === "d" && !shift) return { type: "fill", direction: "down" };
    if (lower === "r" && !shift) return { type: "fill", direction: "right" };
    if (key === "/" || event.code === "Slash") return { type: "shortcuts" };
    if (key === ";" && !shift) return { type: "today" };
    if (shift && (event.code === "Digit1" || key === "!")) return { type: "format", kind: "number" };
    if (shift && (event.code === "Digit4" || key === "$")) return { type: "format", kind: "currency" };
    if (shift && (event.code === "Digit5" || key === "%")) return { type: "format", kind: "percent" };
    return null;
  }
  if (alt) return null;
  if (key === " " && shift) return { type: "selectRow" };
  if (key === "Tab") return { type: "tab", back: shift };
  if (key === "Enter") return { type: "enter", back: shift };
  if (key === "F2") return { type: "edit" };
  if (key === "Delete" || key === "Backspace") return { type: "clear" };
  if (key === "Escape") return { type: "escape" };
  if (key.length === 1) return { type: "type", text: key };
  return null;
}

/** What a key does inside the cell editor, or null to leave it to the text field. */
export type SheetEditorKeyAction =
  | { readonly type: "commit"; readonly move: SheetDirection | null }
  | { readonly type: "cancel" }
  | { readonly type: "newline" }
  | { readonly type: "absolute" };

/**
 * Keys inside the cell editor. `typing` is the mode a typed character starts:
 * arrows then commit and move, as in a spreadsheet; after F2, a double-click or
 * a click in the formula bar they move the caret.
 */
export function sheetEditorKeyAction(
  event: SheetKey,
  platform: SheetPlatform,
  typing: boolean,
): SheetEditorKeyAction | null {
  const mod = primaryKey(event, platform);
  if (event.key === "Escape") return { type: "cancel" };
  if (event.key === "Enter") {
    if (event.altKey || (platform === "mac" && event.ctrlKey)) return { type: "newline" };
    if (mod) return { type: "commit", move: null };
    return { type: "commit", move: event.shiftKey ? "up" : "down" };
  }
  if (event.key === "Tab") return { type: "commit", move: event.shiftKey ? "left" : "right" };
  if (event.key === "F4") return { type: "absolute" };
  const arrow = ARROWS[event.key];
  if (arrow && typing && !mod && !event.shiftKey && !event.altKey) return { type: "commit", move: arrow };
  return null;
}

/**
 * The next cell along a line of display positions: one step, or with `edge`
 * the far end of the block of filled cells, as Cmd/Ctrl+arrow does.
 */
export function stepAlong(
  order: ReadonlyArray<number>,
  current: number,
  delta: 1 | -1,
  edge: boolean,
  filled: (index: number) => boolean,
): number {
  const at = order.indexOf(current);
  const position = at < 0 ? 0 : at;
  const last = order.length - 1;
  if (!edge) return order[Math.max(0, Math.min(last, position + delta))]!;
  const next = position + delta;
  if (next < 0 || next > last) return order[position]!;
  let index = position;
  if (filled(order[position]!) && filled(order[next]!)) {
    // Inside a block: run to its last filled cell.
    while (index + delta >= 0 && index + delta <= last && filled(order[index + delta]!)) index += delta;
    return order[index]!;
  }
  // At a block's end or in a gap: run to the next filled cell, or the end of the line.
  index = next;
  while (index >= 0 && index <= last && !filled(order[index]!)) index += delta;
  if (index < 0) return order[0]!;
  if (index > last) return order[last]!;
  return order[index]!;
}

export interface ShortcutEntry {
  readonly keys: string;
  readonly label: string;
}

/** The shortcuts list (Cmd/Ctrl+/), with the platform's own key names. */
export function sheetShortcuts(platform: SheetPlatform): ReadonlyArray<{
  readonly group: string;
  readonly entries: ReadonlyArray<ShortcutEntry>;
}> {
  const mod = platform === "mac" ? "⌘" : "Ctrl+";
  const shift = platform === "mac" ? "⇧" : "Shift+";
  const alt = platform === "mac" ? "⌥" : "Alt+";
  return [
    {
      group: "Move and select",
      entries: [
        { keys: "Arrows", label: "Move one cell" },
        { keys: `${shift}Arrows`, label: "Extend the selection" },
        { keys: `${mod}Arrows`, label: "Jump to the edge of the data" },
        { keys: `${mod}${shift}Arrows`, label: "Select to the edge of the data" },
        { keys: "Tab / " + `${shift}Tab`, label: "Move right / left" },
        { keys: "Enter / " + `${shift}Enter`, label: "Move down / up" },
        { keys: "Home / End", label: "First / last filled column of the row" },
        { keys: `${mod}Home / ${mod}End`, label: "First cell / last filled cell" },
        { keys: "Page Up / Page Down", label: "Move one screen" },
        { keys: `${mod}A`, label: "Select all" },
        { keys: `${shift}Space`, label: "Select the row" },
        { keys: `${mod}Space`, label: "Select the column" },
      ],
    },
    {
      group: "Edit",
      entries: [
        { keys: "Type", label: "Replace the cell" },
        { keys: "F2 / double-click", label: "Edit in the cell" },
        { keys: "Enter", label: "Save and move down" },
        { keys: "Esc", label: "Cancel the edit" },
        { keys: `${alt}Enter`, label: "New line in the cell" },
        { keys: "F4", label: "Cycle $ in a reference" },
        { keys: "Delete / Backspace", label: "Clear the cells" },
        { keys: `${mod}C / ${mod}X / ${mod}V`, label: "Copy / cut / paste" },
        { keys: `${mod}Z`, label: "Undo" },
        { keys: `${mod}${shift}Z / ${mod}Y`, label: "Redo" },
        { keys: `${mod}D / ${mod}R`, label: "Fill down / right" },
        { keys: `${mod};`, label: "Today's date" },
      ],
    },
    {
      group: "Format",
      entries: [
        { keys: `${mod}B`, label: "Bold" },
        { keys: `${mod}I`, label: "Italic" },
        { keys: `${mod}U`, label: "Underline" },
        { keys: `${mod}${shift}1`, label: "Number format" },
        { keys: `${mod}${shift}4`, label: "Currency format" },
        { keys: `${mod}${shift}5`, label: "Percent format" },
      ],
    },
    {
      group: "Tabs",
      entries: [
        { keys: `${shift}F11`, label: "New tab" },
        { keys: `${mod}Page Down / ${mod}Page Up`, label: "Next / previous tab" },
        { keys: `${mod}/`, label: "This list" },
      ],
    },
  ];
}

/** Cycle the `$` marks of the reference at or before the caret, as F4 does. */
export function cycleAbsolute(text: string, caret: number): { readonly text: string; readonly caret: number } {
  const pattern = /(\$?)([A-Za-z]{1,2})(\$?)([1-9][0-9]{0,5})(?![A-Za-z0-9_(])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret < start || caret > end) continue;
    if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) continue;
    const colAbs = match[1] === "$";
    const rowAbs = match[3] === "$";
    // A1 -> $A$1 -> A$1 -> $A1 -> A1
    const [nextCol, nextRow] = !colAbs && !rowAbs ? [true, true] : colAbs && rowAbs ? [false, true] : !colAbs && rowAbs ? [true, false] : [false, false];
    const replaced = `${nextCol ? "$" : ""}${match[2]}${nextRow ? "$" : ""}${match[4]}`;
    return { text: text.slice(0, start) + replaced + text.slice(end), caret: start + replaced.length };
  }
  return { text, caret };
}

/** True when the caret in a formula sits where a cell reference may go. */
export function acceptsReference(text: string, caret: number): boolean {
  if (!text.startsWith("=")) return false;
  const before = text.slice(0, caret).trimEnd();
  return /[=(,+\-*/^&<>:;]$/.test(before);
}

/** The function name being typed at the caret of a formula, for autocomplete. */
export function functionPrefixAt(text: string, caret: number): { readonly start: number; readonly prefix: string } | null {
  if (!text.startsWith("=")) return null;
  const match = /(^|[=(,+\-*/^&<>:;\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const prefix = match[2]!;
  // A cell reference such as B12 is not a function name.
  if (/^[A-Za-z]{1,2}[0-9]+$/.test(prefix)) return null;
  return { start: caret - prefix.length, prefix: prefix.toUpperCase() };
}

/** A cell address string for formulas, e.g. a click while typing a formula. */
export function referenceText(anchor: CellAddress, focus: CellAddress, name: (address: CellAddress) => string): string {
  if (anchor.col === focus.col && anchor.row === focus.row) return name(anchor);
  const start = { col: Math.min(anchor.col, focus.col), row: Math.min(anchor.row, focus.row) };
  const end = { col: Math.max(anchor.col, focus.col), row: Math.max(anchor.row, focus.row) };
  return `${name(start)}:${name(end)}`;
}
