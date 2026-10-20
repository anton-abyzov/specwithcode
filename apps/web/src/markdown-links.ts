import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  looksLikeHostname,
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "@specweave-studio/client-runtime/markdown-links";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation, resolvePathLinkTarget } from "./terminal-links";

export { normalizeMarkdownLinkDestination };

const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  /** Last line of a `file.ts:12-20` range; the link opens at `line`. */
  endLine?: number;
  /** Shown instead of the file name: a bare `:12-20` keeps reading as written. */
  label?: string;
  /** Written as a folder (`png/app/`): opens in the file manager, not a viewer. */
  directory?: true;
  /**
   * Every place a relative path may point, most likely first; set only when
   * the message names another folder the path may be relative to. The first
   * one that exists on the host wins.
   */
  candidates?: ReadonlyArray<string>;
  /**
   * Where to search by file name when no candidate exists, with the path as
   * the message wrote it (`CoordinatorConversation.tsx`, `apps/web/x.ts`).
   */
  search?: { readonly roots: ReadonlyArray<string>; readonly path: string };
  /** Every path the host was asked about when none of them exists. */
  unresolved?: ReadonlyArray<string>;
  /**
   * The files shell shorthand stands for (`findings-{B,C}.md`, `shot-*.png`),
   * each its own link. The link itself is the path as written, which the host
   * may still hold under that very name.
   */
  expansions?: ReadonlyArray<MarkdownFileLinkMeta>;
  /** A file name pattern (`findings-*.md`) the host's listing of `folder` settles. */
  glob?: { readonly folder: string; readonly pattern: string };
}

/** Wider than this, shorthand is a pattern, not a list of files a report names. */
const MAX_SHORTHAND_PATHS = 32;
const NUMERIC_RANGE_PATTERN = /^(-?\d+)\.\.(-?\d+)$/;
const LETTER_RANGE_PATTERN = /^([A-Za-z])\.\.([A-Za-z])$/;

function braceRange(body: string): string[] | null {
  const numeric = NUMERIC_RANGE_PATTERN.exec(body);
  if (numeric) {
    const [from, to] = [Number(numeric[1]), Number(numeric[2])];
    if (Math.abs(to - from) >= MAX_SHORTHAND_PATHS) return [];
    // `{01..03}` pads like the shell does.
    const padded = /^-?0\d/.test(numeric[1]!) || /^-?0\d/.test(numeric[2]!);
    const width = padded ? Math.max(numeric[1]!.length, numeric[2]!.length) : 0;
    const step = from <= to ? 1 : -1;
    const values: string[] = [];
    for (let value = from; value !== to + step; value += step) {
      values.push(String(value).padStart(width, "0"));
    }
    return values;
  }
  const letters = LETTER_RANGE_PATTERN.exec(body);
  if (!letters) return null;
  const [from, to] = [letters[1]!.charCodeAt(0), letters[2]!.charCodeAt(0)];
  if (Math.abs(to - from) >= MAX_SHORTHAND_PATHS) return [];
  const step = from <= to ? 1 : -1;
  const values: string[] = [];
  for (let code = from; code !== to + step; code += step) values.push(String.fromCharCode(code));
  return values;
}

