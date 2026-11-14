// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over the project's SpecWeave folder, like ProjectLibrary.
/**
 * Saves a thread's long report as markdown next to the SpecWeave increment
 * it belongs to (`.specweave/increments/<id>/reports/`), or under
 * `.specweave/reports/threads/` when no increment matches. File names end
 * with the report's key, so a report is saved once and found again without
 * an index file.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";

import type {
  ProjectThreadReport,
  ProjectThreadReportsSnapshot,
} from "@specweave-studio/contracts";
import {
  FRONTMATTER,
  MAX_SAVED_REPORT_BYTES,
  reportFileName,
  reportIncrementCandidates,
  reportKey,
  reportKeyFromFileName,
  reportThreadKey,
  reportTitle,
  type ReportIncrementCandidate,
} from "@specweave-studio/shared/threadReport";
import { compareIncrementFolders } from "@specweave-studio/shared/specweaveIncrement";

import { specweaveStudioCheckpointPath } from "../orchestration-v2/SpecweaveCheckpoint.ts";
import { ProjectLibraryProblem } from "./ProjectLibrary.ts";

export const INCREMENTS_DIR = ".specweave/increments";
export const THREAD_REPORTS_DIR = ".specweave/reports/threads";
/** `0973-budget`, past 9999 `10001-export`, and SpecWeave's lettered `0657E-followup`. */
const INCREMENT_FOLDER = /^\d{4,}[A-Z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const INCREMENT_NUMBER = /^\d{4,}$/;
/** Increment `reports/` folders listed at once while looking for a thread's reports. */
const REPORT_FOLDER_CONCURRENCY = 16;

export interface ThreadReportSource {
  readonly threadId: string;
  readonly title: string | null;
  readonly branch: string | null;
  /** Home directory holding SpecWeave's per-thread checkpoint pointers; tests override it. */
  readonly home?: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function posix(relative: string): string {
  return relative.split(NodePath.sep).join("/");
}

/** A directory inside the project, refusing symlinks that lead out of it. */
async function directoryWithin(root: string, relative: string): Promise<string | null> {
  const candidate = NodePath.resolve(root, relative);
  if (!inside(root, candidate)) return null;
  try {
    const real = await NodeFSP.realpath(candidate);
    if (!inside(await NodeFSP.realpath(root), real)) return null;
    return (await NodeFSP.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function specweaveFolder(root: string): Promise<boolean> {
  const stat = await NodeFSP.lstat(NodePath.join(root, ".specweave")).catch(() => null);
  return stat !== null && stat.isDirectory() && !stat.isSymbolicLink();
}

/** The increments folder (resolved, inside the project) and its increment folders, oldest first. */
async function incrementListing(root: string): Promise<{ dir: string | null; folders: string[] }> {
  const dir = await directoryWithin(root, INCREMENTS_DIR);
  if (dir === null) return { dir, folders: [] };
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    dir,
    folders: entries
      .filter((entry) => entry.isDirectory() && INCREMENT_FOLDER.test(entry.name))
      .map((entry) => entry.name)
      .toSorted(compareIncrementFolders),
  };
}

async function incrementFolders(root: string): Promise<string[]> {
  return (await incrementListing(root)).folders;
}

/** Maps `items` with at most `limit` calls in flight, keeping their order. */
async function mapLimited<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The increment SpecWeave's own hooks recorded for this Studio thread, if any. */
async function checkpointIncrement(threadId: string, home?: string): Promise<string | null> {
  try {
    const text = await NodeFSP.readFile(specweaveStudioCheckpointPath(threadId, home), "utf8");
    const value = (JSON.parse(text) as { incrementId?: unknown }).incrementId;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function matchIncrement(
  folders: ReadonlyArray<string>,
  candidates: ReadonlyArray<ReportIncrementCandidate>,
): string | null {
  const byNumber = (number: string) => {
    const prefix = `${number.toLowerCase()}-`;
    const matches = folders.filter((folder) => folder.toLowerCase().startsWith(prefix));
    // A number shared by two folders is ambiguous; never guess between them.
    return matches.length === 1 ? matches[0]! : null;
  };
  for (const candidate of candidates) {
    if (candidate.kind === "number") {
      const match = byNumber(candidate.value);
      if (match !== null) return match;
      continue;
    }
    const value = candidate.value.toLowerCase();
    const exact = folders.find((folder) => folder.toLowerCase() === value);
    if (exact !== undefined) return exact;
    // A branch such as `inc/0974-export-fix` extends its increment's folder name.
    const extended = folders
      .filter((folder) => value.startsWith(`${folder.toLowerCase()}-`))
      .toSorted((left, right) => right.length - left.length)[0];
    if (extended !== undefined) return extended;
    if (candidate.fromText) continue;
    const leading = /^\d{4,}[a-z]?(?=-)/.exec(value)?.[0];
    const numbered = leading === undefined ? null : byNumber(leading);
    if (numbered !== null) return numbered;
  }
  return null;
}

/**
 * The increment a thread works on: SpecWeave's checkpoint for the thread
 * first, then increment numbers or folders in its title and branch, then
 * (when saving) increment folders the report names. Only folders that exist
 * count, so a stray number never invents an increment.
 */
export async function resolveReportIncrement(
  workspaceRoot: string,
  source: ThreadReportSource,
  text = "",
): Promise<string | null> {
  const root = NodePath.resolve(workspaceRoot);
  const folders = await incrementFolders(root);
  if (folders.length === 0) return null;
  const recorded = await checkpointIncrement(source.threadId, source.home);
  const candidates: ReportIncrementCandidate[] = [];
  if (recorded !== null) {
    // A recorded folder must exist here; another repo's `0042-foo` never maps onto a local `0042-*`.
    candidates.push(
      INCREMENT_NUMBER.test(recorded)
        ? { kind: "number", value: recorded }
        : { kind: "folder", value: recorded.toLowerCase(), fromText: true },
    );
  }
  candidates.push(
    ...reportIncrementCandidates({ title: source.title, branch: source.branch, text }),
  );
  return matchIncrement(folders, candidates);
}

/** The `thread:` front-matter value of a saved report, read from its head only. */
async function savedThreadId(file: string): Promise<string | null> {
  const handle = await NodeFSP.open(file, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const line = /^thread: (.+)$/m.exec(head)?.[1];
    if (line === undefined) return null;
    const value: unknown = JSON.parse(line);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Whether a file name is a saved report of the thread with this key. */
function isThreadReportName(name: string, threadKey: string): boolean {
  return reportKeyFromFileName(name)?.startsWith(`${threadKey}-`) === true;
}

async function reportsIn(root: string, relativeDir: string, threadKey: string, threadId: string) {
  const dir = await directoryWithin(root, relativeDir);
  if (dir === null) return [];
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: Array<ProjectThreadReport & { readonly mtime: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const key = reportKeyFromFileName(entry.name);
    if (key === null || !key.startsWith(`${threadKey}-`)) continue;
    const file = NodePath.join(dir, entry.name);
    // The key is short; the front matter says whose report it really is.
    if ((await savedThreadId(file)) !== threadId) continue;
    const stat = await NodeFSP.stat(file).catch(() => null);
    if (stat === null) continue;
    found.push({
      key,
      path: posix(NodePath.join(relativeDir, entry.name)),
      savedAt: stat.mtime.toISOString(),
      mtime: stat.mtimeMs,
    });
  }
  return found;
}

function snapshot(
  root: string,
  specweave: boolean,
  increment: string | null,
  reports: ReadonlyArray<ProjectThreadReport>,
): ProjectThreadReportsSnapshot {
  return {
    workspaceRoot: root,
    specweave,
    increment:
      increment === null ? null : { id: increment, path: `${INCREMENTS_DIR}/${increment}` },
    folder: !specweave
      ? null
      : increment === null
        ? THREAD_REPORTS_DIR
        : `${INCREMENTS_DIR}/${increment}/reports`,
    reports,
  };
}

/** Every saved report of this thread, newest first, and where the next one goes. */
export async function readThreadReports(
  workspaceRoot: string,
  source: ThreadReportSource,
): Promise<ProjectThreadReportsSnapshot> {
  const root = NodePath.resolve(workspaceRoot);
  if (!(await specweaveFolder(root))) return snapshot(root, false, null, []);
  const threadKey = reportThreadKey(source.threadId);
  const { dir: increments, folders } = await incrementListing(root);
  // One cheap listing per increment, a few at a time; only a `reports/` folder
  // that holds this thread's file names gets the symlink checks and file reads.
  const holding =
    increments === null
      ? []
      : (
          await mapLimited(folders, REPORT_FOLDER_CONCURRENCY, async (folder) => {
            const names = await NodeFSP.readdir(NodePath.join(increments, folder, "reports")).catch(
              (): string[] => [],
            );
            return names.some((name) => isThreadReportName(name, threadKey)) ? [folder] : [];
          })
        ).flat();
  const found = (
    await Promise.all([
      ...holding.map((folder) =>
        reportsIn(root, `${INCREMENTS_DIR}/${folder}/reports`, threadKey, source.threadId),
      ),
      reportsIn(root, THREAD_REPORTS_DIR, threadKey, source.threadId),
    ])
  )
    .flat()
    .toSorted((left, right) => right.mtime - left.mtime);
  // A report already saved in an increment keeps the thread there.
  const savedIn = found
    .map((report) => /^\.specweave\/increments\/([^/]+)\/reports\//.exec(report.path)?.[1])
    .find((folder) => folder !== undefined);
  const increment = savedIn ?? (await resolveReportIncrement(root, source));
  return snapshot(
    root,
    true,
    increment,
    found.map(({ mtime: _mtime, ...report }) => report),
  );
}

/**
 * Creates `relative` under the project one segment at a time, refusing any
 * segment that is a symlink or not a directory, so nothing is ever created
 * outside the project through a link.
 */
async function ensureDirectoryWithin(root: string, relative: string): Promise<string> {
  let current = await NodeFSP.realpath(root);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new ProjectLibraryProblem("invalid", "Bad report folder.");
    }
    current = NodePath.join(current, segment);
    const stat = await NodeFSP.lstat(current).catch(() => null);
    if (stat === null) {
      await NodeFSP.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectLibraryProblem("invalid", `${relative} leads outside the project.`);
    }
  }
  return current;
}

/**
 * Every character a line-based reader takes as a line break. JavaScript's `m`
 * flag breaks at U+2028 and U+2029 too, and `JSON.stringify` leaves them raw.
 */
const LINE_BREAKS = /[\r\n\u2028\u2029\u0085]+/g;

function frontMatterValue(value: string): string {
  return JSON.stringify(value.replace(LINE_BREAKS, " "));
}

/** Where a document another tool made came from, kept as properties of the saved report. */
export interface ReportProvenance {
  /** The tool or app that made it: "Claude desktop", "Codex", "Cursor". */
  readonly source: string;
  /** Its https link there; the reply links the saved file, never this. */
  readonly original?: string | undefined;
}

export interface SaveReportOptions {
  /**
   * Also match increment folders the report names. Off for a person's save,
   * so the file lands where the card said it would.
   */
  readonly resolveFromText?: boolean;
  /** The title to file it under; otherwise the report's own title or heading. */
  readonly title?: string | undefined;
  /** An increment number or folder to save in, or "none" for the project's thread reports. */
  readonly increment?: string | undefined;
  readonly provenance?: ReportProvenance | undefined;
}

export interface SavedReport {
  readonly snapshot: ProjectThreadReportsSnapshot;
  readonly report: ProjectThreadReport;
  /** The title it is filed under, as its front matter says. */
  readonly title: string;
  /** The same text was saved before; `report` is that copy. */
  readonly alreadySaved: boolean;
  /** The saved file on this machine. */
  readonly absolutePath: string;
}

/**
 * The front-matter keys the app writes, lowercase; the same keys in the
 * text's own block give way whatever their case or quotes.
 */
const SAVED_KEYS = new Set([
  "title",
  "thread",
  "threadtitle",
  "increment",
  "savedat",
  "source",
  "original",
]);

/** A top-level `key:` line, the key bare or quoted. */
const KEY_LINE = /^(["']?)([A-Za-z][\w-]*)\1\s*:(\s|$)/;
/** A list item or an indented line: part of the value above it. */
const CONTINUATION = /^(\s|-(\s|$))/;

/**
 * The text's own front matter (a report written with flat front matter) and
 * the body after it. Lines for keys the app writes are dropped, with the list
 * items under them, so the saved file has one front-matter block.
 */
function ownFrontMatter(text: string): { readonly lines: string[]; readonly body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { lines: [], body: text };
  const block = match[1]!.split("\n").map((line) => line.replace(LINE_BREAKS, " "));
  // A document that opens with a horizontal rule has prose between its rules,
  // not properties; it stays whole.
  // It must name at least one property, so a block of list items or links stays prose too.
  const properties =
    block.some((line) => KEY_LINE.test(line)) &&
    block.every(
      (line) => line.trim().length === 0 || KEY_LINE.test(line) || CONTINUATION.test(line),
    );
  if (!properties) return { lines: [], body: text };
  const lines: string[] = [];
  let dropping = false;
  for (const line of block) {
    const found = KEY_LINE.exec(line);
    if (found !== null) dropping = SAVED_KEYS.has(found[2]!.toLowerCase());
    // The viewer reads bare keys only, so a quoted key is written bare.
    const kept =
      found !== null && found[1] !== "" ? `${found[2]}${line.slice(line.indexOf(":"))}` : line;
    if (!dropping && line.trim().length > 0) lines.push(kept);
  }
  return { lines, body: text.slice(match[0].length).trim() };
}

/** macOS 11 and later: the open fails when any component of the path is a link. */
const O_NOFOLLOW_ANY = 0x2000_0000;
/** Windows has no O_NOFOLLOW; the checks around the open cover it there. */
const NO_FOLLOW =
  (NodeFS.constants.O_NOFOLLOW ?? 0) | (process.platform === "darwin" ? O_NOFOLLOW_ANY : 0);

function leadsOutside(relativePath: string): ProjectLibraryProblem {
  return new ProjectLibraryProblem("invalid", `${relativePath} leads outside the project.`);
}

/**
 * Opens a file of the project by a path from its real root that holds no link
 * anywhere, and only when it is one regular file there: a link at its name or
 * in a folder above it, or a second name for a file elsewhere, is never read
 * or written through. macOS refuses a link in any component as it opens; on
 * Linux the kernel's record of the opened file must be that path; everywhere
 * the opened file must be the one found at that path with no link on the
 * way, before (when it exists) and after the open.
 */
async function openInside(
  realRoot: string,
  relativePath: string,
  flags: number,
): Promise<NodeFSP.FileHandle> {
  const expected = NodePath.join(realRoot, ...relativePath.split("/"));
  const creating = (flags & NodeFS.constants.O_CREAT) !== 0;
  const before = creating ? null : await NodeFSP.lstat(expected, { bigint: true });
  if (before !== null && !before.isFile()) throw leadsOutside(relativePath);
  const handle = await NodeFSP.open(expected, flags | NO_FOLLOW, 0o644);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw leadsOutside(relativePath);
    if (before !== null && (before.dev !== opened.dev || before.ino !== opened.ino)) {
      throw leadsOutside(relativePath);
    }
    if (process.platform === "linux") {
      const actual = await NodeFSP.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
      if (actual !== null && actual !== expected) throw leadsOutside(relativePath);
    }
    const real = await NodeFSP.realpath(expected).catch(() => null);
    const named = await NodeFSP.lstat(expected, { bigint: true }).catch(() => null);
    if (
      real !== expected ||
      named === null ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      throw leadsOutside(relativePath);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Writes all of it from the start of the file: one write may take only part. */
async function writeAll(handle: NodeFSP.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("The report could not be written.");
    offset += bytesWritten;
  }
}

interface StoredReport {
  readonly title: string | null | undefined;
  readonly thread: string | null | undefined;
  readonly source: string | null | undefined;
  readonly original: string | null | undefined;
  readonly body: string;
  readonly content: string;
  readonly blockEnd: number;
}

/**
 * A flat front-matter string: JSON or single quoted, or bare. Undefined when
 * the key is absent, null when its value is not a plain string.
 */
function storedValue(block: string, key: string): string | null | undefined {
  const found = new RegExp(`^${key}[ \\t]*:(.*)$`, "im").exec(block);
  if (found === null) return undefined;
  const raw = found[1]!.trim();
  if (raw.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'")) {
    return raw.length >= 2 && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : null;
  }
  const bare = raw.replace(/\s+#.*$/, "").trim();
  return bare.length === 0 || /^[[{|>&*!%@`]/.test(bare) ? null : bare;
}

function parseStoredReport(content: string): StoredReport {
  const match = FRONTMATTER.exec(content);
  const block = match?.[1] ?? "";
  return {
    title: storedValue(block, "title"),
    thread: storedValue(block, "thread"),
    source: storedValue(block, "source"),
    original: storedValue(block, "original"),
    body: match ? content.slice(match[0].length) : content,
    content,
    // Where the closing rule starts, for properties added later.
    blockEnd: match && content.startsWith("---\n") ? 4 + block.length : -1,
  };
}

function sameLink(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

/** The same text: line endings and the blank lines around it aside. Indentation counts. */
function sameBody(left: string, right: string): boolean {
  return left.replace(/\r\n?/g, "\n").trim() === right.replace(/\r\n?/g, "\n").trim();
}

/**
 * The provenance lines a saved copy of the same text lacks, each added on
 * its own. A copy that records another source or original, or one that
 * cannot be read, is refused, so neither origin is lost.
 */
function missingProvenance(
  stored: StoredReport,
  provenance: ReportProvenance,
  relativePath: string,
): string[] {
  const conflict = (recorded: string | null) =>
    new ProjectLibraryProblem(
      "conflict",
      `This text is already saved at ${relativePath} from ${recorded ?? "an origin that cannot be read"}. Link that report.`,
    );
  const lines: string[] = [];
  if (stored.source === undefined) lines.push(`source: ${frontMatterValue(provenance.source)}`);
  else if (stored.source !== provenance.source) throw conflict(stored.source);
  if (provenance.original !== undefined) {
    if (stored.original === undefined) {
      lines.push(`original: ${frontMatterValue(provenance.original)}`);
    } else if (stored.original === null || !sameLink(stored.original, provenance.original)) {
      throw conflict(stored.original);
    }
  }
  if (lines.length > 0 && stored.blockEnd <= 0) throw conflict(null);
  return lines;
}

/**
 * Adds provenance lines to a saved report through a second, writable handle
 * on the same file, and only while it still holds what was read. A report
 * that is only read needs no write access, so a read-only copy is still found.
 */
async function addProvenance(
  realRoot: string,
  relativePath: string,
  reader: NodeFSP.FileHandle,
  stored: StoredReport,
  lines: ReadonlyArray<string>,
): Promise<void> {
  const writer = await openInside(realRoot, relativePath, NodeFS.constants.O_RDWR).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw new ProjectLibraryProblem(
          "conflict",
          `This text is already saved at ${relativePath}, which is read-only, so its source was not added. Link that report.`,
        );
      }
      throw error;
    },
  );
  try {
    const [read, write] = await Promise.all([
      reader.stat({ bigint: true }),
      writer.stat({ bigint: true }),
    ]);
    if (read.dev !== write.dev || read.ino !== write.ino) throw leadsOutside(relativePath);
    if ((await writer.readFile("utf8")) !== stored.content) {
      throw new ProjectLibraryProblem(
        "conflict",
        `${relativePath} changed while this save read it. Save again.`,
      );
    }
    const updated = Buffer.from(
      `${stored.content.slice(0, stored.blockEnd)}\n${lines.join("\n")}${stored.content.slice(stored.blockEnd)}`,
      "utf8",
    );
    await writeAll(writer, updated);
    await writer.truncate(updated.length);
  } finally {
    await writer.close();
  }
}

/**
 * Saves of the same text by one thread run one at a time in this server, so
 * the second finds the first whatever title either gave it.
 */
const savesInFlight = new Map<string, Promise<void>>();

async function oneSaveAtATime<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const previous = savesInFlight.get(lock) ?? Promise.resolve();
  const current = previous.then(run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  savesInFlight.set(lock, settled);
  try {
    return await current;
  } finally {
    if (savesInFlight.get(lock) === settled) savesInFlight.delete(lock);
  }
}

/** The provenance as it is written: one-line source, normalized https link. */
function checkedProvenance(provenance: ReportProvenance): ReportProvenance {
  const source = provenance.source.trim();
  if (source.length === 0 || source.length > 60 || /[\r\n\u2028\u2029\u0085]/.test(source)) {
    throw new ProjectLibraryProblem(
      "invalid",
      "The source names the tool that made the document in at most 60 characters.",
    );
  }
  if (provenance.original === undefined) return { source };
  const refused = new ProjectLibraryProblem(
    "invalid",
    "The original link must be an https URL of at most 2048 characters.",
  );
  let url: URL;
  try {
    url = new URL(provenance.original);
  } catch {
    throw refused;
  }
  // href percent-encodes what the URL holds, so no character in it breaks a line.
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) {
    throw refused;
  }
  return { source, original: url.href };
}

/** An increment named by number (`1314`) or folder, among the folders that exist here. */
async function namedIncrement(root: string, name: string): Promise<string> {
  const value = name.trim().toLowerCase();
  const folders = await incrementFolders(root);
  const match = /^\d{4,}[a-z]?$/.test(value)
    ? folders.filter((folder) => folder.toLowerCase().startsWith(`${value}-`))
    : folders.filter((folder) => folder.toLowerCase() === value);
  // A number shared by two folders is ambiguous; never guess between them.
  if (match.length !== 1) {
    throw new ProjectLibraryProblem(
      "invalid",
      match.length === 0
        ? `No increment ${name.trim()} in this project.`
        : `Increment ${name.trim()} matches ${match.length} folders; name the folder.`,
    );
  }
  return match[0]!;
}

/**
 * Saves the report once and says where. Saving the same text again returns
 * the copy that is already there, wherever it was saved.
 */
export async function saveReport(
  workspaceRoot: string,
  source: ThreadReportSource,
  text: string,
  now: Date = new Date(),
  options: SaveReportOptions = {},
): Promise<SavedReport> {
  const root = NodePath.resolve(workspaceRoot);
  const normalizedText = text.replace(/\r\n?/g, "\n").trim();
  if (normalizedText.length === 0)
    throw new ProjectLibraryProblem("invalid", "The report is empty.");
  if (Buffer.byteLength(normalizedText, "utf8") > MAX_SAVED_REPORT_BYTES) {
    throw new ProjectLibraryProblem("invalid", "The report is larger than 512 KiB.");
  }
  const named = options.title?.replace(/\s+/g, " ").trim();
  if (
    options.title !== undefined &&
    (named === undefined || named.length === 0 || named.length > 200)
  ) {
    throw new ProjectLibraryProblem("invalid", "The title must be 1-200 characters.");
  }
  const provenance =
    options.provenance === undefined ? undefined : checkedProvenance(options.provenance);
  if (!(await specweaveFolder(root))) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project has no .specweave folder. Run specweave init in it to save reports.",
    );
  }
  const title = named ?? reportTitle(normalizedText, source.title ?? "Report");
  // A named increment is checked before the duplicate lookup, so a wrong
  // name is refused even when the same text is already saved.
  const requested = options.increment?.trim();
  const explicit =
    requested === undefined || requested.length === 0
      ? undefined
      : requested.toLowerCase() === "none"
        ? null
        : await namedIncrement(root, requested);
  const key = reportKey(source.threadId, normalizedText);
  return oneSaveAtATime(`${root}\0${key}`, async () => {
    const before = await readThreadReports(root, source);
    // Files are opened from the real root, by paths that hold no link.
    const realRoot = await NodeFSP.realpath(root);
    const own = ownFrontMatter(normalizedText);
    const provenanceLines = provenance
      ? [
          `source: ${frontMatterValue(provenance.source)}`,
          ...(provenance.original ? [`original: ${frontMatterValue(provenance.original)}`] : []),
        ]
      : [];
    // The key is short and shared by texts that differ only in spacing, so a
    // hit is this report only when its thread and its text match exactly. An
    // import of a text saved before adds the provenance that copy lacks.
    const already = async (relativePath: string): Promise<SavedReport | null> => {
      const absolutePath = NodePath.join(root, ...relativePath.split("/"));
      const reader = await openInside(realRoot, relativePath, NodeFS.constants.O_RDONLY).catch(
        () => null,
      );
      if (reader === null) return null;
      try {
        const stored = parseStoredReport(await reader.readFile("utf8"));
        if (stored.thread !== source.threadId || !sameBody(stored.body, own.body)) return null;
        const missing =
          provenance === undefined ? [] : missingProvenance(stored, provenance, relativePath);
        if (missing.length > 0) {
          await addProvenance(realRoot, relativePath, reader, stored, missing);
        }
        const snapshot = await readThreadReports(root, source);
        return {
          snapshot,
          report: snapshot.reports.find((report) => report.path === relativePath) ?? {
            key,
            path: relativePath,
            savedAt: now.toISOString(),
          },
          title: stored.title ?? title,
          alreadySaved: true,
          absolutePath,
        };
      } finally {
        await reader.close();
      }
    };
    for (const report of before.reports) {
      if (report.key !== key) continue;
      const found = await already(report.path);
      if (found !== null) return found;
    }

    const increment =
      explicit !== undefined
        ? explicit
        : (before.increment?.id ??
          (options.resolveFromText
            ? await resolveReportIncrement(root, source, normalizedText)
            : null));
    const relativeDir =
      increment === null ? THREAD_REPORTS_DIR : `${INCREMENTS_DIR}/${increment}/reports`;
    await ensureDirectoryWithin(root, relativeDir);
    const savedAt = now.toISOString();
    const content = [
      "---",
      `title: ${frontMatterValue(title)}`,
      `thread: ${frontMatterValue(source.threadId)}`,
      ...(source.title ? [`threadTitle: ${frontMatterValue(source.title)}`] : []),
      ...(increment ? [`increment: ${frontMatterValue(increment)}`] : []),
      `savedAt: ${frontMatterValue(savedAt)}`,
      ...provenanceLines,
      ...own.lines,
      "---",
      "",
      own.body,
      "",
    ].join("\n");
    const first = reportFileName({
      savedAt,
      title,
      threadId: source.threadId,
      text: normalizedText,
    });
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      // A second report under the same day, title and key gets a number before the key.
      const name = attempt === 1 ? first : first.replace(`-${key}.md`, `-${attempt}-${key}.md`);
      const relativePath = posix(NodePath.join(relativeDir, name));
      try {
        const writer = await openInside(
          realRoot,
          relativePath,
          NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
        );
        try {
          await writeAll(writer, Buffer.from(content, "utf8"));
        } finally {
          await writer.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A save of the same text that ran alongside this one wrote it first; it
        // may still be writing, so read again briefly before calling it different.
        for (let read = 0; read < 5; read += 1) {
          const found = await already(relativePath);
          if (found !== null) return found;
          await NodeTimers.setTimeout(20);
        }
        continue;
      }
      const snapshot = await readThreadReports(root, source);
      return {
        snapshot,
        report: snapshot.reports.find((report) => report.path === relativePath) ?? {
          key,
          path: relativePath,
          savedAt,
        },
        title,
        alreadySaved: false,
        absolutePath: NodePath.join(root, ...relativePath.split("/")),
      };
    }
    throw new ProjectLibraryProblem(
      "conflict",
      "Nine reports already share this title today; save this one under its own title.",
    );
  });
}

/**
 * Saves the report once. Saving the same text again returns the copy that
 * is already there, wherever it was saved.
 */
export async function saveThreadReport(
  workspaceRoot: string,
  source: ThreadReportSource,
  text: string,
  now: Date = new Date(),
  options: { readonly resolveFromText?: boolean } = {},
): Promise<ProjectThreadReportsSnapshot> {
  return (await saveReport(workspaceRoot, source, text, now, options)).snapshot;
}
