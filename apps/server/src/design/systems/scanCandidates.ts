// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises over files inside one approved root.
/**
 * Finds design-system sources inside one root, and nothing outside it.
 *
 * The walk looks at names only (sorted, so the result is stable), skips
 * dependency, build and hidden folders, and never follows a folder symlink.
 * A file symlink is used only when its target resolves inside the root;
 * otherwise it is listed as skipped. Only files whose names look like token,
 * theme or stylesheet sources are opened, to count what they hold, within one
 * read budget per scan. Nothing is read in the background and nothing is
 * cached between scans.
 *
 * An umbrella root (nested repositories, such as `repositories/<org>/<repo>`)
 * is walked one repository at a time, each with its own file cap, plus the
 * root's own folders; repositories whose package says it is a design system
 * go first. One wall-clock limit covers the whole scan: past it the scan
 * returns what it found, marked `truncated`.
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESIGN_SYSTEM_IMPORT_MAX_CANDIDATES,
  DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES,
  DESIGN_SYSTEM_IMPORT_MAX_SCAN_BYTES,
  DESIGN_SYSTEM_IMPORT_MAX_SCAN_FILES,
  type DesignSystemCandidate,
  type DesignSystemCandidateKind,
  type DesignSystemScanResult,
  type DesignSystemScanSkip,
  type DesignSystemSuggestion,
} from "@specweave-studio/contracts";

import { type SourceText, compareText, customPropertyNames, sourceText } from "./common.ts";
import {
  type ComponentReader,
  discoverBarrel,
  discoverCssClasses,
  discoverFolder,
} from "./discoverComponents.ts";
import { collectDtcg, detectTokenJson } from "./extractDtcg.ts";
import { loadTypeScript, tsThemeKeys } from "./extractTsTheme.ts";
import { collectWeave, isWeaveTokens } from "./extractWeave.ts";
import {
  type MutableSuggestion,
  type PackageInfo,
  type RankedCandidate,
  looksLikeDesignSystem,
  rankSuggestions,
} from "./scanRanking.ts";

const SKIPPED_FOLDERS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  "storybook-static",
  "playwright-report",
  "test-results",
  "__pycache__",
  "bower_components",
  "jspm_packages",
  "Pods",
  "DerivedData",
]);
/** Files one walk looks at: the root's own folders, or one nested repository. */
const MAX_FILES_SEEN = 60_000;
/** Wall-clock limit of one scan; past it the scan returns what it found. */
export const SCAN_TIME_LIMIT_MS = 5_000;
/** Folders listed at once while walking. */
const READDIR_BATCH = 16;
/** Nested repositories walked ahead of the one being counted. */
const WALK_AHEAD = 2;
const COMPONENT_FOLDER_NAMES = /^(?:ui|primitives)$/;
/** The SpecWeave umbrella layout: `repositories/<org>/<repo>`. */
const UMBRELLA_REPOSITORY = /^repositories\/[^/]+\/[^/]+$/;

export interface ScanOptions {
  /** Files each walk may look at (the root's own folders, and each nested repository). */
  readonly maxFilesSeen?: number;
  readonly maxCandidates?: number;
  /** Total bytes and files one scan may read. */
  readonly maxReadBytes?: number;
  readonly maxReadFiles?: number;
  /** Wall-clock limit of the whole scan, `SCAN_TIME_LIMIT_MS` by default. */
  readonly timeLimitMs?: number;
  /** Test seam: the clock the time limit reads. */
  readonly now?: () => number;
}

export type RootPathProblem =
  | "outside-root"
  | "symlink-outside-root"
  | "missing"
  | "too-large"
  | "not-a-file"
  | "excluded"
  | "budget";

/** Secrets and keys are never read, even when a caller names them. */
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc)$/i;

/**
 * True for a path the scan never reads: anything under a hidden or skipped
 * folder (`.git`, `node_modules`, `dist`, ...), a hidden file, or a secret.
 * Applies to paths a caller names as well as to the folder walk.
 */
export const isExcludedPath = (relative: string): boolean => {
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  return (
    segments
      .slice(0, -1)
      .some((segment) => segment.startsWith(".") || SKIPPED_FOLDERS.has(segment)) ||
    name.startsWith(".") ||
    SECRET_FILE.test(name)
  );
};

export class RootPathError extends Error {
  readonly reason: RootPathProblem;
  readonly path: string;
  constructor(reason: RootPathProblem, path: string) {
    super(`${path}: ${reason}`);
    this.reason = reason;
    this.path = path;
  }
}

const toPosix = (path: string) => path.split(NodePath.sep).join("/");

