/**
 * The Sheet editor's controller: selection and keyboard navigation, in-cell
 * and formula-bar editing, formatting, rows, columns and tabs, copy and paste,
 * and undo. Every change goes through `commit`, which records it for undo and
 * hands it to the revision-checked save.
 */
import {
  type CellAddress,
  type CellRange,
  type SheetDocument,
  type SheetEvaluation,
  type SheetHistory,
  type SheetTab,
  EMPTY_SHEET_HISTORY,
  SHEET_LIMITS,
  SheetEditLimitError,
  addTab,
  applyBorders,
  applyStyle,
  cellInputText,
  cellName,
  clearRange,
  deleteColumns,
  deleteRows,
  deleteTab,
  insertColumns,
  insertRows,
  paintStyle,
  parseCellInput,
  parseCellRange,
  recordEdit,
  redoEdit,
  renameTab,
  setCells,
  setFormat,
  stepDecimals,
  toggleStyleFlag,
  undoEdit,
  usedRange,
} from "@specweave-studio/shared/officeSheet";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SheetContextTarget, SheetStructureCommand } from "./SheetContextMenu";
import type { SheetFillChoice, SheetNumberChoice } from "./SheetFormatBar";
import { numberFormatFor } from "./SheetFormatBar";
import { copySheetRange, planSheetPaste, readSheetClipboard } from "./sheetClipboard";
import { fillRange, todayText } from "./sheetCommands";
import { createSheetEditStore } from "./sheetEditStore";
import { SHEET_VIEW_COLUMNS, SHEET_VIEW_ROWS, type Selection, type SheetGridModel, normalize } from "./sheetGridModel";
import {
  type SheetDirection,
  type SheetEditorKeyAction,
  type SheetKeyAction,
  type SheetPlatform,
  acceptsReference,
  referenceText,
  sheetKeyAction,
  stepAlong,
} from "./sheetKeyboard";

export interface SheetEditingState {
  readonly address: CellAddress;
  readonly tabIndex: number;
  /** Started by typing: arrows commit and move. */
  readonly typing: boolean;
  /** Where the caret is: the cell or the formula bar. */
  readonly origin: "cell" | "bar";
}

const DELTA: Readonly<Record<SheetDirection, CellAddress>> = {
  up: { col: 0, row: -1 },
  down: { col: 0, row: 1 },
  left: { col: -1, row: 0 },
  right: { col: 1, row: 0 },
};

