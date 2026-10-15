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
  /** Written as a folder (`png/app/`): opens in the file manager, not a viewer. */
  directory?: true;
  /**
   * Every place a relative path may point, most likely first; set only when
   * the message names another folder the path may be relative to. The first
   * one that exists on the host wins.
   */
  candidates?: ReadonlyArray<string>;
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
  const candidate = inlineCodeFilePathCandidate(codeText) ?? bareDocumentFileName(trimmed);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(candidate, cwd, baseDir);
}

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
]);

function bareDocumentFileName(text: string): string | null {
  const match = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.([A-Za-z0-9]+)$/.exec(text);
  return match && BARE_DOCUMENT_EXTENSIONS.has(match[1]!.toLowerCase()) ? text : null;
}

/** A path written relative to nothing in particular: no `/`, `~/`, `./` or `../`. */
function isPlainRelativePath(text: string): boolean {
  return !EXPLICIT_PATH_PREFIX_PATTERN.test(text) && isRelativeFilePath(text);
}

/**
 * The folder a message's plain relative paths are written against, when it is
 * not the workspace. A worker that built files in `~/Projects/logo` writes
 * `~/Projects/logo/png/sheet.png` once and then `svg/icon.svg`; the first
 * segment of a relative path (`png`) found in an absolute one marks the folder
 * above it (`~/Projects/logo`) as the base for the whole message.
 */
export function inferInlineCodeBaseDir(
  spans: ReadonlyArray<string>,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  const externalDirectories: string[][] = [];
  const firstSegments: string[] = [];
  for (const span of spans) {
    const text = span.trim();
    const meta = resolveInlineCodeFileLinkMeta(text, cwd, baseDir);
    if (!meta) continue;
    if (isPlainRelativePath(text)) {
      const segments = text.split("/");
      if (segments.length > 1) firstSegments.push(segments[0]!);
    } else if (meta.workspaceRelativePath === null && meta.filePath.startsWith("/")) {
      const segments = meta.filePath.split("/");
      externalDirectories.push(meta.directory ? segments : segments.slice(0, -1));
    }
  }
  for (const segment of firstSegments) {
    for (const directories of externalDirectories) {
      const index = directories.lastIndexOf(segment);
      if (index > 1) return directories.slice(0, index).join("/");
    }
  }
  return null;
}

/**
 * File links for a message's inline code spans. Plain relative paths resolve
 * against the folder the message names (see `inferInlineCodeBaseDir`) first
 * and the workspace second.
 */
export function resolveInlineCodeFileLinks(
  spans: ReadonlyArray<string>,
  cwd?: string,
  baseDir: string | undefined = cwd,
): Map<string, MarkdownFileLinkMeta> {
  const inferredBaseDir = inferInlineCodeBaseDir(spans, cwd, baseDir);
  const metaByText = new Map<string, MarkdownFileLinkMeta>();
  for (const span of spans) {
    if (metaByText.has(span)) continue;
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, baseDir);
    if (!meta) continue;
    const inferred =
      inferredBaseDir !== null && isPlainRelativePath(span.trim())
        ? resolveInlineCodeFileLinkMeta(span, cwd, inferredBaseDir)
        : null;
    metaByText.set(
      span,
      inferred && inferred.filePath !== meta.filePath
        ? { ...inferred, candidates: [inferred.filePath, meta.filePath] }
        : meta,
    );
  }
  return metaByText;
}

/** The link for one of a link's candidate paths, keeping its folder flag. */
export function fileLinkMetaAtPath(
  meta: MarkdownFileLinkMeta,
  filePath: string,
  cwd?: string,
): MarkdownFileLinkMeta {
  const position =
    meta.line === undefined
      ? ""
      : `:${meta.line}${meta.column === undefined ? "" : `:${meta.column}`}`;
  return {
    ...buildFileLinkMetaFromTarget(`${filePath}${position}`, cwd),
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
