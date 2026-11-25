/**
 * A Sheet as a Yjs document, so two writers of one sheet merge instead of
 * overwriting each other. The file stays the plain Sheet JSON; this is the
 * shape its merge state takes while it is open.
 *
 *   sheet  Y.Map    title, designSystem
 *   order  Y.Array  tab ids, in display order
 *   tabs   Y.Map    tab id -> Y.Map { name, cells, formats, styles, charts, widths, p:* }
 *
 * Cells and widths merge key by key. Formats, styles and charts keep their
 * place in the file ("later entries win"), so each entry carries a sort key.
 * The remaining tab settings are whole values, where the last writer wins.
 *
 * Every edit, whoever makes it, is the difference between two Sheet documents
 * written as one transaction (`writeSheetChange`).
 */
import * as Y from "yjs";

import {
  SHEET_ARTIFACT_KIND,
  SHEET_ARTIFACT_VERSION,
  SHEET_LIMITS,
  type SheetCellInput,
  type SheetDocument,
  type SheetTab,
  parseCellAddress,
} from "../officeSheet/model.ts";

export type SheetYDoc = Y.Doc;

/** A Sheet read from a Yjs document, with the id each of its tabs has there. */
export interface SheetSnapshot {
  readonly document: SheetDocument;
  readonly tabIds: ReadonlyArray<string>;
}

interface Ordered {
  readonly v: unknown;
  readonly o: number;
}

const ORDERED_FIELDS = ["formats", "styles"] as const;
const PLAIN_FIELDS = ["chips", "columnOrder", "hiddenColumns", "rowGroups", "gridlines"] as const;
const plainKey = (field: (typeof PLAIN_FIELDS)[number]): string => `p:${field}`;

const same = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

function isOrdered(value: unknown): value is Ordered {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { o?: unknown }).o === "number" &&
    Number.isFinite((value as { o: number }).o) &&
    "v" in value
  );
}

function roots(doc: Y.Doc) {
  return {
    sheet: doc.getMap<unknown>("sheet"),
    order: doc.getArray<string>("order"),
    tabs: doc.getMap<Y.Map<unknown>>("tabs"),
  };
}

function childMap(tab: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const existing = tab.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<unknown>;
  const created = new Y.Map<unknown>();
  tab.set(key, created);
  return created;
}

function readChild(tab: Y.Map<unknown>, key: string): Y.Map<unknown> | null {
  const existing = tab.get(key);
  return existing instanceof Y.Map ? (existing as Y.Map<unknown>) : null;
}

// ------------------------------------------------------------------ writing

/** Key-by-key difference of two plain records. */
function writeRecord(
  target: Y.Map<unknown>,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): void {
  for (const key of Object.keys(before)) {
    if (!(key in after)) target.delete(key);
  }
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before) || !same(before[key], value)) target.set(key, value);
  }
}

/**
 * Difference of two ordered lists of entries. An entry that kept its place
 * keeps its sort key; one that is new, or moved, gets a key between its
 * neighbours. Entries someone else added meanwhile are left where they are.
 */
function writeOrdered(
  target: Y.Map<unknown>,
  before: ReadonlyArray<readonly [string, unknown]>,
  after: ReadonlyArray<readonly [string, unknown]>,
): void {
  const beforeValues = new Map(before);
  const afterKeys = new Set(after.map(([key]) => key));
  for (const key of beforeValues.keys()) {
    if (!afterKeys.has(key)) target.delete(key);
  }
  const placed = (key: string): Ordered | null => {
    const current = target.get(key);
    return beforeValues.has(key) && isOrdered(current) ? current : null;
  };
  const assigned: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < after.length; index += 1) {
    const [key, value] = after[index]!;
    const current = placed(key);
    if (current !== null && current.o > previous) {
      if (!same(current.v, value)) target.set(key, { v: value, o: current.o });
      previous = current.o;
      assigned.push(previous);
      continue;
    }
    // The nearest later entry that stays where it is bounds the new key from above.
    let next: number | undefined;
    for (let ahead = index + 1; ahead < after.length; ahead += 1) {
      const later = placed(after[ahead]![0]);
      if (later !== null && later.o > previous && (next === undefined || later.o < next)) {
        next = later.o;
      }
    }
    const order =
      previous === Number.NEGATIVE_INFINITY
        ? next === undefined
          ? 1
          : next - 1
        : next === undefined
          ? previous + 1
          : (previous + next) / 2;
    target.set(key, { v: value, o: order });
    previous = order;
    assigned.push(order);
  }
  // Out of room between two keys: number the whole list again.
  const increasing = assigned.every((order, index) => index === 0 || order > assigned[index - 1]!);
  if (!increasing) {
    after.forEach(([key, value], index) => target.set(key, { v: value, o: index + 1 }));
  }
}

