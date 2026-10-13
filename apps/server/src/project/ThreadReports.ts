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

import type {
  ProjectThreadReport,
  ProjectThreadReportsSnapshot,
} from "@specweave-studio/contracts";
import {
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
/** `0973-budget`, and past 9999 `10001-export`. */
const INCREMENT_FOLDER = /^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*$/i;
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
    const matches = folders.filter((folder) => folder.startsWith(`${number}-`));
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
    const leading = /^\d{4,}/.exec(value)?.[0];
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

function frontMatterValue(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " "));
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
  options: {
    /**
     * Also match increment folders the report names. Off for a person's save,
     * so the file lands where the card said it would.
     */
    readonly resolveFromText?: boolean;
  } = {},
): Promise<ProjectThreadReportsSnapshot> {
  const root = NodePath.resolve(workspaceRoot);
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) throw new ProjectLibraryProblem("invalid", "The report is empty.");
  if (Buffer.byteLength(body, "utf8") > MAX_SAVED_REPORT_BYTES) {
    throw new ProjectLibraryProblem("invalid", "The report is larger than 512 KiB.");
  }
  if (!(await specweaveFolder(root))) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project has no .specweave folder. Run specweave init in it to save reports.",
    );
  }
  const before = await readThreadReports(root, source);
  const key = reportKey(source.threadId, body);
  if (before.reports.some((report) => report.key === key)) return before;

  const increment =
    before.increment?.id ??
    (options.resolveFromText ? await resolveReportIncrement(root, source, body) : null);
  const relativeDir =
    increment === null ? THREAD_REPORTS_DIR : `${INCREMENTS_DIR}/${increment}/reports`;
  const target = await ensureDirectoryWithin(root, relativeDir);
  const savedAt = now.toISOString();
  const title = reportTitle(body, source.title ?? "Report");
  const name = reportFileName({ savedAt, title, threadId: source.threadId, text: body });
  const content = [
    "---",
    `title: ${frontMatterValue(title)}`,
    `thread: ${frontMatterValue(source.threadId)}`,
    ...(source.title ? [`threadTitle: ${frontMatterValue(source.title)}`] : []),
    ...(increment ? [`increment: ${frontMatterValue(increment)}`] : []),
    `savedAt: ${frontMatterValue(savedAt)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  try {
    await NodeFSP.writeFile(NodePath.join(target, name), content, {
      encoding: "utf8",
      flag: NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      mode: 0o644,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readThreadReports(root, source);
}
