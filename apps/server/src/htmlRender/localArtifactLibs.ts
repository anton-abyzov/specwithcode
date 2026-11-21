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

// Require whitespace immediately before `src=` so attributes like `data-src=` never match.
const MERMAID_CDN_SCRIPT_RE =
  /<script\b([^>]*?\s)src=(["'])(https?:\/\/(?:cdn\.jsdelivr\.net\/npm\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|unpkg\.com\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid\/11(?:\.\d+){1,2}\/mermaid\.min\.js)(?:\?[^"']*)?)\2([^>]*)>\s*<\/script>/gi;

const TYPE_ATTR_RE = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const NOMODULE_ATTR_RE = /(?:^|\s)nomodule(?:\s|=|$)/i;
const DEFER_OR_ASYNC_ATTR_RE = /(?:^|\s)(?:defer|async)(?:\s|=|$)/i;
const NONCE_ATTR_RE = /(?:^|\s)nonce\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function isClassicExecutableScript(attrs: string): boolean {
  if (NOMODULE_ATTR_RE.test(attrs) || DEFER_OR_ASYNC_ATTR_RE.test(attrs)) {
    return false;
  }
  const typeMatch = TYPE_ATTR_RE.exec(attrs);
  if (!typeMatch) return true;
  const rawType = (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3] ?? "").trim().toLowerCase();
  return rawType === "" || rawType === "text/javascript" || rawType === "application/javascript";
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
  MERMAID_CDN_SCRIPT_RE.lastIndex = 0;
  if (!MERMAID_CDN_SCRIPT_RE.test(html)) return html;

  const source = options.resolveMermaidSource
    ? options.resolveMermaidSource()
    : loadLocalMermaidBundle(resolveDefaultMermaidPaths(options.staticDir));
  if (!source) return html;

  const safeSource = source.replace(/<\/script/gi, "<\\/script");
  let rewrittenCount = 0;

  // Mask HTML comments before matching <script> tags so commented-out CDN references stay untouched.
  const comments: string[] = [];
  const masked = html.replace(HTML_COMMENT_RE, (comment) => {
    const idx = comments.push(comment) - 1;
    return `\u0000HTML_COMMENT_${idx}\u0000`;
  });

  MERMAID_CDN_SCRIPT_RE.lastIndex = 0;
  const rewrittenMasked = masked.replace(
    MERMAID_CDN_SCRIPT_RE,
    (fullMatch, beforeAttrs: string, _quote: string, _url: string, afterAttrs: string) => {
      const attrs = `${beforeAttrs} ${afterAttrs}`;
      if (!isClassicExecutableScript(attrs)) {
        return fullMatch;
      }
      rewrittenCount += 1;
      // Inline once; subsequent identical CDN tags become no-op comments to avoid duplicating 3.5 MB.
      if (rewrittenCount > 1) {
        return "<!-- mermaid@11 already inlined locally -->";
      }
      const nonceMatch = NONCE_ATTR_RE.exec(attrs);
      const nonceValue = nonceMatch?.[1] ?? nonceMatch?.[2] ?? nonceMatch?.[3];
      const nonceAttr = nonceValue ? ` nonce="${nonceValue.replace(/"/g, "&quot;")}"` : "";
      return `<script data-local-artifact-lib="mermaid"${nonceAttr}>${safeSource}</script>`;
    },
  );

  if (rewrittenCount === 0) return html;
  const candidate = rewrittenMasked.replace(
    /\u0000HTML_COMMENT_(\d+)\u0000/g,
    (_m, idx: string) => comments[Number(idx)] ?? "",
  );
  if (Buffer.byteLength(candidate) > options.maxPageBytes) {
    return html;
  }
  return candidate;
}
