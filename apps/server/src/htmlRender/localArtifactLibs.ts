// @effect-diagnostics nodeBuiltinImport:off - Resolves optional bundled artifact libraries from local disk.
/**
 * Clean-room local artifact library rewriter for `HtmlRender`.
 *
 * When an HTML artifact references an allowlisted CDN UMD build of `mermaid@11`
 * (e.g. jsDelivr, unpkg, cdnjs) and a local `mermaid.min.js` bundle is present
 * on disk, rewrites the external `<script src="...">` tag to an inline
 * `<script>` so diagrams render deterministically offline with zero CDN calls.
 *
 * Module scripts (`type="module"`), non-allowlisted URLs, and environments
 * without a local bundle are left untouched.
 */
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const MERMAID_CDN_URL_RE =
  /^https?:\/\/(?:cdn\.jsdelivr\.net\/npm\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|unpkg\.com\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid\/11(?:\.\d+){1,2}\/mermaid\.min\.js)(?:\?.*)?$/i;

const RAW_TEXT_CONTAINERS = new Set(["textarea", "noscript", "title", "style", "xmp"]);
const CLOSE_SCRIPT_RE = /<\/script(?=[\s/>])/gi;

/** Parses HTML tag attributes without regex backtracking; lowercases attribute names. */
function parseHtmlAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(raw[i]!)) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(raw[i]!)) i += 1;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < len && /\s/.test(raw[i]!)) i += 1;
    let value = "";
    if (i < len && raw[i] === "=") {
      i += 1;
      while (i < len && /\s/.test(raw[i]!)) i += 1;
      if (i < len && (raw[i] === '"' || raw[i] === "'")) {
        const quote = raw[i]!;
        i += 1;
        const valStart = i;
        while (i < len && raw[i] !== quote) i += 1;
        value = raw.slice(valStart, i);
        if (i < len) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(raw[i]!)) i += 1;
        value = raw.slice(valStart, i);
      }
    }
    if (!attrs.has(name)) {
      attrs.set(name, value);
    }
  }
  return attrs;
}

function isClassicExecutableScript(attrs: Map<string, string>): boolean {
  if (attrs.has("nomodule") || attrs.has("defer") || attrs.has("async")) {
    return false;
  }
  const rawType = (attrs.get("type") ?? "").trim().toLowerCase();
  return rawType === "" || rawType === "text/javascript" || rawType === "application/javascript";
}