const chartEntries = (tab: SheetTab | undefined): ReadonlyArray<readonly [string, unknown]> =>
  (tab?.charts ?? []).map((chart) => [chart.id, chart] as const);

const EMPTY_TAB: SheetTab = { name: "", cells: {} };

function writeTab(target: Y.Map<unknown>, before: SheetTab | undefined, after: SheetTab): void {
  const from = before ?? EMPTY_TAB;
  if (before === undefined || before.name !== after.name) target.set("name", after.name);
  writeRecord(childMap(target, "cells"), from.cells, after.cells);
  writeRecord(childMap(target, "widths"), from.widths ?? {}, after.widths ?? {});
  for (const field of ORDERED_FIELDS) {
    writeOrdered(
      childMap(target, field),
      Object.entries(from[field] ?? {}),
      Object.entries(after[field] ?? {}),
    );
  }
  writeOrdered(childMap(target, "charts"), chartEntries(before), chartEntries(after));
  for (const field of PLAIN_FIELDS) {
    const next = after[field];
    if (same(from[field], next)) continue;
    if (next === undefined) target.delete(plainKey(field));
    else target.set(plainKey(field), next);
  }
}

/** Pair each tab of `after` with the tab of `before` it continues, by name, then by place. */
function matchTabs(before: SheetSnapshot | null, after: SheetDocument): Array<number | null> {
  const beforeTabs = before?.document.tabs ?? [];
  const taken = new Set<number>();
  const matches: Array<number | null> = after.tabs.map((tab) => {
    const key = tab.name.trim().toLowerCase();
    const index = beforeTabs.findIndex(
      (candidate, at) => !taken.has(at) && candidate.name.trim().toLowerCase() === key,
    );
    if (index < 0) return null;
    taken.add(index);
    return index;
  });
  // A tab with a new name in the place of one that is gone was renamed.
  matches.forEach((match, index) => {
    if (match === null && index < beforeTabs.length && !taken.has(index)) {
      taken.add(index);
      matches[index] = index;
    }
  });
  return matches;
}

