// @effect-diagnostics nodeBuiltinImport:off - Plain promises over files inside one approved root.
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
import { countCssCustomProperties } from "./extractCss.ts";
import { collectDtcg, detectTokenJson } from "./extractDtcg.ts";
import { loadTypeScript, tsThemeKeys } from "./extractTsTheme.ts";
import { collectWeave, isWeaveTokens } from "./extractWeave.ts";

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
const MAX_FILES_SEEN = 60_000;
const COMPONENT_FOLDER_NAMES = /^(?:ui|primitives)$/;

export interface ScanOptions {
  readonly maxFilesSeen?: number;
  readonly maxCandidates?: number;
  /** Total bytes and files one scan may read. */
  readonly maxReadBytes?: number;
  readonly maxReadFiles?: number;
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
    return sourceText(normalized, buffer.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
};

interface WalkResult {
  readonly files: string[];
  readonly folders: Map<string, string[]>;
  readonly skipped: DesignSystemScanSkip[];
  readonly truncated: boolean;
}

const walk = async (realRoot: string, maxFiles: number): Promise<WalkResult> => {
  const files: string[] = [];
  const folders = new Map<string, string[]>();
  const skipped: DesignSystemScanSkip[] = [];
  let truncated = false;
  const queue: string[] = [""];
  while (queue.length > 0) {
    const folder = queue.shift()!;
    let entries;
    try {
      entries = await NodeFS.readdir(NodePath.join(realRoot, folder), { withFileTypes: true });
    } catch {
      skipped.push({ path: folder || ".", reason: "unreadable" });
      continue;
    }
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
    if (truncated) break;
  }
  return { files, folders, skipped, truncated };
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
  for (const [name, files] of [...folders].sort(([left], [right]) => compareText(left, right))) {
    if (name !== folder && !name.startsWith(`${folder}/`) && folder !== "") continue;
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

const packageRoot = (folders: ReadonlyMap<string, ReadonlyArray<string>>, path: string): string => {
  let current = folderOf(path);
  for (;;) {
    if ((folders.get(current) ?? []).includes(current ? `${current}/package.json` : "package.json"))
      return current;
    if (!current) return "";
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
  readonly themeKeys?: ReadonlyArray<string>;
  readonly weaveName?: string;
  readonly cssPrefix?: string;
}

export const scanCandidates = async (
  root: string,
  options: ScanOptions = {},
): Promise<DesignSystemScanResult> => {
  const realRoot = await NodeFS.realpath(root);
  const budget = new ReadBudget(options.maxReadBytes, options.maxReadFiles);
  const {
    files,
    folders,
    skipped,
    truncated: walkTruncated,
  } = await walk(realRoot, options.maxFilesSeen ?? MAX_FILES_SEEN);
  const maxCandidates = options.maxCandidates ?? DESIGN_SYSTEM_IMPORT_MAX_CANDIDATES;
  const counted: Counted[] = [];
  let truncated = walkTruncated;

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

  for (const path of files) {
    if (counted.length >= maxCandidates) {
      truncated = true;
      break;
    }
    const kind = kindByName(path);
    if (kind === null) continue;
    // One file that no parser can read is listed as skipped; the scan goes on.
    try {
      if (kind === "barrel") {
        const siblings = (folders.get(folderOf(path)) ?? []).filter((file) => /\.tsx$/.test(file));
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
        const count = countCssCustomProperties(source.text);
        if (count < 3) continue;
        // Class families count as components only in a system stylesheet,
        // where classes share the custom properties' prefix (`--wv-`, `.wv-`).
        const propertyPrefix = dominantPrefix(customPropertyNames(source.text));
        const classes = propertyPrefix
          ? discoverCssClasses(source, propertyPrefix).components.length
          : 0;
        const modes = new Set<string>();
        if (count >= 3) {
          if (
            /prefers-color-scheme\s*:\s*dark|\.dark\b|data-theme=["']?dark|@variant\s+dark/.test(
              source.text,
            )
          )
            modes.add("dark");
          modes.add(modes.has("dark") ? "light" : "default");
        }
        counted.push({
          candidate: base(source, "css", count, classes, [...modes].sort(compareText)),
          text: source.text,
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
  for (const [folder, inFolder] of [...folders].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const name = folder.slice(folder.lastIndexOf("/") + 1);
    if (!COMPONENT_FOLDER_NAMES.test(name) || counted.length >= maxCandidates) continue;
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

  const labels = new Map<string, string>();
  for (const item of counted) {
    const packageFolder = packageRoot(folders, item.candidate.path);
    if (labels.has(packageFolder)) continue;
    let label = packageFolder
      ? packageFolder.slice(packageFolder.lastIndexOf("/") + 1)
      : NodePath.basename(realRoot);
    try {
      const manifest = await readInsideRoot(
        realRoot,
        packageFolder ? `${packageFolder}/package.json` : "package.json",
        256 * 1024,
        budget,
      );
      const name = (JSON.parse(manifest.text) as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) label = name.replace(/^@[^/]+\//, "");
    } catch {
      // No readable manifest: keep the folder name.
    }
    labels.set(packageFolder, label);
  }
  for (const path of budget.refused) skipped.push({ path, reason: "budget" });
  return group(
    counted,
    folders,
    labels,
    skipped,
    files.length,
    truncated || budget.refused.size > 0,
  );
};

const group = (
  counted: ReadonlyArray<Counted>,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  labels: ReadonlyMap<string, string>,
  skipped: DesignSystemScanSkip[],
  filesSeen: number,
  truncated: boolean,
): DesignSystemScanResult => {
  const suggestionOf = new Map<string, string>();
  const suggestions = new Map<
    string,
    DesignSystemSuggestion & { paths: string[]; copies: string[] }
  >();
  const add = (key: string, name: string, extra: Partial<DesignSystemSuggestion> = {}) => {
    if (!suggestions.has(key))
      suggestions.set(key, { key, name, paths: [], copies: [], ...extra } as never);
    return suggestions.get(key)!;
  };
  const byPath = new Map(counted.map((item) => [item.candidate.path, item]));

  // Weave-style systems: tokens.json, the stylesheet beside it, and copies elsewhere.
  for (const item of counted) {
    if (item.candidate.kind !== "weave") continue;
    const folder = folderOf(item.candidate.path);
    const name = item.weaveName ?? (folder.slice(folder.lastIndexOf("/") + 1) || "Design system");
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const suggestion = add(key, name);
    suggestion.paths.push(item.candidate.path);
    suggestionOf.set(item.candidate.path, key);
    const sheet = counted.find(
      (other) => other.candidate.kind === "css" && folderOf(other.candidate.path) === folder,
    );
    if (!sheet?.text) continue;
    suggestion.paths.push(sheet.candidate.path);
    suggestionOf.set(sheet.candidate.path, key);
    const names = new Set(customPropertyNames(sheet.text));
    for (const other of counted) {
      if (
        other === sheet ||
        other.candidate.kind !== "css" ||
        !other.text ||
        suggestionOf.has(other.candidate.path)
      )
        continue;
      const otherNames = new Set(customPropertyNames(other.text));
      const shared = [...names].filter((entry) => otherNames.has(entry)).length;
      if (names.size > 0 && shared / names.size >= 0.8) {
        suggestion.copies.push(other.candidate.path);
        suggestionOf.set(other.candidate.path, key);
      }
    }
  }

  for (const known of KNOWN_SYSTEMS) {
    const marker = [...byPath.keys()].find(
      (path) => path === known.marker || path.endsWith(`/${known.marker}`),
    );
    if (marker === undefined) continue;
    const prefix = marker.slice(0, marker.length - known.marker.length);
    // A label only: whether the owner holds the upstream is the service's to check.
    const suggestion = add(known.key, known.name, {
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
      const key = `pkg:${packageRoot(folders, reader.candidate.path)}`;
      const suggestion = add(
        key,
        labels.get(packageRoot(folders, reader.candidate.path)) ?? "Project",
      );
      suggestion.paths.push(item.candidate.path, reader.candidate.path);
      suggestionOf.set(item.candidate.path, key);
      suggestionOf.set(reader.candidate.path, key);
    }
  }

  // Everything else groups by its package; only substantial files are preselected.
  for (const item of counted) {
    if (suggestionOf.has(item.candidate.path)) continue;
    const key = `pkg:${packageRoot(folders, item.candidate.path)}`;
    const suggestion = add(key, labels.get(packageRoot(folders, item.candidate.path)) ?? "Project");
    suggestionOf.set(item.candidate.path, key);
    const substantial =
      item.candidate.kind !== "css" ||
      item.candidate.tokenCount >= 10 ||
      item.candidate.componentCount >= 5;
    if (substantial) suggestion.paths.push(item.candidate.path);
  }

  const candidates = counted
    .map((item) => ({ ...item.candidate, suggestion: suggestionOf.get(item.candidate.path) ?? "" }))
    .sort((left, right) => compareText(left.path, right.path));
  return {
    candidates,
    suggestions: [...suggestions.values()]
      .map((suggestion) => ({
        ...suggestion,
        paths: [...suggestion.paths].sort(compareText),
        copies: [...suggestion.copies].sort(compareText),
      }))
      .sort((left, right) => compareText(left.key, right.key)),
    skipped: skipped.sort((left, right) => compareText(left.path, right.path)),
    filesSeen,
    truncated,
  };
};
