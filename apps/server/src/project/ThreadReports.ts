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

/** The title and body of a saved report, or null when it cannot be read. */
async function readSavedReport(file: string): Promise<{
  readonly title: string | null;
  readonly hasSource: boolean;
  readonly body: string;
  readonly content: string;
  readonly blockEnd: number;
} | null> {
  // Only a regular file is a saved report: never read or write through a link.
  const stat = await NodeFSP.lstat(file).catch(() => null);
  if (stat === null || !stat.isFile()) return null;
  const content = await NodeFSP.readFile(file, "utf8").catch(() => null);
  if (content === null) return null;
  const match = FRONTMATTER.exec(content);
  const block = match?.[1] ?? "";
  let title: string | null = null;
  try {
    const value: unknown = JSON.parse(/^title: (.+)$/m.exec(block)?.[1] ?? "null");
    title = typeof value === "string" ? value : null;
  } catch {
    title = null;
  }
  return {
    title,
    hasSource: /^source:/m.test(block),
    body: match ? content.slice(match[0].length) : content,
    content,
    // Where the closing rule starts, for properties added later.
    blockEnd: match && content.startsWith("---\n") ? 4 + block.length : -1,
  };
}

/** Same words in the same order: whitespace and line endings aside. */
function sameBody(left: string, right: string): boolean {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
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
  const before = await readThreadReports(root, source);
  const key = reportKey(source.threadId, normalizedText);
  const own = ownFrontMatter(normalizedText);
  const provenanceLines = provenance
    ? [
        `source: ${frontMatterValue(provenance.source)}`,
        ...(provenance.original ? [`original: ${frontMatterValue(provenance.original)}`] : []),
      ]
    : [];
  // The key is short, so a hit is the same report only when the words match.
  // An import of a text saved before without provenance adds it there.
  const already = async (relativePath: string): Promise<SavedReport | null> => {
    const absolutePath = NodePath.join(root, ...relativePath.split("/"));
    const stored = await readSavedReport(absolutePath);
    if (stored === null || !sameBody(stored.body, own.body)) return null;
    if (provenanceLines.length > 0 && !stored.hasSource && stored.blockEnd > 0) {
      await NodeFSP.writeFile(
        absolutePath,
        `${stored.content.slice(0, stored.blockEnd)}\n${provenanceLines.join("\n")}${stored.content.slice(stored.blockEnd)}`,
        "utf8",
      );
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
  const target = await ensureDirectoryWithin(root, relativeDir);
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
  const first = reportFileName({ savedAt, title, threadId: source.threadId, text: normalizedText });
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    // A second report under the same day, title and key gets a number before the key.
    const name = attempt === 1 ? first : first.replace(`-${key}.md`, `-${attempt}-${key}.md`);
    const relativePath = posix(NodePath.join(relativeDir, name));
    try {
      await NodeFSP.writeFile(NodePath.join(target, name), content, {
        encoding: "utf8",
        flag: NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
        mode: 0o644,
      });
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
      absolutePath: NodePath.join(root, relativeDir, name),
    };
  }
  throw new ProjectLibraryProblem(
    "conflict",
    "Nine reports already share this title today; save this one under its own title.",
  );
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
