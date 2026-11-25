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
 * The first line names the log's epoch. Every other line is one merged
 * update, or a mark: the revision the file had when it was last saved with
 * everything above the mark in it. An update is in the log before the window
 * that made it is answered, so updates below the last mark are changes the
 * file has not got yet, and a server that stopped in between finds them here.
 * Where the file was changed meanwhile, its change since the mark goes on top.
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
  encodeSheetMissing,
  encodeSheetState,
  onSheetUpdate,
  readSheetYDoc,
  sheetHasUnappliedUpdate,
  sheetSnapshotByName,
  sheetStateVectorOf,
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

export type SheetSidecarEntry =
  | { readonly update: Uint8Array }
  /** The file was saved, at this revision, holding every update above. */
  | { readonly saved: string };

export interface SheetSidecar {
  readonly epoch: string;
  readonly entries: ReadonlyArray<SheetSidecarEntry>;
  readonly lines: number;
}

/** A sidecar's text. A cut-off last line is skipped; anything else unreadable is null. */
export function parseSheetSidecar(text: string): SheetSidecar | null {
  const lines = text.split("\n");
  // A log always ends with a newline, so text after the last one is a line cut off mid-write.
  const complete = lines.slice(0, -1).filter((line) => line.length > 0);
  if (complete.length === 0) return null;
  const entries: SheetSidecarEntry[] = [];
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
    const { u: update, s: saved } = entry as { u?: unknown; s?: unknown };
    if (typeof saved === "string") {
      entries.push({ saved });
      continue;
    }
    const bytes = typeof update === "string" ? sheetUpdateFromBase64(update) : null;
    if (bytes === null) return null;
    entries.push({ update: bytes });
  }
  return epoch === null ? null : { epoch, entries, lines: complete.length };
}

export const sheetSidecarHeader = (epoch: string): string =>
  `${JSON.stringify({ v: SIDECAR_VERSION, epoch })}\n`;

/** The line that says the file, at `revision`, holds every update above it. */
export const sheetSidecarMark = (revision: string): string =>
  `${JSON.stringify({ s: revision })}\n`;

export const sheetSidecarLine = (update: Uint8Array): string =>
  `${JSON.stringify({ u: sheetUpdateToBase64(update) })}\n`;

/**
 * The whole log as its header and one update: what a rewrite puts on disk.
 * `savedRevision` is given when the file, at that revision, reads as the document does.
 */
export const compactSheetSidecar = (
  epoch: string,
  doc: SheetYDoc,
  savedRevision?: string,
): string =>
  `${sheetSidecarHeader(epoch)}${sheetSidecarLine(encodeSheetState(doc))}${
    savedRevision === undefined ? "" : sheetSidecarMark(savedRevision)
  }`;

// ------------------------------------------------------------------ loading

/** A saved state of the file as the log knows it: what kept edits are told apart from. */
export interface SheetSidecarBase {
  readonly revision: string;
  readonly state: Uint8Array;
}

/**
 * The log of a sheet whose file is behind: the document as the file last had
 * it, the mark saying so, and everything since as one update. This is how a
 * log that grew long while the file could not be written is made short again
 * without losing which edits are still to be saved.
 */
export const unsavedSheetSidecar = (
  epoch: string,
  base: SheetSidecarBase,
  doc: SheetYDoc,
): string => {
  const since = encodeSheetMissing(doc, sheetStateVectorOf(base.state));
  return `${sheetSidecarHeader(epoch)}${sheetSidecarLine(base.state)}${sheetSidecarMark(base.revision)}${
    since === null ? "" : sheetSidecarLine(since)
  }`;
};

export interface LoadedSheet {
  readonly doc: SheetYDoc;
  readonly epoch: string;
  /** The file's sheet, with the id each of its tabs has in the merge document. */
  readonly saved: SheetSnapshot;
  /** The merge state came from the sidecar rather than being started from the file. */
  readonly restored: boolean;
  /** Lines the sidecar holds; zero when it has to be written from scratch. */
  readonly sidecarLines: number;
  /** The revision the sidecar's last line marks as saved; null when its last line is not a mark. */
  readonly marked: string | null;
  /** The log's last mark: the revision the file had, and the document as it was then. */
  readonly base: SheetSidecarBase | null;
  /** Changes made to the document while loading (the file's), still to be added to the log. */
  readonly pending: ReadonlyArray<Uint8Array>;
  /** The document holds changes the file never got, kept from a save that did not happen. */
  readonly unsaved: boolean;
}

/**
 * The merge document for a file. With a readable sidecar the document is the
 * sidecar's state, brought up to the file where the two differ; without one
 * it is started from the file under `newEpoch`.
 *
 * Updates below the sidecar's last mark never reached the file. They stand:
 * with the file as the mark left it they are saved as they are, and with a
 * file changed since, what changed in the file from the marked state goes on
 * top of them, so both sides' edits to different cells are kept.
 */
export function loadSheet(
  file: SheetDocument,
  sidecarText: string | null,
  newEpoch: string,
  fileRevision?: string,
): LoadedSheet {
  const sidecar = sidecarText === null ? null : parseSheetSidecar(sidecarText);
  const restored = sidecar === null ? null : restoreSheet(file, sidecar, fileRevision);
  if (restored !== null) return restored;
  const doc = sheetYDocFrom(file, FILE_ORIGIN);
  return {
    doc,
    epoch: newEpoch,
    saved: fileSnapshot(doc, file),
    restored: false,
    sidecarLines: 0,
    marked: null,
    base: null,
    pending: [],
    unsaved: false,
  };
}