const isInside = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** What one scan may still read. Files past it are refused with `budget`. */
export class ReadBudget {
  bytes: number;
  files: number;
  /** Paths refused for the budget, for the scan's skipped list. */
  readonly refused = new Set<string>();
  constructor(
    bytes = DESIGN_SYSTEM_IMPORT_MAX_SCAN_BYTES,
    files = DESIGN_SYSTEM_IMPORT_MAX_SCAN_FILES,
  ) {
    this.bytes = bytes;
    this.files = files;
  }
}

/** Test seam: runs between resolving a path and opening it, to swap files in a race test. */
export const readInsideRootHooks: { beforeOpen?: (real: string) => Promise<void> } = {};

const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

/** Root-relative POSIX path of a real path inside the root. */
const relativeTo = (realRoot: string, real: string) => toPosix(NodePath.relative(realRoot, real));

/**
 * Reads one root-relative file, refusing anything that leaves the root:
 * absolute paths, `..`, and symlinks (of the file or a parent folder) whose
 * target is outside. Exclusions apply to the name asked for and to the real
 * path it resolves to, so `theme.css -> .env` is refused. The file is opened
 * once (without following a final symlink) and checked on that descriptor:
 * its identity must match the resolved path, so swapping a link between the
 * check and the read is refused instead of read.
 */
export const readInsideRoot = async (
  realRoot: string,
  relative: string,
  maxBytes = DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES,
  budget?: ReadBudget,
): Promise<SourceText> => {
  const { path, bytes } = await readBytesInsideRoot(realRoot, relative, maxBytes, budget);
  return sourceText(path, bytes.toString("utf8"));
};

