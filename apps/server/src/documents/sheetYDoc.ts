// @effect-diagnostics nodeBuiltinImport:off -- The sidecar is opened without following links, which needs node:fs flags.
/**
 * The home machine's side of a live sheet: the plain file on one hand, the
 * merge document and its sidecar on the other.
 *
 * The file stays canonical. It is what Excel export, `sheet_read` and every
 * other tool read, and it is written exactly as before: the validated sheet,
 * serialized the one way. The merge state (which writer wrote what, so late
 * edits still merge) lives in a sidecar beside the file:
 *
 *   <folder>/.collab/<file name>.ylog      one JSON object per line
 *   <folder>/.collab/.gitignore            "*", so Git and the Library skip the folder
 *
 * The first line names the log's epoch; every other line is one merged update.
 * The file wins over the sidecar: when they disagree on open, the difference
 * is written into the merge document as one more change.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type SheetDocument,
  SHEET_LIMITS,
  parseSheetDocument,
  serializeSheetDocument,
  sheetContentRevision,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import {
  type SheetSnapshot,
  type SheetYDoc,
  applySheetUpdate,
  createSheetYDoc,
  encodeSheetState,
  readSheetYDoc,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  sheetYDocFrom,
  writeSheetChange,
} from "@specweave-studio/shared/sheetCollab";

export const SHEET_SIDECAR_DIR = ".collab";
const SIDECAR_SUFFIX = ".ylog";
const SIDECAR_VERSION = 1;
/** A log past either bound is rewritten as one line holding the whole state. */
export const SHEET_SIDECAR_MAX_LINES = 400;
export const SHEET_SIDECAR_MAX_BYTES = 8 * 1024 * 1024;

/** Who wrote a change that came from the file on disk rather than a session. */
export const FILE_ORIGIN = "file";

export function sheetSidecarPath(absoluteFilePath: string): string {
  return NodePath.join(
    NodePath.dirname(absoluteFilePath),
    SHEET_SIDECAR_DIR,
    `${NodePath.basename(absoluteFilePath)}${SIDECAR_SUFFIX}`,
  );
}

// ------------------------------------------------------------------ the file

export interface SheetFileState {
  readonly document: SheetDocument;
  readonly revision: string;
  /** The file started with a byte order mark; a write keeps it. */
  readonly byteOrderMark: boolean;
}

export type SheetFileRead =
  | { readonly ok: true; readonly file: SheetFileState }
  | { readonly ok: false; readonly error: string };

/** The sheet a file's text holds. Never throws. */
export function readSheetFileText(text: string): SheetFileRead {
  const plain = text.replace(/^﻿+/, "");
  const parsed = parseSheetDocument(plain);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    file: {
      document: parsed.document,
      revision: sheetContentRevision(text),
      byteOrderMark: plain.length !== text.length,
    },
  };
}

export type SheetFileText =
  | { readonly ok: true; readonly text: string; readonly document: SheetDocument }
  | { readonly ok: false; readonly error: string };

/**
 * The text to save for what the merge document holds, or why it may not be
 * saved. This is the check every change passes before it merges.
 */
export function sheetFileText(snapshot: SheetSnapshot): SheetFileText {
  const checked = validateSheetDocument(snapshot.document);
  if (!checked.ok) return { ok: false, error: checked.error };
  const text = serializeSheetDocument(checked.document);
  if (Buffer.byteLength(text, "utf8") > SHEET_LIMITS.bytes) {
    return {
      ok: false,
      error: `The sheet is over the ${SHEET_LIMITS.bytes / (1024 * 1024)} MB limit.`,
    };
  }
  return { ok: true, text, document: checked.document };
}

// ------------------------------------------------------------------ the sidecar log

export interface SheetSidecar {
  readonly epoch: string;
  readonly updates: ReadonlyArray<Uint8Array>;
  readonly lines: number;
}

/** A sidecar's text. A cut-off last line is skipped; anything else unreadable is null. */
export function parseSheetSidecar(text: string): SheetSidecar | null {
  const lines = text.split("\n");
  // A log always ends with a newline, so text after the last one is a line cut off mid-write.
  const complete = lines.slice(0, -1).filter((line) => line.length > 0);
  if (complete.length === 0) return null;
  const updates: Uint8Array[] = [];
  let epoch: string | null = null;
  for (const [index, line] of complete.entries()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof entry !== "object" || entry === null) return null;
    if (index === 0) {
      const header = entry as { v?: unknown; epoch?: unknown };
      if (header.v !== SIDECAR_VERSION || typeof header.epoch !== "string") return null;
      epoch = header.epoch;
      continue;
    }
    const update = (entry as { u?: unknown }).u;
    const bytes = typeof update === "string" ? sheetUpdateFromBase64(update) : null;
    if (bytes === null) return null;
    updates.push(bytes);
  }
  return epoch === null ? null : { epoch, updates, lines: complete.length };
}

export const sheetSidecarHeader = (epoch: string): string =>
  `${JSON.stringify({ v: SIDECAR_VERSION, epoch })}\n`;

export const sheetSidecarLine = (update: Uint8Array): string =>
  `${JSON.stringify({ u: sheetUpdateToBase64(update) })}\n`;

/** The whole log as its header and one update: what a rewrite puts on disk. */
export const compactSheetSidecar = (epoch: string, doc: SheetYDoc): string =>
  `${sheetSidecarHeader(epoch)}${sheetSidecarLine(encodeSheetState(doc))}`;

