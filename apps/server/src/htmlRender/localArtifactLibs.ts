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
 *
 * SpecWithCode's own libraries are named with the `specwithcode:` scheme
 * (`<script src="specwithcode:three"></script>`) and are always inlined, so a
 * stored page runs offline, in installed apps and as a downloaded file. An
 * unknown name, or a library this build does not carry, is reported so the
 * publish fails instead of storing a page that cannot load.
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** The libraries a page can name as `specwithcode:<name>`. */
export const SPECWITHCODE_ARTIFACT_LIBRARIES = ["three", "motion-deck"] as const;
export type SpecWithCodeArtifactLibrary = (typeof SPECWITHCODE_ARTIFACT_LIBRARIES)[number];
const SPECWITHCODE_SCHEME_RE = /^specwithcode:([a-z0-9-]{1,40})$/i;
const THREE_NOTICE = "/*! three.js r180 | MIT License | Copyright 2010-2025 Three.js Authors */\n";

/** Turns three.js's CommonJS build into a classic script that defines `window.THREE`. */
export function wrapThreeCommonJs(source: string): string {
  return `${THREE_NOTICE}(function(){var module={exports:{}},exports=module.exports;\n${source}\n;window.THREE=module.exports;})();`;
}

const MERMAID_CDN_URL_RE =
  /^https?:\/\/(?:cdn\.jsdelivr\.net\/npm\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|unpkg\.com\/mermaid@(?:11(?:\.\d+){0,2}|latest)\/dist\/mermaid\.min\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid\/11(?:\.\d+){1,2}\/mermaid\.min\.js)(?:\?.*)?$/i;

