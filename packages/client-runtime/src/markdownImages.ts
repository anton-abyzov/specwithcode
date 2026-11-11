import { mediaKindFromPath } from "@specweave-studio/shared/filePreview";
import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";

import {
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
  stripSlashPrefixedWindowsDrive,
} from "./markdownLinks.ts";

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string }
  | { readonly _tag: "Blocked" };

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/**
 * Classifies a markdown image or video source by where its bytes must be loaded from.
 * Filesystem paths belong to the environment host and must never reach a
 * browser or native image component without first becoming a signed asset URL.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };

  const source = normalizeMarkdownLinkDestination(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) {
    return { _tag: "Blocked" };
  }
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) {
    return { _tag: "Direct", uri: source };
  }

  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? { _tag: "Blocked" }
      : {
          _tag: "WorkspaceFile",
          path: stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path)),
        };
  }

  const path = stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) {
    return { _tag: "WorkspaceFile", path };
  }
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return { _tag: "Blocked" };
  }
  if (!workspaceRoot) return { _tag: "Blocked" };

  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path) };
}

export interface UnembeddedMedia {
  /** Absolute path on the thread's host, as the message wrote it. */
  readonly path: string;
  readonly kind: "image" | "video";
}

const FENCED_CODE_PATTERN =
  /(^|\n) {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/g;
// One pass over inline code spans, then Markdown images and links, in the order they appear.
const CODE_OR_LINK_PATTERN =
  /(`+)([^\n]*?[^`\n])\1(?!`)|(!?)\[(?:[^\]\\\n]|\\.)*\]\(\s*(<[^>\n]+>|[^)\s]+)[^)\n]*\)/g;
const HTML_MEDIA_PATTERN = /<(?:img|video|picture)\b/i;

function absoluteMediaPath(value: string): UnembeddedMedia | null {
  const source = classifyMarkdownImageSource(value.trim());
  if (source._tag !== "WorkspaceFile") return null;
  const kind = mediaKindFromPath(source.path);
  return kind === null ? null : { path: source.path, kind };
}

/**
 * The first image or video a message names by absolute path, in a code span or
 * a link, when the message embeds no media of its own. Agents usually report
 * media as a path in backticks, which shows no picture on a device that is not
 * the thread's host; clients show this one file as a thumbnail under the
 * message. Null when the message already carries a Markdown or HTML image or
 * video, since what the author embedded always wins, and null when it names
 * none. Fenced code is skipped: a path in a log or a script is not a result.
 */
export function firstUnembeddedMedia(markdown: string): UnembeddedMedia | null {
  if (!markdown.includes("/") && !markdown.includes("\\")) return null;
  const prose = markdown.replace(FENCED_CODE_PATTERN, "$1");
  let first: UnembeddedMedia | null = null;
  let outsideCode = "";
  let cursor = 0;
  for (const match of prose.matchAll(CODE_OR_LINK_PATTERN)) {
    outsideCode += prose.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[3] === "!") return null;
    const target = match[2] ?? match[4]?.replace(/^<|>$/g, "");
    if (first === null && target !== undefined) first = absoluteMediaPath(target);
  }
  if (first === null) return null;
  return HTML_MEDIA_PATTERN.test(outsideCode + prose.slice(cursor)) ? null : first;
}
