// @effect-diagnostics nodeBuiltinImport:off -- Plain promises that walk the project Library with its confinement rules.
/**
 * Finds the Library files that count as project knowledge: hub file
 * artifacts and the files under the shared SpecWeave folders, markdown and
 * plain text only. Hub artifacts follow the folder rules: every path segment
 * below the project folder is checked with lstat and a symlink anywhere
 * refuses the file, and hidden segments other than the leading `.specweave`
 * are refused. The app's protected files (credentials, app state) are refused
 * by path while scanning and again by the identity of the opened file.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_KNOWLEDGE_FILE_BYTES,
  PROJECT_LIBRARY_FOLDERS,
  type ProjectKnowledgeSourceKind,
} from "@specweave-studio/contracts";

import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { readProjectLibrary } from "../ProjectLibrary.ts";

/** A missing entry is an answer; any other failure leaves the scan incomplete. */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Notes on a scan in progress: `complete` turns false once anything could not be read. */
type ScanState = { complete: boolean; visited: number };

/** `promise`, or `fallback` once it fails; a failure other than a missing entry marks the scan incomplete. */
function settle<A, B>(state: ScanState, promise: Promise<A>, fallback: B): Promise<A | B> {
  return promise.catch((error: unknown) => {
    if (!isAbsent(error)) state.complete = false;
    return fallback;
  });
}

export type KnowledgeFileCandidate = {
  readonly id: string;
  readonly kind: Extract<ProjectKnowledgeSourceKind, "artifact" | "library">;
  readonly label: string;
  /** Project-relative path with forward slashes. */
  readonly location: string;
  /** The hub's title for an artifact; library files take theirs from the text. */
  readonly title: string | null;
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
};

const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "build", "coverage"]);
/** Bounds the walk of a pathological tree; real Library folders hold a few thousand files. */
const MAX_VISITED_ENTRIES = 200_000;
const STAT_CONCURRENCY = 32;

const FOLDER_LABELS: Record<string, string> = {
  ".specweave/memory": "SpecWeave memory",
};
/** When capacity runs out, docs are kept before reports and increments, archives last. */
const FOLDER_RANK: Record<string, number> = {
  ".specweave/docs": 0,
  ".specweave/memory": 1,
  ".specweave/reports": 2,
  ".specweave/increments": 3,
};
const ARCHIVED = /\/_archive\//;

/**
 * Library content that is not knowledge: abandoned increments, the living-docs
 * copies of increment specs (the increment's own spec is indexed), and the raw
 * command output `specweave task done --run` saves beside an increment.
 */
function skippedFolder(location: string): boolean {
  return (
    location === ".specweave/increments/_abandoned" || location === ".specweave/docs/internal/specs"
  );
}
function skippedFile(location: string): boolean {
  return /^\.specweave\/increments\/.+\/reports\/task-[^/]*\.txt$/.test(location);
}

function toLocation(root: string, path: string): string {
  return NodePath.relative(root, path).split(NodePath.sep).join("/");
}