/** The comma-separated parts of a brace body, nested groups kept whole. */
function braceAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function expandBraces(text: string, from: number, state: { overflow: boolean }): string[] | null {
  for (let open = text.indexOf("{", from); open >= 0; open = text.indexOf("{", open + 1)) {
    // `${HOME}` is a variable, not a list.
    if (open > 0 && (text[open - 1] === "$" || text[open - 1] === "\\")) continue;
    let depth = 0;
    let close = -1;
    for (let index = open; index < text.length; index++) {
      if (text[index] === "{") depth++;
      else if (text[index] === "}" && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) return null;
    const body = text.slice(open + 1, close);
    const alternatives = braceAlternatives(body);
    // `{id}` alone stays as written, as in the shell.
    const parts = alternatives.length > 1 ? alternatives : braceRange(body);
    if (parts === null) continue;
    if (parts.length === 0) state.overflow = true;
    const head = text.slice(0, open);
    const tail = text.slice(close + 1);
    const paths: string[] = [];
    for (const part of parts) {
      const joined = `${head}${part}${tail}`;
      paths.push(...(expandBraces(joined, open, state) ?? [joined]));
      if (state.overflow || paths.length > MAX_SHORTHAND_PATHS) {
        state.overflow = true;
        return [];
      }
    }
    return paths;
  }
  return null;
}

/**
 * The paths shell brace shorthand stands for: `findings-{B,C}.md` is
 * `findings-B.md` and `findings-C.md`, `shot-{1..3}.png` is three files, and
 * groups nest. Null when the text has none: `${HOME}` and a lone `{id}` are
 * not shorthand. Empty when it stands for more paths than a report would list.
 */
export function expandBraceShorthand(text: string): string[] | null {
  const state = { overflow: false };
  const paths = expandBraces(text, 0, state);
  if (paths === null) return null;
  if (state.overflow) return [];
  return [...new Set(paths.filter((path) => path.length > 0))];
}

/** `*` in a file name, never in a folder: the host's listing of that folder settles it. */
export function basenameGlob(path: string): { folder: string; pattern: string } | null {
  const slash = path.lastIndexOf("/");
  const pattern = path.slice(slash + 1);
  if (!/[*?]/.test(pattern) || slash <= 0 || /[*?]/.test(path.slice(0, slash))) return null;
  return { folder: path.slice(0, slash), pattern };
}

/** Whether a file name matches a `*`/`?` pattern; every other character is literal. */
export function matchesFileNamePattern(name: string, pattern: string): boolean {
  const source = [...pattern]
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * `baseDir` anchors relative links; it defaults to the workspace root and is the
 * file's own directory when rendering a markdown file. `cwd` stays the workspace
 * root so the result still knows whether the target is inside it.
 */
export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) return pathWithPosition;
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const shorthand = shorthandFileLinkMeta(codeText.trim(), (path) =>
    singleInlineCodeFileLinkMeta(path, cwd, baseDir),
  );
  if (shorthand !== undefined) return shorthand && withLiteralPath(shorthand, cwd, baseDir);
  return singleInlineCodeFileLinkMeta(codeText, cwd, baseDir);
}

type ShorthandFileLinks =
  | { readonly kind: "brace"; readonly text: string; readonly expansions: MarkdownFileLinkMeta[] }
  | { readonly kind: "glob"; readonly text: string; readonly meta: MarkdownFileLinkMeta };

/**
 * Shell shorthand that names files: every path a brace group stands for must
 * read as a file, and a `*` must sit in a file name. Undefined when the text
 * is not shorthand, null when it is but does not name files.
 */
function shorthandFileLinkMeta(
  text: string,
  resolve: (path: string) => MarkdownFileLinkMeta | null,
): ShorthandFileLinks | null | undefined {
  const paths = expandBraceShorthand(text);
  if (paths !== null) {
    if (paths.length < 2) return paths.length === 0 ? null : undefined;
    // `shot-{1,2}-*.png` is patterns, not files: it stays as written.
    if (paths.some((path) => /[*?]/.test(path))) return null;
    const expansions = paths.map(resolve);
    return expansions.every((meta) => meta !== null)
      ? { kind: "brace", text, expansions: expansions as MarkdownFileLinkMeta[] }
      : null;
  }
  if (!/[*?]/.test(text)) return undefined;
  // Path-shaped once the pattern is a name: `~/out/shot-*.png`, `logs/findings-?.md`.
  // A `?` would read as a URL query, so it resolves as a stand-in and comes back.
  const meta =
    resolve(text.replace(/[*?]/g, "x")) === null
      ? null
      : withQuestionMarks(resolve(text.replaceAll("?", QUESTION_MARK)));
  return meta && basenameGlob(meta.filePath) ? { kind: "glob", text, meta } : null;
}