function restoreSheet(
  file: SheetDocument,
  sidecar: SheetSidecar,
  fileRevision: string | undefined,
): LoadedSheet | null {
  const doc = createSheetYDoc();
  /** The document as the file last held it, and how many updates came after. */
  let marked: {
    readonly revision: string;
    readonly snapshot: SheetSnapshot;
    readonly state: Uint8Array;
  } | null = null;
  let after = 0;
  const lastMark = sidecar.entries.findLastIndex((entry) => "saved" in entry);
  for (const [index, entry] of sidecar.entries.entries()) {
    if ("saved" in entry) {
      // Only the last mark is ever used: the others are passed over.
      if (index === lastMark) {
        marked = {
          revision: entry.saved,
          snapshot: readSheetYDoc(doc),
          state: encodeSheetState(doc),
        };
      }
      after = 0;
    } else {
      if (!applySheetUpdate(doc, entry.update, "sidecar")) return null;
      after += 1;
    }
  }
  const held = readSheetYDoc(doc);
  if (sheetHasUnappliedUpdate(doc) || !validateSheetDocument(held.document).ok) return null;
  const kept = marked !== null && after > 0 && validateSheetDocument(marked.snapshot.document).ok;
  if (kept && marked!.revision === fileRevision) {
    return {
      doc,
      epoch: sidecar.epoch,
      saved: fileSnapshot(doc, file),
      restored: true,
      sidecarLines: sidecar.lines,
      marked: null,
      base: { revision: marked!.revision, state: marked!.state },
      pending: [],
      unsaved: true,
    };
  }
  // The file's side: against the marked state when edits were kept, else against all the log holds.
  const pending: Uint8Array[] = [];
  const stop = onSheetUpdate(doc, (update) => pending.push(update));
  writeSheetChange(doc, kept ? marked!.snapshot : held, file, FILE_ORIGIN);
  stop();
  const merged = readSheetYDoc(doc);
  const checked = validateSheetDocument(merged.document);
  if (!checked.ok) return null;
  const unsaved = kept && serializeSheetDocument(checked.document) !== serializeSheetDocument(file);
  return {
    doc,
    epoch: sidecar.epoch,
    saved: fileSnapshot(doc, file),
    restored: true,
    sidecarLines: sidecar.lines,
    marked:
      pending.length === 0 && after === 0 && marked !== null && fileRevision !== undefined
        ? marked.revision
        : null,
    // Kept edits stay told apart from the state they were made on until they are saved, and
    // a log that ends in a mark of the file as it is has that state to start a short log from.
    base:
      marked !== null &&
      (kept || (after === 0 && pending.length === 0 && marked.revision === fileRevision))
        ? { revision: marked.revision, state: marked.state }
        : null,
    pending,
    unsaved,
  };
}

/** The file's sheet as a snapshot of the merge document: its tabs paired with theirs by name. */
export const fileSnapshot = sheetSnapshotByName;

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

/**
 * Cut off a last line that was never finished (the server stopped while
 * writing it), so the next line added does not run into it and make the whole
 * log unreadable.
 */
async function trimTornSidecar(sidecarPath: string): Promise<boolean> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(sidecarPath, NodeFS.constants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    // No log yet is fine. A log that cannot be looked at is not added to: a line
    // run into a cut-off one would make all of it unreadable.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    if (stat.size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, stat.size - 1);
    if (last[0] === 0x0a) return true;
    const whole = await handle.readFile();
    await handle.truncate(whole.lastIndexOf(0x0a) + 1);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Move a sidecar to stand beside a document that was renamed in its folder.
 * A sidecar already there (the document was opened under its new name
 * meanwhile) is never replaced: false then, and the old one stays.
 */
export async function moveSheetSidecar(from: string, to: string): Promise<boolean> {
  if ((await sidecarFolder(from, false)) === null) return false;
  try {
    // A hard link fails where the name is taken, which a rename would silently replace.
    await NodeFSP.link(from, to);
  } catch {
    return false;
  }
  await NodeFSP.unlink(from).catch(() => undefined);
  return true;
}

/** Add lines to the sidecar. False when it could not be written. */
export async function appendSheetSidecar(sidecarPath: string, text: string): Promise<boolean> {
  if ((await sidecarFolder(sidecarPath, true)) === null) return false;
  if (!(await trimTornSidecar(sidecarPath))) return false;
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

/**
 * Remove the sidecars in a folder whose documents are gone: a sheet deleted
 * while nobody had it open leaves its merge state behind otherwise.
 */
export async function sweepSheetSidecars(documentFolder: string): Promise<void> {
  const folder = await sidecarFolder(NodePath.join(documentFolder, SHEET_SIDECAR_DIR, "x"), false);
  if (folder === null) return;
  const names = await NodeFSP.readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const document = NodePath.join(documentFolder, name.slice(0, -SIDECAR_SUFFIX.length));
    const gone = await NodeFSP.lstat(document).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    if (gone) await removeSheetSidecar(NodePath.join(folder, name));
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
