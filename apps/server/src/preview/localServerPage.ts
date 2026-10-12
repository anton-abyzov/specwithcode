/**
 * What a local server's HTML says about itself.
 *
 * The port scanner already fetches each listening port once to decide whether
 * it serves a web page. This module reads a bounded prefix of that same
 * response and pulls out a human name for it (the `<title>`) and whether the
 * page is a SpecWithCode app, so the "Local servers" list can show
 * "My Dashboard" instead of the raw process name `node`.
 *
 * @module localServerPage
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** The `<title>` sits in the head; SpecWithCode's own head is about 20 KB. */
export const PAGE_HEAD_MAX_BYTES = 64 * 1024;
export const PAGE_TITLE_MAX_LENGTH = 120;

export interface LocalServerPageInfo {
  readonly title: string | null;
  readonly specWithCode: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  vert: "|",
};

const codePointToString = (codePoint: number): string | null =>
  Number.isInteger(codePoint) &&
  codePoint > 0 &&
  codePoint <= 0x10ffff &&
  !(codePoint >= 0xd800 && codePoint <= 0xdfff)
    ? String.fromCodePoint(codePoint)
    : null;

/** Decodes the character references a page title realistically contains. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (match, body) => {
    const reference = String(body);
    if (reference.startsWith("#x") || reference.startsWith("#X")) {
      return codePointToString(Number.parseInt(reference.slice(2), 16)) ?? match;
    }
    if (reference.startsWith("#")) {
      return codePointToString(Number.parseInt(reference.slice(1), 10)) ?? match;
    }
    return NAMED_ENTITIES[reference.toLowerCase()] ?? match;
  });
}

/** Collapses whitespace, drops control characters and caps the length. */
export function normalizePageTitle(raw: string): string | null {
  const collapsed = decodeHtmlEntities(raw)
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= PAGE_TITLE_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PAGE_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * The document's `<title>`, looked for in the head only: an inline SVG's
 * `<title>` in the body names an icon, not the page.
 */
export function extractHtmlTitle(html: string): string | null {
  const headEnd = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  return match?.[1] === undefined ? null : normalizePageTitle(match[1]);
}

const APPLICATION_NAME_META =
  /<meta\b(?=[^>]*\bname\s*=\s*["']?application-name["']?)(?=[^>]*\bcontent\s*=\s*["']?SpecWithCode["']?)[^>]*>/i;

/**
 * Whether the page is a SpecWithCode app. Current builds declare it with an
 * `application-name` meta tag; older builds are recognised by their title
 * together with the theme storage key the boot script reads.
 */
export function isSpecWithCodeDocument(html: string, title: string | null): boolean {
  if (APPLICATION_NAME_META.test(html)) return true;
  return title === "SpecWithCode" && html.includes("studio:themes:v1");
}

export function describeLocalServerPage(html: string): LocalServerPageInfo {
  const title = extractHtmlTitle(html);
  return { title, specWithCode: isSpecWithCodeDocument(html, title) };
}

/**
 * Reads at most `maxBytes` of a body and decodes it as UTF-8. The stream is
 * abandoned once the limit is reached, so a huge or endless page costs no more
 * than its first chunks.
 */
export const readBoundedText = <E, R>(
  body: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number = PAGE_HEAD_MAX_BYTES,
): Effect.Effect<string, E, R> =>
  Effect.suspend(() => {
    let received = 0;
    return body.pipe(
      Stream.takeUntil((chunk) => {
        received += chunk.byteLength;
        return received >= maxBytes;
      }),
      Stream.runCollect,
      Effect.map((chunks) => {
        const buffer = new Uint8Array(Math.min(received, maxBytes));
        let offset = 0;
        for (const chunk of chunks) {
          if (offset >= buffer.length) break;
          const slice = chunk.subarray(0, buffer.length - offset);
          buffer.set(slice, offset);
          offset += slice.length;
        }
        return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      }),
    );
  });