const QUESTION_MARK = "\uE000";

function withQuestionMarks(meta: MarkdownFileLinkMeta | null): MarkdownFileLinkMeta | null {
  return meta && JSON.parse(JSON.stringify(meta).replaceAll(QUESTION_MARK, "?"));
}

/** The link for shorthand: the path as written, which settles into its files. */
function withLiteralPath(
  shorthand: ShorthandFileLinks,
  cwd: string | undefined,
  baseDir: string | undefined,
): MarkdownFileLinkMeta {
  if (shorthand.kind === "glob") {
    return { ...shorthand.meta, glob: basenameGlob(shorthand.meta.filePath)! };
  }
  const target =
    baseDir !== undefined && isRelativeFilePath(shorthand.text)
      ? resolvePathLinkTarget(shorthand.text, baseDir)
      : shorthand.text;
  return { ...buildFileLinkMetaFromTarget(target, cwd), expansions: shorthand.expansions };
}

function singleInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const trimmed = codeText.trim();
  const directory = inlineCodeDirectoryCandidate(trimmed);
  if (directory !== null) {
    const meta = resolveMarkdownFileLinkMeta(directory, cwd, baseDir);
    if (!meta) return null;
    return fileLinkMetaAtPath(
      { ...meta, directory: true },
      meta.filePath.replaceAll("/./", "/"),
      cwd,
    );
  }
  // `serverRuntimeStartup.ts:353-357`: a line range opens at its first line.
  const range = LINE_RANGE_PATTERN.exec(trimmed);
  if (range && !trimmed.startsWith(":")) {
    const meta = singleInlineCodeFileLinkMeta(range[1]!, cwd, baseDir);
    const endLine = Number(range[2]);
    return meta && meta.line !== undefined && endLine > meta.line ? { ...meta, endLine } : meta;
  }
  const candidate = inlineCodeFilePathCandidate(codeText) ?? bareDocumentFileName(trimmed);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(candidate, cwd, baseDir);
}

const LINE_RANGE_PATTERN = /^(.+:\d+)\s*[-–]\s*(\d+)$/;
// `:396-399` or `:238` after a file reference: lines in that same file.
const BARE_LINE_REFERENCE_PATTERN = /^:(\d+)(?:\s*[-–]\s*(\d+))?$/;

// `png/app/`, `explorations/`, `~/Projects/app/`: a trailing slash is how a
// report names a folder.
const INLINE_CODE_DIRECTORY_PATTERN = /^(?:~\/|\.{1,2}\/|\/)?(?:[A-Za-z0-9._@-]+\/)+$/;
// `origin/` names a remote's branches, not a folder.
const GIT_REMOTE_NAMES = new Set(["origin", "upstream", "fork"]);
const EXPLICIT_PATH_PREFIX_PATTERN = /^(?:~\/|\.{1,2}\/|\/)/;

function inlineCodeDirectoryCandidate(text: string): string | null {
  if (!INLINE_CODE_DIRECTORY_PATTERN.test(text)) return null;
  const path = text.replace(/\/+$/, "");
  if (path.length === 0 || path === "~" || /^\.{1,2}$/.test(path)) return null;
  const firstSegment = path.replace(EXPLICIT_PATH_PREFIX_PATTERN, "").split("/")[0] ?? "";
  if (looksLikeHostname(firstSegment, false)) return null;
  if (!path.includes("/") && GIT_REMOTE_NAMES.has(path)) return null;
  // A lone segment needs `./` to read as a path rather than a word.
  return EXPLICIT_PATH_PREFIX_PATTERN.test(path) || path.includes("/") ? path : `./${path}`;
}

// Bare names only for documents and media, which a report names as
// deliverables (`README.md`, `logo.svg`); `Node.js` or `index.ts` in prose
// stay code.
const BARE_DOCUMENT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "pdf",
  "html",
  "csv",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "icns",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
  "m4a",
  // Packages and office files a worker hands over to upload or send.
  "zip",
  "tgz",
  "gz",
  "dmg",
  "pkg",
  "crx",
  "docx",
  "xlsx",
  "pptx",
]);

