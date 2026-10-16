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
  // `serverRuntimeStartup.ts:353-357`: a line range opens at its first line.
  const range = LINE_RANGE_PATTERN.exec(trimmed);
  if (range && !trimmed.startsWith(":")) {
    const meta = resolveInlineCodeFileLinkMeta(range[1]!, cwd, baseDir);
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
  for (const span of spans) {
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
): Map<string, MarkdownFileLinkMeta> {
  const inferredBaseDirs = inferInlineCodeBaseDirs(spans, cwd, baseDir);
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
      if (!known.directory) lastFile = known;
      continue;
    }
    const meta = resolveInlineCodeFileLinkMeta(span, cwd, baseDir);
    if (!meta) continue;
    const bases = span.trim().includes("/") ? inferredBaseDirs.forPaths : inferredBaseDirs.forNames;
    const inferred = isPlainRelativePath(span.trim())
      ? bases.flatMap((base) => {
          const resolved = resolveInlineCodeFileLinkMeta(span, cwd, base);
          return resolved && resolved.filePath !== meta.filePath ? [resolved] : [];
        })
      : [];
    const plain = isPlainRelativePath(span.trim());
    const search = plain
      ? {
          roots: [...bases, ...(cwd ? [cwd] : [])],
          path: span
            .trim()
            .replace(/(?::\d+){1,2}(?:\s*[-–]\s*\d+)?$/, "")
            .replace(/\/+$/, ""),
        }
      : null;
    const settled: MarkdownFileLinkMeta = {
      ...(inferred.length > 0
        ? {
            ...inferred[0]!,
            candidates: [...inferred.map((candidate) => candidate.filePath), meta.filePath],
          }
        : meta),
      ...(search ? { search } : {}),
    };
    metaByText.set(span, settled);
    if (!settled.directory) lastFile = settled;
  }
  return metaByText;
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
