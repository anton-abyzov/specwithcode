// @effect-diagnostics nodeBuiltinImport:off - Pure path arithmetic on the host's own path rules.
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agent HTML served from a signed URL names its pictures by host path:
 * `<img src="/Users/me/shot.png">` or a sibling `src="shot.png"`. Neither
 * resolves against the asset URL, so the server swaps each one for a signed URL
 * of its own. Only `src`, `poster` and `srcset` values are touched; anything
 * with a scheme, a fragment or a protocol-relative host is left as written.
 * Paths come back in the host's own form, so a Windows host gets `C:\\...`
 * from `C:\\...`, `C:/...` and `file:///C:/...` alike.
 */

/** The host's path rules; tests pass `NodePath.posix` or `NodePath.win32`. */
export type HostPathRules = typeof NodePath.posix;

/** Generous for a report, small enough to rewrite in memory. */
export const HTML_LOCAL_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
/** A page naming more files than this keeps the rest as written. */
export const HTML_LOCAL_REFERENCE_MAX_COUNT = 200;

const ATTRIBUTE_PATTERN = /(\s(?:src|poster|srcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The host path a reference names, or null when it is not a local file. */
export function localReferencePath(
  value: string,
  htmlFilePath: string,
  rules: HostPathRules = NodePath,
): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
  const windows = rules.sep === "\\";
  let candidate: string;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      // A file URL on another machine (`file://server/share`) is not this host's file.
      if (url.host !== "" && url.host !== "localhost") return null;
      url.host = "";
      url.search = "";
      url.hash = "";
      const filePath = fileURLToPath(url, { windows });
      return filePath.includes("\0") ? null : rules.normalize(filePath);
    } catch {
      return null;
    }
  } else if (windows && /^[a-z]:[\\/]/i.test(trimmed)) {
    // A drive path, not a URL scheme.
    candidate = trimmed;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  } else {
    candidate = trimmed;
  }
  const withoutSuffix = candidate.split(/[?#]/, 1)[0] ?? "";
  if (withoutSuffix.length === 0) return null;
  const decoded = decodeOnce(withoutSuffix);
  if (decoded.includes("\0")) return null;
  return rules.isAbsolute(decoded)
    ? rules.normalize(decoded)
    : rules.resolve(rules.dirname(htmlFilePath), decoded);
}

function srcsetEntries(
  value: string,
): Array<{ readonly url: string; readonly descriptor: string }> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const space = part.search(/\s/);
      return space < 0
        ? { url: part, descriptor: "" }
        : { url: part.slice(0, space), descriptor: part.slice(space) };
    });
}

/** Every distinct local path the document references, in document order, capped. */
export function htmlLocalReferencePaths(
  html: string,
  htmlFilePath: string,
  rules: HostPathRules = NodePath,
): string[] {
  const paths = new Set<string>();
  for (const match of html.matchAll(ATTRIBUTE_PATTERN)) {
    const attribute = (match[1] ?? "").trim().toLowerCase();
    const value = match[2] ?? match[3] ?? "";
    const urls = attribute.startsWith("srcset")
      ? srcsetEntries(value).map((entry) => entry.url)
      : [value];
    for (const url of urls) {
      const local = localReferencePath(url, htmlFilePath, rules);
      if (local !== null) paths.add(local);
      if (paths.size >= HTML_LOCAL_REFERENCE_MAX_COUNT) return [...paths];
    }
  }
  return [...paths];
}

/** Characters that would end an attribute value or start an entity. */
function attributeSafe(url: string): string {
  return url.replace(
    /["'<>&\s]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/**
 * Replaces each reference whose path has a signed URL in `urls`. References
 * without one (missing, protected, not media) stay exactly as written.
 */
export function rewriteHtmlLocalReferences(
  html: string,
  htmlFilePath: string,
  urls: ReadonlyMap<string, string>,
  rules: HostPathRules = NodePath,
): string {
  if (urls.size === 0) return html;
  const replace = (value: string) => {
    const local = localReferencePath(value, htmlFilePath, rules);
    const signed = local === null ? undefined : urls.get(local);
    return signed === undefined ? value : attributeSafe(signed);
  };
  return html.replace(
    ATTRIBUTE_PATTERN,
    (whole, prefix: string, doubleQuoted?: string, singleQuoted?: string) => {
      const quote = doubleQuoted === undefined ? "'" : '"';
      const value = doubleQuoted ?? singleQuoted ?? "";
      const rewritten = prefix.trim().toLowerCase().startsWith("srcset")
        ? srcsetEntries(value)
            .map((entry) => `${replace(entry.url)}${entry.descriptor}`)
            .join(", ")
        : replace(value);
      return rewritten === value ? whole : `${prefix}${quote}${rewritten}${quote}`;
    },
  );
}