function bareDocumentFileName(text: string): string | null {
  const match = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.([A-Za-z0-9]+)$/.exec(text);
  return match && BARE_DOCUMENT_EXTENSIONS.has(match[1]!.toLowerCase()) ? text : null;
}

/** A path written relative to nothing in particular: no `/`, `~/`, `./` or `../`. */
function isPlainRelativePath(text: string): boolean {
  return !EXPLICIT_PATH_PREFIX_PATTERN.test(text) && isRelativeFilePath(text);
}

/** A path whose last segment has no extension: a folder, unless the host says otherwise. */
export function mayBeDirectory(meta: MarkdownFileLinkMeta): boolean {
  if (meta.directory) return true;
  if (meta.line !== undefined) return false;
  return (
    !/\.[A-Za-z0-9_-]+$/.test(meta.basename) &&
    !/^[A-Z][A-Za-z]*file$|^(?:LICENSE|README|CHANGELOG|NOTICE|AUTHORS|CODEOWNERS)$/.test(
      meta.basename,
    )
  );
}

/**
 * The folders a message's plain relative paths may be written against, when
 * they are not the workspace, most likely first. A worker that built files in
 * `~/Projects/logo` writes `~/Projects/logo/png/sheet.png` once and then
 * `svg/icon.svg`: the first segment of a relative path (`png`) found in an
 * absolute one marks the folder above it. A folder the message names outside
 * the workspace (`../specweave-wt-code-captures`, a sibling worktree) is one
 * too. Which one holds a file is settled on the host.
 */
export function inferInlineCodeBaseDirs(
  spans: ReadonlyArray<string>,
  cwd?: string,
  baseDir: string | undefined = cwd,
): { readonly forPaths: string[]; readonly forNames: string[] } {
  const externalDirectories: string[][] = [];
  const namedFolders: string[] = [];
  const fileFolders: string[] = [];
  const firstSegments: string[] = [];
  for (const span of expandedSpans(spans)) {
    const text = span.trim();
    const meta = resolveInlineCodeFileLinkMeta(text, cwd, baseDir);
    if (!meta) continue;
    if (isPlainRelativePath(text)) {
      const segments = text.split("/");
      if (segments.length > 1) firstSegments.push(segments[0]!);
    } else if (meta.workspaceRelativePath === null && meta.filePath.startsWith("/")) {
      const folder = mayBeDirectory(meta);
      const segments = meta.filePath.split("/");
      externalDirectories.push(folder ? segments : segments.slice(0, -1));
      if (folder) namedFolders.push(meta.filePath);
      else fileFolders.push(segments.slice(0, -1).join("/"));
    }
  }
  const bases: string[] = [];
  for (const segment of firstSegments) {
    for (const directories of externalDirectories) {
      const index = directories.lastIndexOf(segment);
      if (index > 1) bases.push(directories.slice(0, index).join("/"));
    }
  }
  const matched = [...bases];
  bases.push(...namedFolders);
  const keep = (list: string[]) =>
    [...new Set(list)].filter((base) => base.length > 0 && base !== cwd);
  // A bare file name sits beside the files the message named ("the same
  // folder") before anywhere else; a path with folders does not.
  return { forPaths: keep(bases), forNames: keep([...matched, ...fileFolders, ...namedFolders]) };
}

/**
 * File links for a message's inline code spans. Plain relative paths resolve
 * against the folders the message names (see `inferInlineCodeBaseDirs`) first
 * and the workspace last.
 */