// ------------------------------------------------------------------ loading

export interface LoadedSheet {
  readonly doc: SheetYDoc;
  readonly epoch: string;
  /** The file's sheet, with the id each of its tabs has in the merge document. */
  readonly saved: SheetSnapshot;
  /** The merge state came from the sidecar rather than being started from the file. */
  readonly restored: boolean;
  /** Lines the sidecar holds; zero when it has to be written from scratch. */
  readonly sidecarLines: number;
}

/**
 * The merge document for a file. With a readable sidecar the document is the
 * sidecar's state, brought up to the file where the two differ; without one
 * it is started from the file under `newEpoch`.
 */
export function loadSheet(
  file: SheetDocument,
  sidecarText: string | null,
  newEpoch: string,
): LoadedSheet {
  const sidecar = sidecarText === null ? null : parseSheetSidecar(sidecarText);
  if (sidecar !== null) {
    const doc = createSheetYDoc();
    const applied = sidecar.updates.every((update) => applySheetUpdate(doc, update, "sidecar"));
    const held = readSheetYDoc(doc);
    if (applied && validateSheetDocument(held.document).ok) {
      // The file wins: what was changed in it since is one more change to merge.
      writeSheetChange(doc, held, file, FILE_ORIGIN);
      return {
        doc,
        epoch: sidecar.epoch,
        saved: fileSnapshot(doc, file),
        restored: true,
        sidecarLines: sidecar.lines,
      };
    }
  }
  const doc = sheetYDocFrom(file, FILE_ORIGIN);
  return { doc, epoch: newEpoch, saved: fileSnapshot(doc, file), restored: false, sidecarLines: 0 };
}

/**
 * The file's sheet as a snapshot: each tab paired, by name, with the id it has
 * in the merge document. A tab the document no longer holds gets an id nothing
 * answers to, so a later change to it in the file is left out.
 */
export function fileSnapshot(doc: SheetYDoc, file: SheetDocument): SheetSnapshot {
  const held = readSheetYDoc(doc);
  const ids = new Map<string, string>();
  held.document.tabs.forEach((tab, index) => {
    const key = tab.name.trim().toLowerCase();
    if (!ids.has(key)) ids.set(key, held.tabIds[index]!);
  });
  return {
    document: file,
    tabIds: file.tabs.map(
      (tab, index) => ids.get(tab.name.trim().toLowerCase()) ?? `gone-${index}`,
    ),
  };
}

// ------------------------------------------------------------------ sidecar files

/** The sidecar folder as a real directory, made on demand, with its own ignore file. */
async function sidecarFolder(sidecarPath: string, create: boolean): Promise<string | null> {
  const folder = NodePath.dirname(sidecarPath);
  let stat = await NodeFSP.lstat(folder).catch(() => null);
  if (stat === null && create) {
    await NodeFSP.mkdir(folder).catch(() => undefined);
    stat = await NodeFSP.lstat(folder).catch(() => null);
    if (stat?.isDirectory()) {
      // Git, and anything else that honours ignore files, skips the whole folder.
      await NodeFSP.writeFile(NodePath.join(folder, ".gitignore"), "*\n", { flag: "wx" }).catch(
        () => undefined,
      );
    }
  }
  // A link in place of the folder is never followed.
  return stat !== null && stat.isDirectory() && !stat.isSymbolicLink() ? folder : null;
}

const NO_FOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;

/** The sidecar's text, or null when there is none or it is not a plain file. */
export async function readSheetSidecar(sidecarPath: string): Promise<string | null> {
  if ((await sidecarFolder(sidecarPath, false)) === null) return null;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(sidecarPath, NodeFS.constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SHEET_SIDECAR_MAX_BYTES * 2) return null;
    return await handle.readFile("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Add lines to the sidecar. False when it could not be written; the session goes on without. */
export async function appendSheetSidecar(sidecarPath: string, text: string): Promise<boolean> {
  if ((await sidecarFolder(sidecarPath, true)) === null) return false;
  try {
    const handle = await NodeFSP.open(
      sidecarPath,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_APPEND | NodeFS.constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile()) return false;
      await handle.writeFile(text, "utf8");
      return true;
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

/** Replace the sidecar as a whole, through a temporary file renamed over it. */
export async function writeSheetSidecar(
  sidecarPath: string,
  text: string,
  temporaryName: string,
): Promise<boolean> {
  const folder = await sidecarFolder(sidecarPath, true);
  if (folder === null) return false;
  const temporary = NodePath.join(folder, temporaryName);
  try {
    const handle = await NodeFSP.open(
      temporary,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
    await NodeFSP.rename(temporary, sidecarPath);
    return true;
  } catch {
    await NodeFSP.unlink(temporary).catch(() => undefined);
    return false;
  }
}

/** Remove a document's sidecar, and the sidecar folder once it holds nothing else. */
export async function removeSheetSidecar(sidecarPath: string): Promise<void> {
  const folder = await sidecarFolder(sidecarPath, false);
  if (folder === null) return;
  await NodeFSP.unlink(sidecarPath).catch(() => undefined);
  const left = await NodeFSP.readdir(folder).catch(() => null);
  if (left !== null && left.every((name) => name === ".gitignore")) {
    await NodeFSP.unlink(NodePath.join(folder, ".gitignore")).catch(() => undefined);
    await NodeFSP.rmdir(folder).catch(() => undefined);
  }
}