/** Finds the closing `>` of an HTML opening tag, respecting quoted attribute values. */
function findTagClose(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const cachedBundles = new Map<string, string | null>();

function resolveDefaultMermaidPaths(staticDir?: string): ReadonlyArray<string> {
  const candidates: string[] = [];
  if (staticDir) {
    candidates.push(NodePath.join(staticDir, "artifact-libs", "mermaid.min.js"));
  }
  const here = NodePath.dirname(fileURLToPath(import.meta.url));
  // Dev / monorepo layout: apps/server/src/htmlRender -> apps/web/node_modules/mermaid/dist/mermaid.min.js
  candidates.push(
    NodePath.resolve(here, "../../../../apps/web/node_modules/mermaid/dist/mermaid.min.js"),
    NodePath.resolve(here, "../../../web/node_modules/mermaid/dist/mermaid.min.js"),
  );
  return candidates;
}

function loadLocalMermaidBundle(candidates: ReadonlyArray<string>): string | null {
  for (const candidate of candidates) {
    const cached = cachedBundles.get(candidate);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    try {
      if (NodeFs.existsSync(candidate)) {
        const raw = NodeFs.readFileSync(candidate, "utf8");
        // Escape any literal `</script` inside the bundle so inline script tags never break out.
        const safe = raw.replace(/<\/script/gi, "<\\/script");
        cachedBundles.set(candidate, safe);
        return safe;
      }
    } catch {
      // Treat unreadable candidate as absent.
    }
    cachedBundles.set(candidate, null);
  }
  return null;
}

export interface LocalArtifactLibOptions {
  readonly staticDir?: string | undefined;
  readonly maxPageBytes: number;
  /** Optional override for tests. */
  readonly resolveMermaidSource?: (() => string | null) | undefined;
}

/**
 * Rewrites allowlisted `mermaid@11` CDN `<script>` tags to local inline scripts
 * when a local bundle is available and fits within `maxPageBytes`.
 */
export function rewriteLocalArtifactLibraries(
  html: string,
  options: LocalArtifactLibOptions,
): string {
  // Fast exit before touching disk if no mermaid URL appears anywhere in the document.
  if (!/mermaid/i.test(html)) return html;

  let safeSource: string | null = null;
  let sourceLoaded = false;
  let rewrittenCount = 0;

  const out: string[] = [];
  let cursor = 0;
  let templateDepth = 0;
  const len = html.length;

  while (cursor < len) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) {
      out.push(html.slice(cursor));
      break;
    }
    if (lt > cursor) {
      out.push(html.slice(cursor, lt));
    }

    // HTML comments: copy verbatim without scanning inside (both top-level and inside <template>).
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const next = end === -1 ? len : end + 3;
      out.push(html.slice(lt, next));
      cursor = next;
      continue;
    }

    // Closing </template> tag decrements template nesting depth.
    const closeTemplateMatch = /^<\/template(?=[\s/>])/i.exec(html.slice(lt, lt + 16));
    if (closeTemplateMatch) {
      const closeEnd = findTagClose(html, lt + closeTemplateMatch[0].length);
      if (closeEnd === -1) {
        out.push(html.slice(lt));
        break;
      }
      if (templateDepth > 0) templateDepth -= 1;
      out.push(html.slice(lt, closeEnd + 1));
      cursor = closeEnd + 1;
      continue;
    }

    // Read tag name if this starts an opening element.
    const tagMatch = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(lt, lt + 32));
    if (!tagMatch) {
      out.push("<");
      cursor = lt + 1;
      continue;
    }
    const tagName = tagMatch[1]!.toLowerCase();
    const openEnd = findTagClose(html, lt + tagMatch[0].length);
    if (openEnd === -1) {
      out.push(html.slice(lt));
      break;
    }

    if (tagName === "template") {
      templateDepth += 1;
      out.push(html.slice(lt, openEnd + 1));
      cursor = openEnd + 1;
      continue;
    }

    // Raw-text / inert containers (and any <script> inside <template>): copy through matching ASCII close tag.
    if (RAW_TEXT_CONTAINERS.has(tagName) || (tagName === "script" && templateDepth > 0)) {
      const closeRe = new RegExp(`<\\/${tagName}(?=[\\s/>])`, "gi");
      closeRe.lastIndex = openEnd + 1;
      const closeMatch = closeRe.exec(html);
      const closeEnd = closeMatch ? html.indexOf(">", closeMatch.index + closeMatch[0].length) : -1;
      const endIdx = closeEnd === -1 ? len : closeEnd + 1;
      out.push(html.slice(lt, endIdx));
      cursor = endIdx;
      continue;
    }

    if (tagName !== "script") {
      out.push(html.slice(lt, openEnd + 1));
      cursor = openEnd + 1;
      continue;
    }

    // Find matching </script> directly on the original HTML (ASCII case-insensitive,
    // no Unicode case-folding offset drift) with a real tag-name boundary.
    CLOSE_SCRIPT_RE.lastIndex = openEnd + 1;
    const closeMatch = CLOSE_SCRIPT_RE.exec(html);
    const closeScriptIdx = closeMatch ? closeMatch.index : -1;
    const closeScriptEnd = closeMatch
      ? html.indexOf(">", closeMatch.index + closeMatch[0].length)
      : -1;
    if (closeScriptEnd === -1) {
      out.push(html.slice(lt, openEnd + 1));
      cursor = openEnd + 1;
      continue;
    }

    const fullElement = html.slice(lt, closeScriptEnd + 1);
    const innerText = html.slice(openEnd + 1, closeScriptIdx);
    const attrSlice = html.slice(lt + tagMatch[0].length, openEnd);
    const attrs = parseHtmlAttributes(attrSlice);
    const src = attrs.get("src")?.trim();

    if (
      innerText.trim().length === 0 &&
      src &&
      MERMAID_CDN_URL_RE.test(src) &&
      isClassicExecutableScript(attrs)
    ) {
      if (!sourceLoaded) {
        sourceLoaded = true;
        const rawSource = options.resolveMermaidSource
          ? options.resolveMermaidSource()
          : loadLocalMermaidBundle(resolveDefaultMermaidPaths(options.staticDir));
        safeSource = rawSource ? rawSource.replace(/<\/script/gi, "<\\/script") : null;
      }
      if (safeSource !== null) {
        rewrittenCount += 1;
        if (rewrittenCount > 1) {
          out.push("<!-- mermaid@11 already inlined locally -->");
        } else {
          const nonceValue = attrs.get("nonce");
          const nonceAttr = nonceValue ? ` nonce="${nonceValue.replace(/"/g, "&quot;")}"` : "";
          out.push(`<script data-local-artifact-lib="mermaid"${nonceAttr}>${safeSource}</script>`);
        }
        cursor = closeScriptEnd + 1;
        continue;
      }
    }

    out.push(fullElement);
    cursor = closeScriptEnd + 1;
  }

  if (rewrittenCount === 0) return html;
  const candidate = out.join("");
  if (Buffer.byteLength(candidate) > options.maxPageBytes) {
    return html;
  }
  return candidate;
}