export function resolveInlineCodeFileLinks(
  spans: ReadonlyArray<string>,
  cwd?: string,
  baseDir: string | undefined = cwd,
  contextFolders: ReadonlyArray<string> = [],
): Map<string, MarkdownFileLinkMeta> {
  const ownBaseDirs = inferInlineCodeBaseDirs(spans, cwd, baseDir);
  // A bare name may sit in a folder an earlier message named; the message's
  // own folders come first.
  const inferredBaseDirs = {
    forPaths: ownBaseDirs.forPaths,
    forNames: [...new Set([...ownBaseDirs.forNames, ...contextFolders])].filter(
      (folder) => folder !== cwd,
    ),
  };
  const metaByText = new Map<string, MarkdownFileLinkMeta>();
  let lastFile: MarkdownFileLinkMeta | null = null;
  for (const span of spans) {
    const bareLines = BARE_LINE_REFERENCE_PATTERN.exec(span.trim());
    if (bareLines) {
      if (lastFile !== null && !metaByText.has(span)) {
        const line = Number(bareLines[1]);
        const endLine = bareLines[2] === undefined ? undefined : Number(bareLines[2]);
        metaByText.set(span, {
          ...fileLinkMetaAtPath({ line }, lastFile.filePath, cwd),
          ...(endLine !== undefined && endLine > line ? { endLine } : {}),
          ...(lastFile.candidates ? { candidates: lastFile.candidates } : {}),
          label: span.trim().replace("-", "–"),
        });
      }
      continue;
    }
    if (metaByText.has(span)) {
      const known = metaByText.get(span)!;
      if (!known.directory) lastFile = known.expansions?.at(-1) ?? known;
      continue;
    }
    const shorthand = shorthandFileLinkMeta(span.trim(), (path) =>
      settleInlineCodeFileLink(path, cwd, baseDir, inferredBaseDirs),
    );
    const settled =
      shorthand === undefined
        ? settleInlineCodeFileLink(span, cwd, baseDir, inferredBaseDirs)
        : shorthand && withLiteralPath(shorthand, cwd, baseDir);
    if (!settled) continue;
    metaByText.set(span, settled);
    if (!settled.directory) lastFile = settled.expansions?.at(-1) ?? settled;
  }
  return metaByText;
}

/** One path of a message, with the other places it may live (see `resolveInlineCodeFileLinks`). */
function settleInlineCodeFileLink(
  span: string,
  cwd: string | undefined,
  baseDir: string | undefined,
  inferredBaseDirs: { readonly forPaths: string[]; readonly forNames: string[] },
): MarkdownFileLinkMeta | null {
  const meta = singleInlineCodeFileLinkMeta(span, cwd, baseDir);
  if (!meta) return null;
  const plain = isPlainRelativePath(span.trim());
  const bases = span.trim().includes("/") ? inferredBaseDirs.forPaths : inferredBaseDirs.forNames;
  const inferred = plain
    ? bases.flatMap((base) => {
        const resolved = singleInlineCodeFileLinkMeta(span, cwd, base);
        return resolved && resolved.filePath !== meta.filePath ? [resolved] : [];
      })
    : [];
  const search = plain
    ? {
        roots: [...bases, ...(cwd ? [cwd] : [])],
        path: span
          .trim()
          .replace(/(?::\d+){1,2}(?:\s*[-–]\s*\d+)?$/, "")
          .replace(/\/+$/, ""),
      }
    : null;
  return {
    ...(inferred.length > 0
      ? {
          ...inferred[0]!,
          candidates: [...inferred.map((candidate) => candidate.filePath), meta.filePath],
        }
      : meta),
    ...(search ? { search } : {}),
  };
}

/** A message's spans with shorthand written out, so folders come from real paths. */
function expandedSpans(spans: ReadonlyArray<string>): string[] {
  return spans.flatMap((span) => expandBraceShorthand(span.trim()) ?? [span]);
}