function newTabId(doc: Y.Doc, tabs: Y.Map<Y.Map<unknown>>, used: Set<string>): string {
  for (let count = tabs.size + used.size; ; count += 1) {
    const id = `t${doc.clientID.toString(36)}-${count.toString(36)}`;
    if (!tabs.has(id) && !used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

/**
 * Write the change from `before` to `after` into the document as one
 * transaction. `before` is what the writer started from: the document as it
 * read it, or the file as it was last saved. With no `before` the whole sheet
 * is written.
 */
export function writeSheetChange(
  doc: SheetYDoc,
  before: SheetSnapshot | null,
  after: SheetDocument,
  origin: unknown,
): void {
  const { sheet, order, tabs } = roots(doc);
  doc.transact(() => {
    if (before === null || before.document.title !== after.title) sheet.set("title", after.title);
    if (before === null || before.document.designSystem !== after.designSystem) {
      if (after.designSystem === undefined) sheet.delete("designSystem");
      else sheet.set("designSystem", after.designSystem);
    }
    const matches = matchTabs(before, after);
    const kept = new Set(matches.filter((match): match is number => match !== null));
    const removed = new Set<string>();
    before?.tabIds.forEach((id, index) => {
      if (!kept.has(index)) removed.add(id);
    });
    for (const id of removed) tabs.delete(id);
    for (let index = order.length - 1; index >= 0; index -= 1) {
      if (removed.has(order.get(index))) order.delete(index, 1);
    }

    const used = new Set<string>();
    const afterIds: string[] = [];
    const added = new Set<string>();
    after.tabs.forEach((tab, index) => {
      const match = matches[index] ?? null;
      if (match !== null) {
        const id = before!.tabIds[match]!;
        afterIds.push(id);
        const target = tabs.get(id);
        // A tab someone else deleted meanwhile stays deleted.
        if (target instanceof Y.Map) writeTab(target, before!.document.tabs[match], tab);
        return;
      }
      const id = newTabId(doc, tabs, used);
      const target = new Y.Map<unknown>();
      tabs.set(id, target);
      writeTab(target, undefined, tab);
      afterIds.push(id);
      added.add(id);
    });

    const keptBefore = (before?.tabIds ?? []).filter((id) => !removed.has(id));
    const keptAfter = afterIds.filter((id) => !added.has(id));
    if (!same(keptBefore, keptAfter)) {
      // The tabs were put in another order: write the order as a whole, and
      // keep tabs others added meanwhile at the end.
      const extra = order.toArray().filter((id) => !afterIds.includes(id));
      order.delete(0, order.length);
      order.insert(0, [...afterIds, ...extra]);
      return;
    }
    afterIds.forEach((id, index) => {
      if (!added.has(id)) return;
      const previous = index === 0 ? null : afterIds[index - 1]!;
      const at = previous === null ? -1 : order.toArray().indexOf(previous);
      order.insert(previous === null ? 0 : at < 0 ? order.length : at + 1, [id]);
    });
  }, origin);
}

// ------------------------------------------------------------------ reading

function compareCells(left: string, right: string): number {
  const a = parseCellAddress(left);
  const b = parseCellAddress(right);
  if (a === null || b === null) return left < right ? -1 : left > right ? 1 : 0;
  return a.row - b.row || a.col - b.col;
}

/** Keys the file already had keep their place; new ones follow in reading order. */
function readRecord(
  source: Y.Map<unknown> | null,
  hint: Readonly<Record<string, unknown>> | undefined,
  compare: (left: string, right: string) => number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (source === null) return result;
  const fresh: string[] = [];
  if (hint !== undefined) {
    for (const key of Object.keys(hint)) {
      if (source.has(key)) result[key] = source.get(key);
    }
  }
  for (const key of source.keys()) {
    if (!(key in result)) fresh.push(key);
  }
  for (const key of fresh.sort(compare)) result[key] = source.get(key);
  return result;
}

function readOrdered(source: Y.Map<unknown> | null): Array<readonly [string, unknown]> {
  if (source === null) return [];
  const entries: Array<readonly [string, Ordered]> = [];
  for (const [key, value] of source.entries()) {
    if (isOrdered(value)) entries.push([key, value]);
  }
  entries.sort((left, right) => left[1].o - right[1].o || (left[0] < right[0] ? -1 : 1));
  return entries.map(([key, value]) => [key, value.v] as const);
}

function readTab(source: Y.Map<unknown>, name: string, hint: SheetTab | undefined): SheetTab {
  const cells = readRecord(readChild(source, "cells"), hint?.cells, compareCells);
  const widths = readRecord(readChild(source, "widths"), hint?.widths, (left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const formats = Object.fromEntries(readOrdered(readChild(source, "formats")));
  const styles = Object.fromEntries(readOrdered(readChild(source, "styles")));
  const charts = readOrdered(readChild(source, "charts")).map(([, chart]) => chart);
  const plain = (field: (typeof PLAIN_FIELDS)[number]) => source.get(plainKey(field));
  // The same key order as a validated file, so an unchanged sheet reads byte for byte.
  return {
    name,
    cells: cells as Record<string, SheetCellInput>,
    ...(Object.keys(formats).length > 0 ? { formats } : {}),
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
    ...(plain("chips") !== undefined ? { chips: plain("chips") } : {}),
    ...(Object.keys(widths).length > 0 ? { widths } : {}),
    ...(plain("columnOrder") !== undefined ? { columnOrder: plain("columnOrder") } : {}),
    ...(plain("hiddenColumns") !== undefined ? { hiddenColumns: plain("hiddenColumns") } : {}),
    ...(plain("rowGroups") !== undefined ? { rowGroups: plain("rowGroups") } : {}),
    ...(charts.length > 0 ? { charts } : {}),
    ...(plain("gridlines") === false ? { gridlines: false } : {}),
  } as SheetTab;
}

/**
 * The Sheet a Yjs document holds. The result is what the writers produced
 * together and still has to pass `validateSheetDocument`. `hint` is the last
 * saved sheet: its cells keep their order in the file.
 */
export function readSheetYDoc(doc: SheetYDoc, hint?: SheetSnapshot | null): SheetSnapshot {
  const { sheet, order, tabs } = roots(doc);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of order.toArray()) {
    if (typeof id !== "string" || seen.has(id) || !(tabs.get(id) instanceof Y.Map)) continue;
    seen.add(id);
    ids.push(id);
  }
  // A tab written while another writer replaced the order is kept, at the end.
  for (const id of [...tabs.keys()].sort()) {
    if (!seen.has(id) && tabs.get(id) instanceof Y.Map) ids.push(id);
  }
  const hints = new Map<string, SheetTab>();
  hint?.tabIds.forEach((id, index) => {
    const tab = hint.document.tabs[index];
    if (tab !== undefined) hints.set(id, tab);
  });
  const names = new Set<string>();
  const title = sheet.get("title");
  const designSystem = sheet.get("designSystem");
  const document = {
    v: SHEET_ARTIFACT_VERSION,
    kind: SHEET_ARTIFACT_KIND,
    title: typeof title === "string" ? title : "",
    ...(typeof designSystem === "string" ? { designSystem } : {}),
    tabs: ids.map((id) => {
      const source = tabs.get(id)!;
      const raw = source.get("name");
      const base = typeof raw === "string" && raw.trim().length > 0 ? raw : "Sheet";
      // Two writers naming a tab alike at once: the later one in the order gets a number.
      let name = base;
      for (let count = 2; names.has(name.trim().toLowerCase()); count += 1) {
        const suffix = ` (${count})`;
        name = `${base.slice(0, SHEET_LIMITS.tabNameChars - suffix.length)}${suffix}`;
      }
      names.add(name.trim().toLowerCase());
      return readTab(source, name, hints.get(id));
    }),
  } as SheetDocument;
  return { document, tabIds: ids };
}

// ------------------------------------------------------------------ transport

export function createSheetYDoc(): SheetYDoc {
  return new Y.Doc();
}

/** A new document holding `document`. */
export function sheetYDocFrom(document: SheetDocument, origin: unknown = "seed"): SheetYDoc {
  const doc = createSheetYDoc();
  writeSheetChange(doc, null, document, origin);
  return doc;
}

export const encodeSheetState = (doc: SheetYDoc): Uint8Array => Y.encodeStateAsUpdate(doc);
export const encodeSheetStateVector = (doc: SheetYDoc): Uint8Array => Y.encodeStateVector(doc);

/** What `doc` holds that a document with `vector` does not; null when nothing. */
export function encodeSheetMissing(doc: SheetYDoc, vector: Uint8Array): Uint8Array | null {
  const update = Y.encodeStateAsUpdate(doc, vector);
  // An update with no structs and no deletions is two zero bytes.
  return update.length <= 2 ? null : update;
}

export function sheetStateVectorOf(update: Uint8Array): Uint8Array {
  return Y.encodeStateVectorFromUpdate(update);
}

/** Merge an update. False when the bytes are not an update; nothing is applied then. */
export function applySheetUpdate(doc: SheetYDoc, update: Uint8Array, origin: unknown): boolean {
  try {
    Y.applyUpdate(doc, update, origin);
    return true;
  } catch {
    return false;
  }
}

/** A copy of the document that can take an update the original has not seen. */
export function cloneSheetYDoc(doc: SheetYDoc): SheetYDoc {
  const copy = createSheetYDoc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), "clone");
  return copy;
}

/** Calls `listener` with every change to the document, as an update and its origin. */
export function onSheetUpdate(
  doc: SheetYDoc,
  listener: (update: Uint8Array, origin: unknown) => void,
): () => void {
  doc.on("update", listener);
  return () => doc.off("update", listener);
}

export interface SheetUndo {
  readonly undo: () => boolean;
  readonly redo: () => boolean;
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  readonly clear: () => void;
  readonly destroy: () => void;
}

/** Undo for one writer's own edits; what the others wrote stays. */
export function createSheetUndo(doc: SheetYDoc, origin: unknown): SheetUndo {
  const { sheet, order, tabs } = roots(doc);
  const manager = new Y.UndoManager([sheet, order, tabs], {
    trackedOrigins: new Set([origin]),
    captureTimeout: 0,
  });
  return {
    undo: () => manager.undo() !== null,
    redo: () => manager.redo() !== null,
    canUndo: () => manager.canUndo(),
    canRedo: () => manager.canRedo(),
    clear: () => manager.clear(),
    destroy: () => manager.destroy(),
  };
}

export function sheetUpdateToBase64(update: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < update.length; index += chunk) {
    binary += String.fromCharCode(...update.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Null when the text is not base64. */
export function sheetUpdateFromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ activity

/** What one merged change did, for the document's activity. */
export interface SheetChangeSummary {
  /** Cells whose input changed, across every tab. */
  readonly cells: number;
  /** The first changed cell, as "Tab!B2". */
  readonly first?: string;
  /** Whether anything but cell inputs changed (formats, charts, tabs, the title). */
  readonly layout: boolean;
}

export function summarizeSheetChange(
  before: SheetDocument,
  after: SheetDocument,
): SheetChangeSummary {
  let cells = 0;
  let first: string | undefined;
  let layout =
    before.title !== after.title ||
    before.designSystem !== after.designSystem ||
    before.tabs.length !== after.tabs.length;
  const beforeTabs = new Map(before.tabs.map((tab) => [tab.name.toLowerCase(), tab]));
  for (const tab of after.tabs) {
    const old = beforeTabs.get(tab.name.toLowerCase());
    if (old === undefined) layout = true;
    const from = old?.cells ?? {};
    for (const key of new Set([...Object.keys(from), ...Object.keys(tab.cells)])) {
      if (from[key] === tab.cells[key]) continue;
      cells += 1;
      first ??= `${tab.name}!${key}`;
    }
    if (old !== undefined) {
      const { cells: _a, ...restBefore } = old;
      const { cells: _b, ...restAfter } = tab;
      if (!same(restBefore, restAfter)) layout = true;
    }
  }
  return { cells, layout, ...(first === undefined ? {} : { first }) };
}