/** `readInsideRoot` for any file, images and fonts included: the bytes as read. */
export const readBytesInsideRoot = async (
  realRoot: string,
  relative: string,
  maxBytes = DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES,
  budget?: ReadBudget,
): Promise<{ readonly path: string; readonly bytes: Buffer }> => {
  const normalized = toPosix(NodePath.normalize(relative)).replace(/^\.\//, "");
  if (
    NodePath.isAbsolute(relative) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  ) {
    throw new RootPathError("outside-root", relative);
  }
  if (isExcludedPath(normalized)) throw new RootPathError("excluded", normalized);
  const absolute = NodePath.join(realRoot, normalized);
  const resolveReal = async () => {
    let real: string;
    try {
      real = await NodeFS.realpath(absolute);
    } catch {
      throw new RootPathError("missing", normalized);
    }
    if (!isInside(realRoot, real)) throw new RootPathError("symlink-outside-root", normalized);
    if (isExcludedPath(relativeTo(realRoot, real))) throw new RootPathError("excluded", normalized);
    return real;
  };
  const real = await resolveReal();
  await readInsideRootHooks.beforeOpen?.(real);
  let handle: NodeFS.FileHandle;
  try {
    handle = await NodeFS.open(real, OPEN_FLAGS);
  } catch {
    // Missing now, or swapped for a link since it was resolved.
    throw new RootPathError("missing", normalized);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RootPathError("not-a-file", normalized);
    // The open descriptor must still be the file the path resolves to, inside the root.
    const now = await NodeFS.stat(await resolveReal()).catch(() => null);
    if (now === null || now.dev !== stat.dev || now.ino !== stat.ino) {
      throw new RootPathError("symlink-outside-root", normalized);
    }
    if (stat.size > maxBytes) throw new RootPathError("too-large", normalized);
    if (budget && (budget.files <= 0 || stat.size > budget.bytes)) {
      budget.refused.add(normalized);
      throw new RootPathError("budget", normalized);
    }
    // Read at most the cap, even if the file grows after fstat.
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new RootPathError("too-large", normalized);
    if (budget) {
      budget.files -= 1;
      budget.bytes -= length;
    }
    return { path: normalized, bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
};

/**
 * The size and time of one root-relative file, under the rules of
 * `readInsideRoot` (the same exclusions, no escape through `..` or a link,
 * the same cap), without reading it: for listing a system's source files.
 */
export const statInsideRoot = async (
  realRoot: string,
  relative: string,
  maxBytes = DESIGN_SYSTEM_IMPORT_MAX_FILE_BYTES,
): Promise<{ readonly size: number; readonly mtime: Date }> => {
  const normalized = toPosix(NodePath.normalize(relative)).replace(/^\.\//, "");
  if (
    NodePath.isAbsolute(relative) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  ) {
    throw new RootPathError("outside-root", relative);
  }
  if (isExcludedPath(normalized)) throw new RootPathError("excluded", normalized);
  let real: string;
  try {
    real = await NodeFS.realpath(NodePath.join(realRoot, normalized));
  } catch {
    throw new RootPathError("missing", normalized);
  }
  if (!isInside(realRoot, real)) throw new RootPathError("symlink-outside-root", normalized);
  if (isExcludedPath(relativeTo(realRoot, real))) throw new RootPathError("excluded", normalized);
  const stat = await NodeFS.stat(real).catch(() => null);
  if (stat === null) throw new RootPathError("missing", normalized);
  if (!stat.isFile()) throw new RootPathError("not-a-file", normalized);
  if (stat.size > maxBytes) throw new RootPathError("too-large", normalized);
  return stat;
};

interface WalkResult {
  readonly files: string[];
  readonly folders: Map<string, string[]>;
  readonly skipped: DesignSystemScanSkip[];
  readonly truncated: boolean;
  /** Nested repositories found and left for their own walk (umbrella roots). */
  readonly repositories: string[];
}

interface WalkOptions {
  /** Root-relative folder to start from; `""` for the root. */
  readonly start: string;
  readonly maxFiles: number;
  /** True once the scan is out of time (or done); the walk stops, marked truncated. */
  readonly stop: () => boolean;
  /** List nested repositories below `start` instead of walking into them. */
  readonly splitRepositories: boolean;
  /** Repositories already known, never walked into. */
  readonly known?: ReadonlySet<string>;
}

type FolderEntries = Awaited<ReturnType<typeof listFolder>>;
const listFolder = (realRoot: string, folder: string) =>
  NodeFS.readdir(NodePath.join(realRoot, folder), { withFileTypes: true });

/** A folder holding its own repository: a `.git` entry, or a package in the umbrella layout. */
const isNestedRepository = (folder: string, entries: FolderEntries) =>
  entries.some((entry) => entry.name === ".git") ||
  (UMBRELLA_REPOSITORY.test(folder) &&
    entries.some((entry) => entry.name === "package.json" && !entry.isDirectory()));

/** A real folder the walk would enter: not a symlink, not hidden or skipped. */
const isWalkedFolder = (entry: FolderEntries[number]) =>
  entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_FOLDERS.has(entry.name);

/**
 * The umbrella's `repositories/<org>/<repo>` checkouts, read two levels deep
 * before anything else is walked, so they do not wait for the root's own
 * folders. Folder symlinks are not followed, as in the walk.
 */
const umbrellaRepositories = async (realRoot: string): Promise<string[]> => {
  const top = await listFolder(realRoot, "").catch(() => []);
  if (!top.some((entry) => entry.name === "repositories" && isWalkedFolder(entry))) return [];
  const orgs = (await listFolder(realRoot, "repositories").catch(() => [])).filter(isWalkedFolder);
  const found = await Promise.all(
    orgs.map(async (org) => {
      const repos = await listFolder(realRoot, `repositories/${org.name}`).catch(() => []);
      return Promise.all(
        repos.filter(isWalkedFolder).map(async (repo) => {
          const folder = `repositories/${org.name}/${repo.name}`;
          const entries = await listFolder(realRoot, folder).catch(() => null);
          return entries && isNestedRepository(folder, entries) ? [folder] : [];
        }),
      );
    }),
  );
  return found.flat(2).sort(compareText);
};

const walk = async (realRoot: string, options: WalkOptions): Promise<WalkResult> => {
  const files: string[] = [];
  const folders = new Map<string, string[]>();
  const skipped: DesignSystemScanSkip[] = [];
  const repositories: string[] = [];
  let truncated = false;
  const queue: string[] = [options.start];
  let next = 0;
  while (next < queue.length && !truncated) {
    if (options.stop()) {
      truncated = true;
      break;
    }
    // Folders are listed a batch at a time and handled in queue order, so the result is the same.
    const batch = queue.slice(next, next + READDIR_BATCH);
    next += batch.length;
    const listed = await Promise.all(
      batch.map((folder) => listFolder(realRoot, folder).catch(() => null)),
    );
    for (const [index, folder] of batch.entries()) {
      const entries = listed[index];
      if (!entries) {
        skipped.push({ path: folder || ".", reason: "unreadable" });
        continue;
      }
      if (
        options.splitRepositories &&
        folder !== options.start &&
        (options.known?.has(folder) || isNestedRepository(folder, entries))
      ) {
        repositories.push(folder);
        continue;
      }
      truncated = await walkFolder(realRoot, folder, entries, options.maxFiles, {
        files,
        folders,
        skipped,
        queue,
      });
      if (truncated) break;
    }
  }
  return { files, folders, skipped, truncated, repositories };
};

/** Adds one folder's files and queues its subfolders; true when the file cap stopped it. */
const walkFolder = async (
  realRoot: string,
  folder: string,
  entries: FolderEntries,
  maxFiles: number,
  into: {
    readonly files: string[];
    readonly folders: Map<string, string[]>;
    readonly skipped: DesignSystemScanSkip[];
    readonly queue: string[];
  },
): Promise<boolean> => {
  const { files, folders, skipped, queue } = into;
  let truncated = false;
  entries.sort((left, right) => compareText(left.name, right.name));
  const inFolder: string[] = [];
  for (const entry of entries) {
    const relative = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_FOLDERS.has(entry.name)) continue;
      queue.push(relative);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const real = await NodeFS.realpath(NodePath.join(realRoot, relative));
        if (!isInside(realRoot, real)) {
          if (looksLikeSource(entry.name))
            skipped.push({ path: relative, reason: "symlink-outside-root" });
          continue;
        }
        if (isExcludedPath(relativeTo(realRoot, real))) {
          if (looksLikeSource(entry.name)) skipped.push({ path: relative, reason: "excluded" });
          continue;
        }
        const stat = await NodeFS.stat(real);
        if (!stat.isFile()) continue; // Folder symlinks are never followed.
      } catch {
        continue;
      }
    } else if (!entry.isFile()) {
      continue;
    }
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    if (isExcludedPath(relative)) continue;
    files.push(relative);
    inFolder.push(relative);
  }
  folders.set(folder, inFolder);
  return truncated;
};

/** The `<word>-` prefix shared by at least 80% of names, if any. */
export const dominantPrefix = (names: ReadonlyArray<string>): string | null => {
  if (names.length < 3) return null;
  const counts = new Map<string, number>();
  for (const name of new Set(names)) {
    const head = /^([a-z0-9]+-)/i.exec(name)?.[1];
    if (head) counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  const unique = new Set(names).size;
  const [best] = [...counts].sort(
    (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
  );
  return best && best[1] / unique >= 0.8 ? best[0] : null;
};

const looksLikeSource = (name: string) =>
  /\.css$/i.test(name) || /\.json$/i.test(name) || /\.tsx?$/i.test(name);

const kindByName = (path: string): "css" | "json" | "ts" | "barrel" | null => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(?:min|module)\.css$/i.test(name)) return null;
  if (/\.css$/i.test(name)) return "css";
  if (/\.json$/i.test(name)) {
    if (
      /^(?:package|package-lock|tsconfig.*|jsconfig|composer|manifest|components|turbo|vercel|renovate)\.json$/i.test(
        name,
      )
    )
      return null;
    return /tokens?|theme|variables|design|palette/i.test(name) ? "json" : null;
  }
  if (/\.(?:test|spec|stories|d)\.tsx?$/i.test(name)) return null;
  if (/^index\.tsx?$/i.test(name)) return "barrel";
  if (/\.tsx?$/i.test(name) && /theme|palette|tokens?|colou?rs/i.test(name)) return "ts";
  return null;
};

/** A synchronous reader over files read ahead of time, for component discovery. */
export const preloadReader = async (
  realRoot: string,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  paths: Iterable<string>,
  /** Files already read in this scan; barrels share their folders' files. */
  cache: Map<string, SourceText | null> = new Map(),
  budget?: ReadBudget,
): Promise<ComponentReader> => {
  const texts = new Map<string, SourceText>();
  for (const path of paths) {
    if (!cache.has(path)) {
      // Missing, excluded, outside the root or over the budget: discovery treats it as absent.
      cache.set(path, await readInsideRoot(realRoot, path, undefined, budget).catch(() => null));
    }
    const text = cache.get(path);
    if (text) texts.set(path, text);
  }
  return {
    read: (path) => texts.get(path) ?? null,
    list: (folder) => folders.get(folder) ?? [],
  };
};

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Every source file under a folder (bounded), plus package.json files above it. */
export const componentReadPlan = (
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  folder: string,
  limit = 600,
): string[] => {
  const paths: string[] = [];
  const inside = [...folders].filter(
    ([name]) => folder === "" || name === folder || name.startsWith(`${folder}/`),
  );
  for (const [, files] of inside.sort(([left], [right]) => compareText(left, right))) {
    for (const file of files)
      if (/\.(?:tsx?|jsx?)$/.test(file) && !/\.(?:test|spec)\./.test(file)) paths.push(file);
    if (paths.length >= limit) break;
  }
  let current = folder;
  for (;;) {
    paths.push(current ? `${current}/package.json` : "package.json");
    if (!current) break;
    current = folderOf(current);
  }
  return paths.slice(0, limit + 20);
};

/** The nearest folder with a package.json, stopping at a nested repository's folder. */
const packageRoot = (
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  path: string,
  repositories: ReadonlySet<string> = new Set(),
): string => {
  let current = folderOf(path);
  for (;;) {
    if ((folders.get(current) ?? []).includes(current ? `${current}/package.json` : "package.json"))
      return current;
    if (!current || repositories.has(current)) return current;
    current = folderOf(current);
  }
};

/** Prefix that turns theme keys into the CSS variables a stylesheet reads (`app-theme-`). */
export const detectThemePrefix = (
  keys: ReadonlyArray<string>,
  cssTexts: ReadonlyArray<string>,
): string | null => {
  if (keys.length === 0) return null;
  const referenced = new Set<string>();
  for (const text of cssTexts)
    for (const match of text.matchAll(/var\(\s*--([A-Za-z0-9_-]+)/g)) referenced.add(match[1]!);
  const counts = new Map<string, number>();
  for (const name of referenced) {
    for (const key of keys) {
      if (name.endsWith(`-${key}`)) {
        const prefix = name.slice(0, name.length - key.length);
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
    }
  }
  const [best] = [...counts].sort(
    (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
  );
  return best && best[1] >= 8 && best[1] / keys.length >= 0.5 ? best[0] : null;
};

/**
 * Systems this scanner knows by their files. The app's own theme is the
 * runtime expression of Weave's family, so it is named as such and points at
 * Weave instead of looking like a separate brand.
 */
const KNOWN_SYSTEMS: ReadonlyArray<{
  readonly key: string;
  readonly name: string;
  readonly marker: string;
  readonly paths: ReadonlyArray<string>;
  /** The upstream system: its usual id in an owner's store, and its name. */
  readonly upstream?: { readonly systemId: string; readonly name: string };
  readonly description: string;
}> = [
  {
    key: "specwithcode-app-theme",
    name: "SpecWithCode app theme",
    marker: "packages/shared/src/themePalettes.ts",
    paths: ["packages/shared/src/themePalettes.ts", "apps/web/src/index.css"],
    upstream: { systemId: "weave", name: "Weave" },
    description:
      "The app's runtime theme: palettes from themePalettes.ts and the stylesheet that maps them. Its Iris palette is the upstream of Weave's colors; Weave is the canonical system.",
  },
];

/** The known system a scan suggestion stands for, by its key. */
export const knownSystemByKey = (key: string) => KNOWN_SYSTEMS.find((known) => known.key === key);

/** The known system whose marker file is among the selected paths, if any. */
export const knownSystemFor = (paths: ReadonlyArray<string>) =>
  KNOWN_SYSTEMS.find((known) =>
    paths.some((path) => path === known.marker || path.endsWith(`/${known.marker}`)),
  );

interface Counted {
  readonly candidate: Omit<DesignSystemCandidate, "suggestion">;
  readonly text?: string;
  /** A stylesheet's custom-property names. */
  readonly propertyNames?: ReadonlySet<string>;
  readonly themeKeys?: ReadonlyArray<string>;
  readonly weaveName?: string;
  readonly cssPrefix?: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly description?: string;
}

export const scanCandidates = async (
  root: string,
  options: ScanOptions = {},
): Promise<DesignSystemScanResult> => {
  const realRoot = await NodeFS.realpath(root);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeLimitMs ?? SCAN_TIME_LIMIT_MS);
  const budget = new ReadBudget(options.maxReadBytes, options.maxReadFiles);
  const maxFiles = options.maxFilesSeen ?? MAX_FILES_SEEN;
  const maxCandidates = options.maxCandidates ?? DESIGN_SYSTEM_IMPORT_MAX_CANDIDATES;
  const folders = new Map<string, string[]>();
  const skipped: DesignSystemScanSkip[] = [];
  const counted: Counted[] = [];
  let filesSeen = 0;
  let truncated = false;
  /** Set once the time limit or the candidate limit ends the scan. */
  let stopped = false;
  const mustStop = () => {
    if (!stopped && (now() > deadline || counted.length >= maxCandidates)) {
      truncated = true;
      stopped = true;
    }
    return stopped;
  };

  const readCache = new Map<string, SourceText | null>();
  const read = async (path: string) => {
    try {
      return await readInsideRoot(realRoot, path, undefined, budget);
    } catch (error) {
      // Budget refusals are listed once, after the scan.
      if (error instanceof RootPathError && error.reason !== "budget") {
        skipped.push({
          path,
          reason:
            error.reason === "too-large" ||
            error.reason === "symlink-outside-root" ||
            error.reason === "excluded"
              ? error.reason
              : "unreadable",
        });
      }
      return null;
    }
  };

  const manifests = new Map<string, PackageManifest | null>();
  const manifestOf = async (packageFolder: string) => {
    if (!manifests.has(packageFolder)) {
      let manifest: PackageManifest | null = null;
      try {
        const source = await readInsideRoot(
          realRoot,
          packageFolder ? `${packageFolder}/package.json` : "package.json",
          256 * 1024,
          budget,
        );
        const parsed = JSON.parse(source.text) as { name?: unknown; description?: unknown };
        manifest = {
          ...(typeof parsed.name === "string" && parsed.name.length > 0
            ? { name: parsed.name }
            : {}),
          ...(typeof parsed.description === "string"
            ? { description: parsed.description.slice(0, 1_000) }
            : {}),
        };
      } catch {
        // No readable manifest: the folder name stands in.
      }
      manifests.set(packageFolder, manifest);
    }
    return manifests.get(packageFolder) ?? null;
  };

  const base = (
    source: SourceText,
    kind: DesignSystemCandidateKind,
    tokenCount: number,
    componentCount: number,
    modes: ReadonlyArray<string>,
  ) => ({
    path: source.path,
    kind,
    sha256: source.sha256,
    bytes: Buffer.byteLength(source.text),
    tokenCount,
    componentCount,
    modes: [...modes],
  });

  /**
   * Counts what one walked part of the root holds: token files first, then
   * component barrels, which need the TypeScript parser and take longest.
   */
  const countWalked = async (walked: WalkResult) => {
    const byKind = walked.files.flatMap((path) => {
      const kind = kindByName(path);
      return kind === null ? [] : [{ path, kind }];
    });
    for (const { path, kind } of [
      ...byKind.filter((file) => file.kind !== "barrel"),
      ...byKind.filter((file) => file.kind === "barrel"),
    ]) {
      if (mustStop()) return;
      // One file that no parser can read is listed as skipped; the scan goes on.
      try {
        if (kind === "barrel") {
          const siblings = (folders.get(folderOf(path)) ?? []).filter((file) =>
            /\.tsx$/.test(file),
          );
          if (siblings.length < 2) continue;
          const source = await read(path);
          if (!source || !/export\s+(?:\*|\{)[^;]{0,4000}?from\s+["']\.\//.test(source.text))
            continue;
          const ts = await loadTypeScript();
          const reader = await preloadReader(
            realRoot,
            folders,
            componentReadPlan(folders, folderOf(path)),
            readCache,
            budget,
          );
          const found = discoverBarrel(ts, reader, source).components.length;
          if (found >= 2) counted.push({ candidate: base(source, "components", 0, found, []) });
          continue;
        }
        const source = await read(path);
        if (!source) continue;
        if (kind === "css") {
          const names = customPropertyNames(source.text);
          const propertyNames = new Set(names);
          const count = propertyNames.size;
          if (count < 3) continue;
          // Class families count as components only in a system stylesheet,
          // where classes share the custom properties' prefix (`--wv-`, `.wv-`).
          const propertyPrefix = dominantPrefix(names);
          const classes = propertyPrefix
            ? discoverCssClasses(source, propertyPrefix).components.length
            : 0;
          const modes = new Set<string>();
          if (
            /prefers-color-scheme\s*:\s*dark|\.dark\b|data-theme=["']?dark|@variant\s+dark/.test(
              source.text,
            )
          )
            modes.add("dark");
          modes.add(modes.has("dark") ? "light" : "default");
          counted.push({
            candidate: base(source, "css", count, classes, [...modes].sort(compareText)),
            text: source.text,
            propertyNames,
            ...(propertyPrefix ? { cssPrefix: propertyPrefix } : {}),
          });
        } else if (kind === "json") {
          if (isWeaveTokens(source.text)) {
            const collected = collectWeave(source);
            const name = /"name"\s*:\s*"([^"]{1,180})"/.exec(source.text)?.[1];
            counted.push({
              candidate: base(
                source,
                "weave",
                collected.tokens.length,
                0,
                collected.modes.map((mode) => mode.id),
              ),
              ...(name ? { weaveName: name } : {}),
            });
          } else {
            const form = detectTokenJson(source.text);
            if (form === null) continue;
            const collected = collectDtcg(source);
            if (collected.tokens.length === 0) continue;
            counted.push({
              candidate: base(
                source,
                form === "dtcg" ? "dtcg" : "token-json",
                collected.tokens.length,
                0,
                collected.modes.map((mode) => mode.id),
              ),
            });
          }
        } else if (kind === "ts") {
          const ts = await loadTypeScript();
          const { keys, modes } = tsThemeKeys(ts, source);
          if (keys.length < 5) continue;
          counted.push({
            candidate: base(source, "ts-theme", keys.length, 0, modes),
            themeKeys: keys,
          });
        }
      } catch {
        skipped.push({ path, reason: "unparseable" });
      }
    }

    // Component folders without a barrel (a shadcn-style ui/ folder).
    for (const [folder, inFolder] of [...walked.folders].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const name = folder.slice(folder.lastIndexOf("/") + 1);
      if (!COMPONENT_FOLDER_NAMES.test(name)) continue;
      if (mustStop()) return;
      if (inFolder.some((file) => /\/index\.tsx?$/.test(file))) continue;
      const components = inFolder.filter(
        (file) => /\.tsx$/.test(file) && !/\.(?:test|spec|stories)\.tsx$/.test(file),
      );
      if (components.length < 3) continue;
      const ts = await loadTypeScript();
      const reader = await preloadReader(
        realRoot,
        folders,
        componentReadPlan(new Map([[folder, inFolder]]), folder),
        readCache,
        budget,
      );
      const found = discoverFolder(ts, reader, folder).components.length;
      if (found < 3) continue;
      counted.push({
        candidate: {
          path: folder,
          kind: "components",
          sha256: sourceText(folder, components.join("\n")).sha256,
          bytes: 0,
          tokenCount: 0,
          componentCount: found,
          modes: [],
        },
      });
    }
  };

  const keep = (walked: WalkResult) => {
    for (const [folder, inFolder] of walked.folders) folders.set(folder, inFolder);
    skipped.push(...walked.skipped);
    filesSeen += walked.files.length;
    if (walked.truncated) truncated = true;
  };

  // Walk units: the umbrella's repositories, the root's own folders (`""`, which
  // stops at any other nested repository and adds it), and those repositories.
  // Repositories whose package says it is a design system go first.
  const umbrella = await umbrellaRepositories(realRoot);
  const known = new Set(umbrella);
  const systems = await Promise.all(
    umbrella.map(async (repository) => {
      const manifest = await manifestOf(repository);
      return looksLikeDesignSystem(manifest?.name, manifest?.description);
    }),
  );
  const order = [
    ...umbrella.filter((_, index) => systems[index]),
    "",
    ...umbrella.filter((_, index) => !systems[index]),
  ];
  // Listing folders waits on the disk and counting on the parser, so the next
  // units are walked while one is counted. Every walk stops with the scan.
  const walks = new Map<string, Promise<WalkResult>>();
  const walkOf = (start: string) => {
    let walking = walks.get(start);
    if (walking === undefined) {
      walking = walk(realRoot, {
        start,
        maxFiles,
        stop: mustStop,
        splitRepositories: start === "",
        known,
      });
      walking.catch(() => undefined);
      walks.set(start, walking);
    }
    return walking;
  };
  for (let index = 0; index < order.length; index += 1) {
    if (mustStop()) break;
    for (const ahead of order.slice(index + 1, index + 1 + WALK_AHEAD)) void walkOf(ahead);
    const walked = await walkOf(order[index]!);
    keep(walked);
    for (const repository of walked.repositories) {
      if (known.has(repository)) continue;
      known.add(repository);
      order.push(repository);
    }
    await countWalked(walked);
  }
  // Walks started ahead and not needed stop at their next folder batch.
  await Promise.allSettled(walks.values());

  // A nested repository is a package boundary even without a package.json.
  const nested: ReadonlySet<string> = known;
  const packages = new Map<string, PackageInfo>();
  for (const item of counted) {
    const packageFolder = packageRoot(folders, item.candidate.path, nested);
    if (packages.has(packageFolder)) continue;
    const manifest = await manifestOf(packageFolder);
    const label = manifest?.name
      ? manifest.name.replace(/^@[^/]+\//, "")
      : packageFolder
        ? packageFolder.slice(packageFolder.lastIndexOf("/") + 1)
        : NodePath.basename(realRoot);
    packages.set(packageFolder, {
      label: label.slice(0, 180),
      ...(manifest?.name ? { manifestName: manifest.name } : {}),
      ...(manifest?.description ? { description: manifest.description } : {}),
    });
  }
  for (const path of budget.refused) skipped.push({ path, reason: "budget" });
  return group(
    counted,
    (path) => packageRoot(folders, path, nested),
    packages,
    skipped,
    filesSeen,
    truncated || budget.refused.size > 0,
  );
};

const group = (
  counted: ReadonlyArray<Counted>,
  packageFolderOf: (path: string) => string,
  packages: ReadonlyMap<string, PackageInfo>,
  skipped: DesignSystemScanSkip[],
  filesSeen: number,
  truncated: boolean,
): DesignSystemScanResult => {
  const suggestionOf = new Map<string, string>();
  const suggestions = new Map<string, MutableSuggestion>();
  /** The package each suggestion stands for, for its manifest name and description. */
  const packageOfKey = new Map<string, string>();
  const add = (
    key: string,
    name: string,
    packageFolder: string,
    extra: Partial<DesignSystemSuggestion> = {},
  ) => {
    if (!suggestions.has(key)) {
      suggestions.set(key, { key, name, paths: [], copies: [], ...extra } as never);
      packageOfKey.set(key, packageFolder);
    }
    return suggestions.get(key)!;
  };
  const addPackage = (path: string) => {
    const packageFolder = packageFolderOf(path);
    const key = `pkg:${packageFolder}`;
    return add(key, packages.get(packageFolder)?.label ?? "Project", packageFolder);
  };
  const byPath = new Map(counted.map((item) => [item.candidate.path, item]));

  // Weave-style systems: tokens.json and the stylesheet beside it. Copies elsewhere fold in ranking.
  for (const item of counted) {
    if (item.candidate.kind !== "weave") continue;
    const folder = folderOf(item.candidate.path);
    const name = item.weaveName ?? (folder.slice(folder.lastIndexOf("/") + 1) || "Design system");
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const suggestion = add(key, name, packageFolderOf(item.candidate.path));
    suggestion.paths.push(item.candidate.path);
    suggestionOf.set(item.candidate.path, key);
    const sheet = counted.find(
      (other) => other.candidate.kind === "css" && folderOf(other.candidate.path) === folder,
    );
    if (!sheet?.text) continue;
    suggestion.paths.push(sheet.candidate.path);
    suggestionOf.set(sheet.candidate.path, key);
  }

  for (const known of KNOWN_SYSTEMS) {
    const marker = [...byPath.keys()].find(
      (path) => path === known.marker || path.endsWith(`/${known.marker}`),
    );
    if (marker === undefined) continue;
    const prefix = marker.slice(0, marker.length - known.marker.length);
    // A label only: whether the owner holds the upstream is the service's to check.
    const suggestion = add(known.key, known.name, packageFolderOf(marker), {
      description: known.description,
      ...(known.upstream ? { derivedFromLabel: known.upstream.name } : {}),
    });
    for (const path of known.paths.map((relative) => `${prefix}${relative}`)) {
      if (!byPath.has(path) || suggestionOf.has(path)) continue;
      suggestion.paths.push(path);
      suggestionOf.set(path, known.key);
    }
  }

  // A theme file joins the stylesheet that reads its keys as variables.
  for (const item of counted) {
    if (item.candidate.kind !== "ts-theme" || suggestionOf.has(item.candidate.path)) continue;
    const reader = counted.find(
      (other) =>
        other.candidate.kind === "css" &&
        other.text &&
        detectThemePrefix(item.themeKeys ?? [], [other.text]) !== null,
    );
    if (reader && suggestionOf.has(reader.candidate.path)) {
      const key = suggestionOf.get(reader.candidate.path)!;
      suggestions.get(key)!.paths.push(item.candidate.path);
      suggestionOf.set(item.candidate.path, key);
    } else if (reader) {
      const suggestion = addPackage(reader.candidate.path);
      suggestion.paths.push(item.candidate.path, reader.candidate.path);
      suggestionOf.set(item.candidate.path, suggestion.key);
      suggestionOf.set(reader.candidate.path, suggestion.key);
    }
  }

  // Everything else groups by its package; only substantial files are preselected.
  for (const item of counted) {
    if (suggestionOf.has(item.candidate.path)) continue;
    const suggestion = addPackage(item.candidate.path);
    suggestionOf.set(item.candidate.path, suggestion.key);
    const substantial =
      item.candidate.kind !== "css" ||
      item.candidate.tokenCount >= 10 ||
      item.candidate.componentCount >= 5;
    if (substantial) suggestion.paths.push(item.candidate.path);
  }

  const ranked = new Map<string, RankedCandidate>(
    counted.map((item) => [
      item.candidate.path,
      {
        ...item.candidate,
        ...(item.propertyNames ? { propertyNames: item.propertyNames } : {}),
      },
    ]),
  );
  const ordered = rankSuggestions(suggestions, suggestionOf, ranked, (key) => {
    const packageFolder = packageOfKey.get(key);
    return packageFolder === undefined ? undefined : packages.get(packageFolder);
  });

  const candidates = counted
    .map((item) => ({ ...item.candidate, suggestion: suggestionOf.get(item.candidate.path) ?? "" }))
    .sort((left, right) => compareText(left.path, right.path));
  return {
    candidates,
    suggestions: ordered.map((suggestion) => ({
      ...suggestion,
      paths: [...suggestion.paths].sort(compareText),
      copies: [...new Set(suggestion.copies)].sort(compareText),
    })),
    skipped: skipped.sort((left, right) => compareText(left.path, right.path)),
    filesSeen,
    truncated,
  };
};