/** The link for one of a link's candidate paths, keeping its folder flag. */
export function fileLinkMetaAtPath(
  meta: Pick<MarkdownFileLinkMeta, "line" | "column" | "endLine" | "label" | "directory">,
  filePath: string,
  cwd?: string,
): MarkdownFileLinkMeta {
  const position =
    meta.line === undefined
      ? ""
      : `:${meta.line}${meta.column === undefined ? "" : `:${meta.column}`}`;
  return {
    ...buildFileLinkMetaFromTarget(`${filePath}${position}`, cwd),
    ...(meta.endLine !== undefined ? { endLine: meta.endLine } : {}),
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    ...(meta.directory ? { directory: true as const } : {}),
  };
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

// Fences a worker lists files in: no language, or plain text.
const PATH_LIST_LANGUAGES = new Set(["", "text", "txt", "plain", "plaintext"]);
const MAX_PATH_LIST_LINES = 50;

function isPathListLine(line: string): boolean {
  if (/\s/.test(line)) return false;
  const expanded = expandBraceShorthand(line);
  if (expanded !== null && expanded.length > 1) return expanded.every(isPathListLine);
  return (
    inlineCodeFilePathCandidate(line) !== null ||
    bareDocumentFileName(line) !== null ||
    inlineCodeDirectoryCandidate(line) !== null
  );
}

/**
 * The paths of a fenced block that lists files and nothing else, one per line
 * (`/Users/me/cws/icon-128.png`, `screenshot-1.png`), or null. A command, a
 * placeholder like `(leave empty)` or a language other than plain text makes
 * it code.
 */
export function pathListLines(code: string, language = ""): string[] | null {
  if (!PATH_LIST_LANGUAGES.has(language.trim().toLowerCase())) return null;
  const lines = code
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u200B\u2060\uFEFF\u00AD]/g, "").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_PATH_LIST_LINES) return null;
  return lines.every(isPathListLine) ? lines : null;
}

const FENCED_BLOCK_PATTERN =
  /(?:^|\n) {0,3}(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)\n {0,3}\1[ \t]*(?=\n|$)/g;
const UNFENCED_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$))/;
const INLINE_SPAN_PATTERN = /`([^`\n]+)`/g;

/** The paths of every fenced path list in a message, in order. */
export function fencedPathListLines(text: string): string[] {
  const lines: string[] = [];
  for (const match of text.matchAll(FENCED_BLOCK_PATTERN)) {
    const language = (match[2] ?? "").trim().split(/\s+/)[0] ?? "";
    lines.push(...(pathListLines(match[3] ?? "", language) ?? []));
  }
  return lines;
}

/**
 * Every span of a message that may name a file: inline code outside fences,
 * then the lines of fenced path lists.
 */
export function fileReferenceSpans(text: string): string[] {
  const spans: string[] = [];
  const segments = text.split(UNFENCED_SEGMENT_PATTERN);
  for (let index = 0; index < segments.length; index += 2) {
    for (const match of (segments[index] ?? "").matchAll(INLINE_SPAN_PATTERN)) {
      const span = match[1]?.trim();
      if (span) spans.push(span);
    }
  }
  return [...spans, ...fencedPathListLines(text)];
}

const MAX_CONTEXT_FOLDERS = 4;

/**
 * Folders outside the workspace that a thread's messages name files in or
 * name outright, the latest first. A reply that lists `icon-128.png` after an
 * earlier one put files in `~/Downloads/cws/` finds it there.
 */
export function threadFileFolders(texts: ReadonlyArray<string>, cwd?: string): string[] {
  const folders: string[] = [];
  for (const text of texts.toReversed()) {
    const spans = expandedSpans(fileReferenceSpans(text)).toReversed();
    for (const span of spans) {
      const meta = resolveInlineCodeFileLinkMeta(span, cwd);
      if (!meta || meta.workspaceRelativePath !== null || !meta.filePath.startsWith("/")) continue;
      const folder = mayBeDirectory(meta)
        ? meta.filePath
        : meta.filePath.slice(0, meta.filePath.lastIndexOf("/"));
      if (folder.length <= 1 || folder === cwd || folders.includes(folder)) continue;
      folders.push(folder);
      if (folders.length === MAX_CONTEXT_FOLDERS) return folders;
    }
  }
  return folders;
}
