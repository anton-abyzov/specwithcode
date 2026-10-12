/**
 * `[title](studio://thread/<id>)` is how a coordinator names the threads it works
 * with in chat. The ID segment is `encodeURIComponent(threadId)`, so decoding it
 * once gives the stored ID back exactly. Thread IDs may themselves contain `%`
 * (a delegated task's ID carries `command%3A…`), which is why the server hands
 * agents a ready-made link instead of letting them build one.
 *
 * A thread on another machine also names that machine's environment:
 * `studio://thread/<environment id>/<thread id>`, each segment encoded the same way.
 */

export const STUDIO_THREAD_HREF_PREFIX = "studio://thread/";

/** Longest ID segment worth looking up; stored IDs are far shorter. */
const MAX_SEGMENT_LENGTH = 1024;

/**
 * `encodeURIComponent` leaves `( ) ! * '` alone, and a `)` would end the Markdown
 * link early (a delegated task's ID carries the request ID the model chose), so
 * those are escaped too. Decoding once still gives the exact ID back.
 */
const encodeSegment = (value: string) =>
  encodeURIComponent(value).replace(
    /[()!*']/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function formatStudioThreadHref(threadId: string, environmentId?: string): string {
  return environmentId === undefined
    ? `${STUDIO_THREAD_HREF_PREFIX}${encodeSegment(threadId)}`
    : `${STUDIO_THREAD_HREF_PREFIX}${encodeSegment(environmentId)}/${encodeSegment(threadId)}`;
}

/** A Markdown label survives only without brackets or line breaks. */
export function studioThreadLinkLabel(title: string, fallback = "thread"): string {
  const label = title
    .replace(/[[\]\\\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return label.length > 0 ? label : fallback;
}

/** The canonical Markdown link to a thread, built where the ID is known exactly. */
export function formatStudioThreadLink(
  threadId: string,
  title: string,
  environmentId?: string,
): string {
  return `[${studioThreadLinkLabel(title)}](${formatStudioThreadHref(threadId, environmentId)})`;
}

function unsafe(value: string): boolean {
  return (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return char === "/" || char === "\\" || code < 32 || code === 127;
    })
  );
}

/**
 * The thread IDs a `studio://thread/` link may name, most likely first: the
 * segment decoded once (the canonical form), then the segment as written (an
 * agent that pasted a raw ID containing `%3A`). Null when the href is not a
 * single, safe thread segment.
 */
export function parseStudioThreadHref(href: string): readonly string[] | null {
  if (!href.startsWith(STUDIO_THREAD_HREF_PREFIX)) return null;
  return threadCandidates(href.slice(STUDIO_THREAD_HREF_PREFIX.length));
}

function threadCandidates(segment: string): readonly string[] | null {
  // Parse exactly one path segment before URL normalization can erase traversal.
  if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return null;
  // Spaces are allowed: an agent may write a thread's title where its ID belongs.
  if (/[/?#\\]/.test(segment)) return null;
  const candidates: string[] = [];
  try {
    const decoded = decodeURIComponent(segment).trim();
    if (!unsafe(decoded)) candidates.push(decoded);
  } catch {
    /* A malformed escape can still be a raw ID. */
  }
  const raw = segment.trim();
  if (!unsafe(raw) && !candidates.includes(raw)) candidates.push(raw);
  return candidates.length > 0 ? candidates : null;
}

export interface StudioThreadTarget {
  /** The machine's environment for a link to a thread on another machine; null for this one. */
  readonly environmentId: string | null;
  /** Thread IDs the link may name, most likely first (see parseStudioThreadHref). */
  readonly candidates: readonly string[];
}

/**
 * Either form of a thread link: one segment for a thread on the machine that
 * wrote it, or `<environment id>/<thread id>` for a thread on another machine.
 * Null when the href is neither.
 */
export function parseStudioThreadTarget(href: string): StudioThreadTarget | null {
  if (!href.startsWith(STUDIO_THREAD_HREF_PREFIX)) return null;
  const rest = href.slice(STUDIO_THREAD_HREF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    const candidates = threadCandidates(rest);
    return candidates === null ? null : { environmentId: null, candidates };
  }
  const environmentSegment = rest.slice(0, slash);
  if (environmentSegment.length === 0 || environmentSegment.length > MAX_SEGMENT_LENGTH)
    return null;
  let environmentId: string;
  try {
    environmentId = decodeURIComponent(environmentSegment).trim();
  } catch {
    return null;
  }
  if (unsafe(environmentId) || /\s/.test(environmentId)) return null;
  const candidates = threadCandidates(rest.slice(slash + 1));
  return candidates === null ? null : { environmentId, candidates };
}