function inside(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

/** Markdown keeps its headings; plain text is chunked by paragraphs. */
export function isMarkdownLocation(location: string): boolean {
  return [".md", ".mdx", ".markdown"].includes(NodePath.extname(location).toLowerCase());
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(NodePath.extname(name).toLowerCase());
}

async function mapLimited<A, B>(
  items: readonly A[],
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<B[]> {
  const results: B[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

async function walk(root: string, folder: string, state: ScanState): Promise<string[]> {
  const files: string[] = [];
  const pending = [folder];
  while (pending.length > 0 && state.visited < MAX_VISITED_ENTRIES) {
    const directory = pending.pop()!;
    const entries = await settle(
      state,
      NodeFSP.readdir(directory, { withFileTypes: true }),
      [] as NodeFS.Dirent[],
    );
    for (const entry of entries) {
      state.visited += 1;
      // Dirents describe the entry itself, so a symlink is never followed into.
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name) && !skippedFolder(toLocation(root, path)))
          pending.push(path);
      } else if (entry.isFile() && isTextFile(entry.name) && !skippedFile(toLocation(root, path)))
        files.push(path);
    }
  }
  // Folders left unread at the bound may hold files the index already has.
  if (pending.length > 0) state.complete = false;
  return files;
}

/** A hub location as a visible, symlink-free text file inside the project, or null. */
async function artifactFile(root: string, location: string, state: ScanState) {
  const normalized = NodePath.posix.normalize(location.trim().replace(/^\.\//, ""));
  if (NodePath.posix.isAbsolute(normalized) || normalized.includes("\\")) return null;
  if (!isTextFile(normalized)) return null;
  const segments = normalized.split("/");
  const refused = segments.some(
    (segment, index) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      (segment.startsWith(".") && !(index === 0 && segment === ".specweave")),
  );
  if (refused) return null;
  let path = root;
  for (const segment of segments) {
    path = NodePath.join(path, segment);
    const stat = await settle(state, NodeFSP.lstat(path), null);
    if (!stat || stat.isSymbolicLink()) return null;
  }
  const stat = await settle(state, NodeFSP.lstat(path), null);
  if (!stat?.isFile()) return null;
  // No segment is a link, so this only settles the on-disk spelling of the name.
  const real = await settle(state, WorkspaceSensitivePaths.realpathNative(path), null);
  if (real === null || !inside(root, real)) return null;
  return { path: real, location: toLocation(root, real), stat };
}

export type KnowledgeScan = {
  readonly files: readonly KnowledgeFileCandidate[];
  /**
   * False when part of the project could not be read, such as an unmounted
   * folder, an unreadable hub or a folder that failed to list: files missing
   * from `files` may still exist.
   */
  readonly complete: boolean;
};

/**
 * Every Library file that may be knowledge: hub artifacts first, then folder
 * files by folder rank, archived increments last, newest first within each.
 */
export async function scanKnowledgeFiles(
  workspaceRoot: string,
  guard: WorkspaceSensitivePaths.SensitivePathGuard,
): Promise<KnowledgeScan> {
  const root = await WorkspaceSensitivePaths.realpathNative(NodePath.resolve(workspaceRoot)).catch(
    () => null,
  );
  // An unreachable project folder, unmounted or moved, says nothing about its files.
  if (root === null) return { files: [], complete: false };
  const state: ScanState = { complete: true, visited: 0 };
  const candidates: KnowledgeFileCandidate[] = [];
  const seen = new Set<string>();

  const library = await readProjectLibrary(root).catch(() => null);
  if (library === null || library.hubProblem !== null) state.complete = false;
  for (const artifact of library?.artifacts ?? []) {
    if (artifact.kind !== "file" || artifact.missing) continue;
    const file = await artifactFile(root, artifact.location, state);
    if (file === null || guard.isDenied(file.path)) continue;
    const id = `file:${file.location}`;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({
      id,
      kind: "artifact",
      label: "Hub artifacts",
      location: file.location,
      title: artifact.title,
      path: file.path,
      size: file.stat.size,
      modifiedMs: file.stat.mtimeMs,
    });
  }

  const folderFiles: Array<KnowledgeFileCandidate & { readonly rank: number }> = [];
  // A symlinked .specweave or Library folder is refused, as the Library does.
  const specweave = await settle(state, NodeFSP.lstat(NodePath.join(root, ".specweave")), null);
  const folders = specweave?.isDirectory() ? PROJECT_LIBRARY_FOLDERS : [];
  for (const folder of folders) {
    const folderPath = NodePath.join(root, folder.path);
    const folderStat = await settle(state, NodeFSP.lstat(folderPath), null);
    if (!folderStat?.isDirectory()) continue;
    const label = FOLDER_LABELS[folder.path] ?? folder.label;
    const paths = (await walk(root, folderPath, state)).filter(
      (file) => !seen.has(`file:${toLocation(root, file)}`) && !guard.isDenied(file),
    );
    const stats = await mapLimited(paths, STAT_CONCURRENCY, (path) =>
      settle(state, NodeFSP.lstat(path), null),
    );
    paths.forEach((path, index) => {
      const stat = stats[index];
      if (!stat?.isFile()) return;
      const location = toLocation(root, path);
      seen.add(`file:${location}`);
      folderFiles.push({
        id: `file:${location}`,
        kind: "library",
        label,
        location,
        title: null,
        path,
        size: stat.size,
        modifiedMs: stat.mtimeMs,
        rank: (FOLDER_RANK[folder.path] ?? 9) + (ARCHIVED.test(location) ? 10 : 0),
      });
    });
  }
  folderFiles.sort((left, right) => left.rank - right.rank || right.modifiedMs - left.modifiedMs);
  return {
    files: [...candidates, ...folderFiles.map(({ rank: _rank, ...file }) => file)],
    complete: state.complete,
  };
}

export type KnowledgeFileText =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "skipped"; readonly reason: "tooLarge" | "unreadable" };

const UNREADABLE = { type: "skipped", reason: "unreadable" } as const;

/**
 * Reads a candidate the way `projects.readFile` does: neither the path nor its
 * on-disk spelling may be protected, by name or by device and inode, and the
 * opened file must be the one that was checked. Binary and oversized files
 * are skipped.
 */
export async function readKnowledgeFile(
  candidate: KnowledgeFileCandidate,
  guard: WorkspaceSensitivePaths.SensitivePathGuard,
): Promise<KnowledgeFileText> {
  if (candidate.size > PROJECT_KNOWLEDGE_FILE_BYTES) return { type: "skipped", reason: "tooLarge" };
  if (guard.isDenied(candidate.path)) return UNREADABLE;
  const real = await WorkspaceSensitivePaths.realpathNative(candidate.path).catch(() => null);
  // The scan saw no link on the way; another real path means the tree changed since.
  if (real === null || real !== candidate.path || guard.isDenied(real)) return UNREADABLE;
  const statCache: WorkspaceSensitivePaths.IdentityStatCache = new Map();
  if (await guard.matchesProtectedIdentity(real, statCache).catch(() => true)) return UNREADABLE;
  const checked = await (statCache.get(WorkspaceSensitivePaths.identityStatCacheKey(real)) ??
    NodeFSP.lstat(real, { bigint: true }).catch(() => null));
  if (checked === null || !checked.isFile()) return UNREADABLE;
  let handle: NodeFSP.FileHandle;
  try {
    // Non-blocking so a FIFO swapped in cannot hang the open; no-follow, since the real path names no link.
    handle = await NodeFSP.open(
      real,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NONBLOCK ?? 0) |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return UNREADABLE;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (await guard.isProtectedFileIdentity(stat)) return UNREADABLE;
    if (!stat.isFile() || stat.dev !== checked.dev || stat.ino !== checked.ino) return UNREADABLE;
    if (stat.size > BigInt(PROJECT_KNOWLEDGE_FILE_BYTES))
      return { type: "skipped", reason: "tooLarge" };
    const bytes = await handle.readFile();
    if (bytes.subarray(0, 8_192).includes(0)) return UNREADABLE;
    return { type: "text", content: bytes.toString("utf8").replace(/^﻿/, "") };
  } catch {
    return UNREADABLE;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