export function useSheetEditor(input: {
  readonly document: SheetDocument | null;
  readonly evaluation: SheetEvaluation | null;
  readonly tab: SheetTab | undefined;
  readonly tabIndex: number;
  readonly grid: SheetGridModel | null;
  readonly editable: boolean;
  /** Why edits are refused right now (an unresolved conflict), shown when one is tried. */
  readonly blockedReason?: string | null | undefined;
  readonly platform: SheetPlatform;
  readonly selection: Selection | null;
  readonly setSelection: (next: Selection | null) => void;
  readonly selectTab: (index: number) => void;
  readonly save: (next: SheetDocument) => Promise<boolean>;
  readonly setSaveError: (message: string | null) => void;
  readonly isOwnRevision: (revision: string) => boolean;
  readonly incomingRevision: string;
}) {
  const { document, evaluation, tab, tabIndex, grid, selection, setSelection } = input;
  const store = useMemo(() => createSheetEditStore(), []);
  const [editing, setEditing] = useState<SheetEditingState | null>(null);
  const [history, setHistory] = useState<SheetHistory>(EMPTY_SHEET_HISTORY);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menu, setMenu] = useState<SheetContextTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pointAnchor = useRef<CellAddress | null>(null);

  // A file changed by someone else (an agent, another window) starts a new
  // history. Only a newly arrived revision counts: an edit on its way to disk
  // re-renders over the old one and must keep its Undo.
  const { incomingRevision, isOwnRevision } = input;
  const [seenRevision, setSeenRevision] = useState(incomingRevision);
  if (incomingRevision !== seenRevision) {
    setSeenRevision(incomingRevision);
    if (!isOwnRevision(incomingRevision)) setHistory(EMPTY_SHEET_HISTORY);
  }

  const range = selection ? normalize(selection.anchor, selection.focus) : null;

  const focusGrid = () => {
    const element = scrollRef.current;
    if (element && typeof element.focus === "function") element.focus({ preventScroll: true });
  };

  // The focused cell stays on screen.
  const focusName = selection ? cellName(selection.focus) : null;
  useEffect(() => {
    if (!focusName) return;
    const cell = scrollRef.current?.querySelector?.(`[data-cell="${focusName}"]`);
    if (cell && typeof cell.scrollIntoView === "function") {
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [focusName]);

  /** Record an edit for undo and save it; a refused edit says why and changes nothing. */
  const commit = (change: (current: SheetDocument) => SheetDocument): Promise<boolean> | null => {
    if (!document) return null;
    if (!input.editable) {
      if (input.blockedReason) input.setSaveError(input.blockedReason);
      return null;
    }
    let next: SheetDocument;
    try {
      next = change(document);
    } catch (error) {
      if (error instanceof SheetEditLimitError) {
        input.setSaveError(error.message);
        return null;
      }
      throw error;
    }
    if (next === document) return null;
    const before = document;
    setHistory((current) => recordEdit(current, before));
    return input.save(next).then((ok) => {
      if (!ok) {
        setHistory((current) =>
          current.past.at(-1) === before ? { ...current, past: current.past.slice(0, -1) } : current,
        );
      }
      return ok;
    });
  };

  const undo = () => {
    if (!document) return;
    const step = undoEdit(history, document);
    if (!step) return;
    setHistory(step.history);
    void input.save(step.document);
  };
  const redo = () => {
    if (!document) return;
    const step = redoEdit(history, document);
    if (!step) return;
    setHistory(step.history);
    void input.save(step.document);
  };

  // ------------------------------------------------------------ navigation

  const select = (focus: CellAddress, extend = false) => {
    setSelection(extend && selection ? { anchor: selection.anchor, focus } : { anchor: focus, focus });
  };

  const filled = (address: CellAddress): boolean => tab?.cells[cellName(address)] !== undefined;

  const step = (from: CellAddress, direction: SheetDirection, edge: boolean): CellAddress => {
    if (!grid) return from;
    const vertical = direction === "up" || direction === "down";
    const delta = DELTA[direction];
    const sign = (vertical ? delta.row : delta.col) as 1 | -1;
    const order = vertical ? grid.displayRows : grid.displayCols;
    const current = vertical ? from.row : from.col;
    const limit = vertical ? SHEET_VIEW_ROWS : SHEET_VIEW_COLUMNS;
    let next = stepAlong(order, current, sign, edge, (index) =>
      filled(vertical ? { col: from.col, row: index } : { col: index, row: from.row }),
    );
    // Past the drawn edge the grid grows, up to what it draws at most.
    if (!edge && next === current && sign === 1 && order.at(-1) === current && current + 1 < limit) {
      next = current + 1;
    }
    return vertical ? { col: from.col, row: next } : { col: next, row: from.row };
  };

  const pageRows = (): number => {
    const height = scrollRef.current?.clientHeight ?? 0;
    return Math.max(5, Math.floor(height / 28) - 2);
  };

  // ------------------------------------------------------------ editing

  const beginEdit = (address: CellAddress, text: string | null, typing: boolean, origin: "cell" | "bar" = "cell") => {
    if (!input.editable || !tab) return;
    const initial = text ?? cellInputText(tab.cells[cellName(address)]);
    store.set({ text: initial, caret: initial.length, pointed: null });
    pointAnchor.current = null;
    setSelection({ anchor: address, focus: address });
    setEditing({ address, tabIndex, typing, origin });
  };

  const commitEdit = (move: SheetDirection | null) => {
    const current = editing;
    if (!current || !tab) return;
    setEditing(null);
    const text = store.get().text;
    const name = cellName(current.address);
    const before = cellInputText(document?.tabs[current.tabIndex]?.cells[name]);
    if (text !== before) {
      const parsed = parseCellInput(text);
      const hasFormat = grid?.formatOf(current.address) !== undefined;
      commit((doc) => {
        let next = setCells(doc, current.tabIndex, [[current.address, parsed.input]]);
        if (parsed.format && !hasFormat) {
          next = setFormat(next, current.tabIndex, { start: current.address, end: current.address }, parsed.format);
        }
        return next;
      });
    }
    if (move) select(step(current.address, move, false));
    focusGrid();
  };

  const cancelEdit = () => {
    setEditing(null);
    focusGrid();
  };

  const onEditorAction = (action: SheetEditorKeyAction) => {
    if (action.type === "cancel") cancelEdit();
    else if (action.type === "commit") commitEdit(action.move);
  };

  /** A click on a cell: select it, or while typing a formula, put its reference in. */
  const pick = (address: CellAddress, extend: boolean, event?: { readonly preventDefault: () => void }) => {
    if (editing) {
      const state = store.get();
      const pointing = state.pointed !== null || acceptsReference(state.text, state.caret);
      if (pointing && editing.tabIndex === tabIndex) {
        // Keep the caret in the editor.
        event?.preventDefault();
        const anchor = extend && pointAnchor.current ? pointAnchor.current : address;
        if (!extend) pointAnchor.current = address;
        const ref = referenceText(anchor, address, cellName);
        const start = state.pointed?.start ?? state.caret;
        const end = state.pointed?.end ?? state.caret;
        const text = `${state.text.slice(0, start)}${ref}${state.text.slice(end)}`;
        store.set({ text, caret: start + ref.length, pointed: { start, end: start + ref.length } });
        return;
      }
      commitEdit(null);
    }
    select(address, extend);
  };

  const pickHeader = (kind: "row" | "col", index: number, extend: boolean) => {
    if (!grid) return;
    if (editing) commitEdit(null);
    const lastRow = Math.max(0, grid.rows - 1);
    const lastCol = Math.max(0, grid.columns - 1);
    if (kind === "col") {
      const anchorCol = extend && selection ? selection.anchor.col : index;
      setSelection({ anchor: { col: anchorCol, row: 0 }, focus: { col: index, row: lastRow } });
    } else {
      const anchorRow = extend && selection ? selection.anchor.row : index;
      setSelection({ anchor: { col: 0, row: anchorRow }, focus: { col: lastCol, row: index } });
    }
  };

  // ------------------------------------------------------------ formatting

  const target = (): CellRange | null => range;

  const toggle = (style: "bold" | "italic" | "underline") => {
    const at = target();
    if (!at || !grid) return;
    commit((doc) => toggleStyleFlag(doc, tabIndex, at, style, grid.styleOf));
  };
  const align = (value: "left" | "center" | "right" | undefined) => {
    const at = target();
    if (at) commit((doc) => applyStyle(doc, tabIndex, at, { align: value }));
  };
  const fill = (choice: SheetFillChoice) => {
    const at = target();
    if (!at) return;
    commit((doc) =>
      paintStyle(doc, tabIndex, at, (current) => {
        const { fill: _band, fillTone: _tone, ...rest } = current ?? {};
        if (choice === "none") return rest;
        if (choice === "band") return { ...rest, fill: true };
        return { ...rest, fillTone: choice };
      }),
    );
  };
  const number = (choice: SheetNumberChoice) => {
    const at = target();
    if (at) commit((doc) => setFormat(doc, tabIndex, at, numberFormatFor(choice)));
  };
  const decimals = (delta: 1 | -1) => {
    const at = target();
    if (at) commit((doc) => stepDecimals(doc, tabIndex, at, delta));
  };
  const borders = (preset: Parameters<typeof applyBorders>[3]) => {
    const at = target();
    if (at) commit((doc) => applyBorders(doc, tabIndex, at, preset));
  };

  // ------------------------------------------------------------ rows, columns, tabs

  const structure = (command: SheetStructureCommand, at: SheetContextTarget) => {
    setMenu(null);
    const { rows, cols } = at;
    switch (command) {
      case "rowAbove":
        commit((doc) => insertRows(doc, tabIndex, rows.first, rows.count));
        break;
      case "rowBelow":
        commit((doc) => insertRows(doc, tabIndex, rows.first + rows.count, rows.count));
        break;
      case "deleteRows":
        commit((doc) => deleteRows(doc, tabIndex, rows.first, rows.count));
        break;
      case "colLeft":
        commit((doc) => insertColumns(doc, tabIndex, cols.first, cols.count));
        break;
      case "colRight":
        commit((doc) => insertColumns(doc, tabIndex, cols.first + cols.count, cols.count));
        break;
      case "deleteCols":
        commit((doc) => deleteColumns(doc, tabIndex, cols.first, cols.count));
        break;
      case "clear":
        if (range) commit((doc) => clearRange(doc, tabIndex, range));
        break;
      case "copy":
      case "cut":
        void writeClipboard(command === "cut");
        break;
      case "paste":
        void readClipboard();
        break;
    }
    focusGrid();
  };

  const openMenu = (kind: "row" | "col" | "cell", address: CellAddress, event: ReactMouseEvent) => {
    if (!input.editable || !grid) return;
    event.preventDefault();
    if (editing) commitEdit(null);
    let current = range;
    // A header acts on the selected rows (columns) only when whole rows (columns) are selected.
    const wholeRows = current !== null && current.start.col === 0 && current.end.col >= grid.columns - 1;
    const wholeCols = current !== null && current.start.row === 0 && current.end.row >= grid.rows - 1;
    const inside =
      current !== null &&
      (kind === "row"
        ? wholeRows && address.row >= current.start.row && address.row <= current.end.row
        : kind === "col"
          ? wholeCols && address.col >= current.start.col && address.col <= current.end.col
          : address.col >= current.start.col &&
            address.col <= current.end.col &&
            address.row >= current.start.row &&
            address.row <= current.end.row);
    if (!inside) {
      if (kind === "cell") select(address);
      else pickHeader(kind, kind === "row" ? address.row : address.col, false);
      current = { start: address, end: address };
    }
    const area = current ?? { start: address, end: address };
    setMenu({
      kind,
      x: event.clientX,
      y: event.clientY,
      rows: { first: area.start.row, count: area.end.row - area.start.row + 1 },
      cols: { first: area.start.col, count: area.end.col - area.start.col + 1 },
    });
  };

  const newTab = () => {
    if (!document) return;
    let added = -1;
    if (
      commit((doc) => {
        const result = addTab(doc, { after: tabIndex });
        added = result.index;
        return result.document;
      })
    ) {
      input.selectTab(added);
    }
  };
  const renameTabAt = (index: number, name: string): string | null => {
    let problem: string | null = null;
    try {
      if (document) renameTab(document, index, name);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) return problem;
    commit((doc) => renameTab(doc, index, name));
    return null;
  };
  const deleteTabAt = (index: number) => {
    if (commit((doc) => deleteTab(doc, index))) input.selectTab(Math.max(0, index - 1));
  };

  // ------------------------------------------------------------ clipboard

  const payload = () => {
    if (!range || !tab || !evaluation || !grid) return null;
    return copySheetRange({ tab, tabIndex, evaluation, range, formatOf: grid.formatOf, styleOf: grid.styleOf });
  };

  const pasteGrid = (data: { readonly html?: string; readonly text?: string }) => {
    if (!range) return;
    const parsed = readSheetClipboard(data);
    if (!parsed) return;
    const plan = planSheetPaste(parsed, range, { rows: SHEET_LIMITS.rows, columns: SHEET_LIMITS.columns });
    if (!plan) {
      input.setSaveError("The paste does not fit on the sheet.");
      return;
    }
    commit((doc) => {
      let next = setCells(doc, tabIndex, plan.entries);
      for (const [address, format] of plan.formats) {
        next = setFormat(next, tabIndex, { start: address, end: address }, format);
      }
      return next;
    });
    setSelection({ anchor: plan.range.start, focus: plan.range.end });
  };

  const writeClipboard = async (cut: boolean) => {
    const data = payload();
    if (!data) return;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([data.text], { type: "text/plain" }),
            "text/html": new Blob([data.html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(data.text);
      }
      if (cut && range) commit((doc) => clearRange(doc, tabIndex, range));
    } catch {
      input.setSaveError("The clipboard could not be written. Use the keyboard to copy.");
    }
  };

  const readClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      let html: string | undefined;
      let text: string | undefined;
      for (const item of items) {
        if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
        if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      }
      pasteGrid({ ...(html ? { html } : {}), ...(text ? { text } : {}) });
    } catch {
      input.setSaveError("The clipboard could not be read. Use the keyboard to paste.");
    }
  };

  // Copy, cut and paste from the keyboard arrive as document events.
  const latest = useRef({ payload, pasteGrid, range, editing, editable: input.editable, commit, tabIndex });
  latest.current = { payload, pasteGrid, range, editing, editable: input.editable, commit, tabIndex };
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.document?.addEventListener !== "function") return;
    const owns = () => {
      const active = window.document.activeElement;
      return scrollRef.current !== null && active !== null && scrollRef.current === active;
    };
    const onCopy = (event: ClipboardEvent, cut: boolean) => {
      const now = latest.current;
      if (!owns() || now.editing || !event.clipboardData) return;
      const data = now.payload();
      if (!data) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", data.text);
      event.clipboardData.setData("text/html", data.html);
      if (cut && now.editable && now.range) {
        const at = now.range;
        now.commit((doc) => clearRange(doc, now.tabIndex, at));
      }
    };
    const copy = (event: ClipboardEvent) => onCopy(event, false);
    const cut = (event: ClipboardEvent) => onCopy(event, true);
    const paste = (event: ClipboardEvent) => {
      const now = latest.current;
      if (!owns() || now.editing || !now.editable || !event.clipboardData) return;
      event.preventDefault();
      const html = event.clipboardData.getData("text/html");
      const text = event.clipboardData.getData("text/plain");
      now.pasteGrid({ ...(html ? { html } : {}), ...(text ? { text } : {}) });
    };
    window.document.addEventListener("copy", copy);
    window.document.addEventListener("cut", cut);
    window.document.addEventListener("paste", paste);
    return () => {
      window.document.removeEventListener("copy", copy);
      window.document.removeEventListener("cut", cut);
      window.document.removeEventListener("paste", paste);
    };
  }, []);

  // ------------------------------------------------------------ keys

  const run = (action: SheetKeyAction): boolean => {
    if (!grid || !tab) return false;
    const focus = selection?.focus ?? { col: grid.displayCols[0] ?? 0, row: grid.displayRows[0] ?? 0 };
    const lastFilled = usedRange(tab);
    switch (action.type) {
      case "move":
        select(step(focus, action.direction, action.edge), action.extend);
        return true;
      case "page": {
        let next = focus;
        for (let index = 0; index < pageRows(); index += 1) next = step(next, action.direction, false);
        select(next, action.extend);
        return true;
      }
      case "home": {
        const col = grid.displayCols[0] ?? 0;
        select(action.sheet ? { col, row: grid.displayRows[0] ?? 0 } : { col, row: focus.row }, action.extend);
        return true;
      }
      case "end": {
        if (action.sheet) {
          select(lastFilled ? lastFilled.end : focus, action.extend);
          return true;
        }
        const filledCols = grid.displayCols.filter((col) => filled({ col, row: focus.row }));
        select({ col: filledCols.at(-1) ?? focus.col, row: focus.row }, action.extend);
        return true;
      }
      case "tab":
        select(step(focus, action.back ? "left" : "right", false));
        return true;
      case "enter":
        select(step(focus, action.back ? "up" : "down", false));
        return true;
      case "selectAll": {
        const end = {
          col: Math.max(grid.columns - 1, lastFilled?.end.col ?? 0),
          row: Math.max(grid.rows - 1, lastFilled?.end.row ?? 0),
        };
        setSelection({ anchor: { col: 0, row: 0 }, focus: end });
        return true;
      }
      case "selectRow":
        setSelection({ anchor: { col: 0, row: focus.row }, focus: { col: grid.columns - 1, row: focus.row } });
        return true;
      case "selectColumn":
        setSelection({ anchor: { col: focus.col, row: 0 }, focus: { col: focus.col, row: grid.rows - 1 } });
        return true;
      case "escape":
        return false;
      case "shortcuts":
        setShortcutsOpen((open) => !open);
        return true;
      case "switchTab": {
        const count = document?.tabs.length ?? 1;
        input.selectTab((tabIndex + action.delta + count) % count);
        return true;
      }
      case "undo":
        undo();
        return true;
      case "redo":
        redo();
        return true;
    }
    if (!input.editable) return false;
    const at = range ?? { start: focus, end: focus };
    switch (action.type) {
      case "edit":
        beginEdit(focus, null, false);
        return true;
      case "type":
        beginEdit(focus, action.text, true);
        return true;
      case "clear":
        commit((doc) => clearRange(doc, tabIndex, at));
        return true;
      case "toggle":
        toggle(action.style);
        return true;
      case "format":
        number(action.kind);
        return true;
      case "fill":
        commit((doc) => fillRange(doc, tabIndex, at, action.direction));
        return true;
      case "today":
        commit((doc) => setCells(doc, tabIndex, [[focus, todayText()]]));
        return true;
      case "newTab":
        newTab();
        return true;
    }
    return false;
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A select, a field or a chart inside the grid keeps its own keys.
    const element = event.target as Partial<Element> | null;
    if (
      typeof element?.closest === "function" &&
      element.closest("select, input, textarea, [data-chart-id], [data-sheet-editor]")
    ) {
      return;
    }
    if (editing) return;
    const action = sheetKeyAction(event, input.platform);
    if (!action) return;
    if (!selection && grid && action.type !== "shortcuts") {
      select({ col: grid.displayCols[0] ?? 0, row: grid.displayRows[0] ?? 0 });
      if (action.type === "move") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (run(action)) {
      event.preventDefault();
      // The viewer steps files with the same keys; the grid keeps them.
      event.stopPropagation();
    }
  };

  const goTo = (text: string): boolean => {
    const parsed = parseCellRange(text.trim());
    if (!parsed) return false;
    setSelection({ anchor: parsed.start, focus: parsed.end });
    focusGrid();
    return true;
  };

  /** Stop editing without saving, as a tab switch or reload does. */
  const reset = () => {
    setEditing(null);
    setMenu(null);
  };

  return {
    store,
    editing,
    history,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    shortcutsOpen,
    setShortcutsOpen,
    menu,
    setMenu,
    scrollRef,
    commit,
    undo,
    redo,
    beginEdit,
    commitEdit,
    cancelEdit,
    onEditorAction,
    pick,
    pickHeader,
    openMenu,
    structure,
    toggle,
    align,
    fill,
    number,
    decimals,
    borders,
    newTab,
    renameTabAt,
    deleteTabAt,
    onGridKeyDown,
    goTo,
    reset,
    clearHistory: () => setHistory(EMPTY_SHEET_HISTORY),
    focusGrid,
  };
}