const RAW_TEXT_CONTAINERS = new Set([
  "textarea",
  "noscript",
  "title",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);
const CLOSE_SCRIPT_RE = /<\/script(?=[\t\n\f\r />])/gi;

/** Parses HTML tag attributes without regex backtracking; lowercases attribute names. */
function parseHtmlAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /[\t\n\f\r /]/.test(raw[i]!)) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\t\n\f\r =/>]/.test(raw[i]!)) i += 1;
    const name = raw.slice(nameStart, i).toLowerCase();
    if (!name) {
      i += 1;
      continue;
    }
    while (i < len && /[\t\n\f\r ]/.test(raw[i]!)) i += 1;
    let value = "";
    if (i < len && raw[i] === "=") {
      i += 1;
      while (i < len && /[\t\n\f\r ]/.test(raw[i]!)) i += 1;
      if (i < len && (raw[i] === '"' || raw[i] === "'")) {
        const quote = raw[i]!;
        i += 1;
        const valStart = i;
        while (i < len && raw[i] !== quote) i += 1;
        value = raw.slice(valStart, i);
        if (i < len) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/[\t\n\f\r >]/.test(raw[i]!)) i += 1;
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
const moduleDir = () => NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const identity = (raw: string) => raw;

/** Reads the first readable candidate once per process, `</script` escaped for inlining. */
function loadCached(
  candidates: ReadonlyArray<string>,
  transform: (raw: string) => string = identity,
) {
  for (const candidate of candidates) {
    const key = `${candidate}\0${transform === identity ? "" : "t"}`;
    const cached = cachedBundles.get(key);
    if (cached !== undefined) {
      if (cached !== null) return cached;
      continue;
    }
    let loaded: string | null = null;
    try {
      if (NodeFS.existsSync(candidate)) {
        loaded = transform(NodeFS.readFileSync(candidate, "utf8")).replace(
          /<\/script/gi,
          "<\\/script",
        );
      }
    } catch {
      // Treat an unreadable candidate as absent.
    }
    cachedBundles.set(key, loaded);
    if (loaded !== null) return loaded;
  }
  return null;
}

/** three.js's CommonJS build in a dev checkout, where no built copy exists yet. */
function threeCommonJsPath(): string | null {
  try {
    const clientRuntime = NodePath.resolve(
      moduleDir(),
      "../../../../packages/client-runtime/package.json",
    );
    return NodeModule.createRequire(clientRuntime).resolve("three");
  } catch {
    return null;
  }
}

/**
 * The motion deck is one library made of source parts, joined in this order: the core defines
 * `window.SpecWithCodeDeck`, and the later parts add sound, transitions, worlds and the font.
 */
export const MOTION_DECK_PARTS = [
  "motion-deck.js",
  "motion-deck-audio.js",
  "motion-deck-fx.js",
  "motion-deck-world.js",
] as const;
export const MOTION_DECK_FONT = "fonts/archivo-latin-wdth.woff2";
export const MOTION_DECK_FONT_LICENSE = "fonts/OFL.txt";

/**
 * Joins the motion deck's parts from `dir` (the source `artifact-libs` folder) into one script.
 * The font becomes a part that hands the deck a data URI, with the font's licence kept beside it.
 */
export function joinMotionDeck(dir: string): string {
  const parts = MOTION_DECK_PARTS.map((part) =>
    NodeFS.readFileSync(NodePath.join(dir, part), "utf8"),
  );
  const font = NodeFS.readFileSync(NodePath.join(dir, MOTION_DECK_FONT)).toString("base64");
  const license = NodeFS.readFileSync(NodePath.join(dir, MOTION_DECK_FONT_LICENSE), "utf8")
    .replace(/\*\//g, "* /")
    .trim();
  const fontPart =
    "/*! Archivo (SpecWithCode Display) | SIL Open Font License 1.1 | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)\n" +
    `${license}\n*/\n` +
    `(function(){var D=window.SpecWithCodeDeck;if(D&&D.useFont)D.useFont("data:font/woff2;base64,${font}");})();\n`;
  return `${parts.join("\n")}\n${fontPart}`;
}

/** The inline source of a SpecWithCode library: the build's copy first, then the dev checkout. */
export function loadSpecWithCodeLibrary(
  name: SpecWithCodeArtifactLibrary,
  staticDir: string | undefined,
): string | null {
  const built = staticDir ? [NodePath.join(staticDir, "artifact-libs", `${name}.js`)] : [];
  if (name === "three") {
    const fromBuild = loadCached(built);
    if (fromBuild !== null) return fromBuild;
    const dev = threeCommonJsPath();
    return dev === null ? null : loadCached([dev], wrapThreeCommonJs);
  }
  const fromBuild = loadCached(built);
  if (fromBuild !== null) return fromBuild;
  const sourceDir = NodePath.join(moduleDir(), "artifact-libs");
  return loadCached([NodePath.join(sourceDir, MOTION_DECK_PARTS[0])], () =>
    joinMotionDeck(sourceDir),
  );
}

function resolveDefaultMermaidPaths(staticDir?: string): ReadonlyArray<string> {
  const candidates: string[] = [];
  if (staticDir) {
    candidates.push(NodePath.join(staticDir, "artifact-libs", "mermaid.min.js"));
  }
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
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
      if (NodeFS.existsSync(candidate)) {
        const raw = NodeFS.readFileSync(candidate, "utf8");
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
  /** Optional override for tests. */
  readonly resolveLibrarySource?:
    | ((name: SpecWithCodeArtifactLibrary) => string | null)
    | undefined;
}

export interface ArtifactLibrariesResult {
  readonly html: string;
  /** `specwithcode:` names that are not SpecWithCode libraries. */
  readonly unknown: ReadonlyArray<string>;
  /** SpecWithCode libraries this build could not read. */
  readonly unavailable: ReadonlyArray<SpecWithCodeArtifactLibrary>;
  /** The inlined page would pass `maxPageBytes`; `html` is the page as given. */
  readonly tooLarge: boolean;
  readonly inlinedBytes: number;
}

const COMMENT_END_RE = /--!?>/g;

/**
 * Rewrites allowlisted `mermaid@11` CDN `<script>` tags to local inline scripts
 * when a local bundle is available and fits within `maxPageBytes`.
 */
export function rewriteLocalArtifactLibraries(
  html: string,
  options: LocalArtifactLibOptions,
): string {
  const result = inlineArtifactLibraries(html, options);
  return result.tooLarge ? html : result.html;
}

/**
 * Inlines mermaid CDN tags (when a local bundle exists) and every
 * `specwithcode:` library, and reports names it could not inline.
 */
export function inlineArtifactLibraries(
  html: string,
  options: LocalArtifactLibOptions,
): ArtifactLibrariesResult {
  const unchanged = { html, unknown: [], unavailable: [], tooLarge: false, inlinedBytes: 0 };
  // Fast exit before touching disk if no library name appears anywhere in the document.
  if (!/mermaid|specwithcode:/i.test(html)) return unchanged;

  let safeSource: string | null = null;
  let sourceLoaded = false;
  let rewrittenCount = 0;
  let mermaidCount = 0;
  const unknown = new Set<string>();
  const unavailable = new Set<SpecWithCodeArtifactLibrary>();
  const inlined = new Set<SpecWithCodeArtifactLibrary>();
  let inlinedBytes = 0;

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
    // HTML5 comment state recognizes abrupt <!--> / <!---> as well as --> and --!> in a single forward pass.
    if (html.startsWith("<!--", lt)) {
      let next: number;
      if (html.startsWith("<!-->", lt)) {
        next = lt + 5;
      } else if (html.startsWith("<!--->", lt)) {
        next = lt + 6;
      } else {
        COMMENT_END_RE.lastIndex = lt + 4;
        const endMatch = COMMENT_END_RE.exec(html);
        next = endMatch ? endMatch.index + endMatch[0].length : len;
      }
      out.push(html.slice(lt, next));
      cursor = next;
      continue;
    }

    // Closing </template> tag decrements template nesting depth.
    const closeTemplateMatch = /^<\/template(?=[\t\n\f\r />])/i.exec(html.slice(lt, lt + 16));
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

    // Scan the full opening tag name per HTML5 tag-name state: starts with ASCII alpha
    // and continues until ASCII whitespace, '/', or '>' (handles long and Unicode custom elements).
    const firstCode = lt + 1 < len ? html.charCodeAt(lt + 1) : 0;
    const isAsciiAlpha =
      (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
    if (!isAsciiAlpha) {
      out.push("<");
      cursor = lt + 1;
      continue;
    }
    let nameEnd = lt + 2;
    while (nameEnd < len) {
      const ch = html.charCodeAt(nameEnd);
      if (
        ch === 9 || // \t
        ch === 10 || // \n
        ch === 12 || // \f
        ch === 13 || // \r
        ch === 32 || // space
        ch === 47 || // /
        ch === 62 // >
      ) {
        break;
      }
      nameEnd += 1;
    }
    if (nameEnd >= len) {
      out.push(html.slice(lt));
      break;
    }
    const tagName = html.slice(lt + 1, nameEnd).toLowerCase();
    const openEnd = findTagClose(html, nameEnd);
    if (openEnd === -1) {
      out.push(html.slice(lt));
      break;
    }

    if (tagName === "plaintext") {
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
      const closeRe = new RegExp(`<\\/${tagName}(?=[\\t\\n\\f\\r />])`, "gi");
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
    const attrSlice = html.slice(nameEnd, openEnd);
    const attrs = parseHtmlAttributes(attrSlice);
    const src = attrs.get("src")?.trim();

    const named = src === undefined ? null : SPECWITHCODE_SCHEME_RE.exec(src);
    // A script with a src runs the src and ignores its text, so text never excuses an
    // unknown library.
    if (src !== undefined && /^specwithcode:/i.test(src)) {
      const name = named?.[1]?.toLowerCase();
      const library = SPECWITHCODE_ARTIFACT_LIBRARIES.find((known) => known === name);
      if (library === undefined) {
        unknown.add(src.slice("specwithcode:".length));
      } else if (inlined.has(library)) {
        rewrittenCount += 1;
        out.push(`<!-- specwithcode:${library} already inlined -->`);
        cursor = closeScriptEnd + 1;
        continue;
      } else {
        const source = options.resolveLibrarySource
          ? options.resolveLibrarySource(library)
          : loadSpecWithCodeLibrary(library, options.staticDir);
        if (source === null) {
          unavailable.add(library);
        } else {
          const safe = source.replace(/<\/script/gi, "<\\/script");
          inlined.add(library);
          rewrittenCount += 1;
          inlinedBytes += Buffer.byteLength(safe);
          out.push(`<script data-local-artifact-lib="${library}">${safe}</script>`);
          cursor = closeScriptEnd + 1;
          continue;
        }
      }
    }

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
        // Mermaid keeps its own count: a SpecWithCode library before it must not stand in for it.
        mermaidCount += 1;
        if (mermaidCount > 1) {
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

  const report = {
    unknown: [...unknown],
    unavailable: [...unavailable],
  };
  if (rewrittenCount === 0) return { ...unchanged, ...report };
  const candidate = out.join("");
  if (Buffer.byteLength(candidate) > options.maxPageBytes) {
    return { ...unchanged, ...report, tooLarge: true, inlinedBytes: Buffer.byteLength(candidate) };
  }
  return { html: candidate, ...report, tooLarge: false, inlinedBytes };
}
