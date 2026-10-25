import * as DateTime from "effect/DateTime";

/**
 * Pages Claude Code published with its native Artifact tool, read back from
 * the tool calls the thread already keeps. They are references only: the page
 * lives on claude.ai, private to the account that published it, and opens in
 * the system browser. Nothing here publishes, reads or embeds one.
 */

export const ARTIFACT_TOOL_NAME = "Artifact";
const ARTIFACT_DRIVER = "claudeAgent";
const ARTIFACT_HOST = "claude.ai";

/** How the Files list explains where a native artifact's link opens. */
export const NATIVE_REMOTE_NOTE =
  "Private claude.ai link. Opens only for the account that published it.";
/** Said instead when the result named a page that is not a claude.ai artifact. */
export const NATIVE_NO_LINK_NOTE =
  "No link to open: the result did not name a claude.ai artifact page.";

const MAX_URL_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const MAX_VERSION_LENGTH = 128;
const MAX_ID_LENGTH = 128;
const MAX_AUDIENCE_LENGTH = 32;

/** Outputs of the tool's other actions: list, read, watches and asset calls. */
const NON_PUBLISH_OUTPUT_KEYS = [
  "read",
  "artifactRead",
  "artifacts",
  "watch",
  "unwatch",
  "watches",
  "asset_upload",
  "asset_uploads",
  "asset_list",
  "asset_read",
  "asset_delete",
] as const;

export interface NativeArtifactReference {
  /** One per published page, the same across its versions. */
  readonly key: string;
  /** The provider driver that ran the tool. */
  readonly provider: string;
  readonly title: string;
  /** The service's version id. */
  readonly version: string | null;
  /** "Version N", counted by the service from 1. */
  readonly seq: number | null;
  /** The source file on the machine that published it. */
  readonly localPath: string;
  /**
   * The page's https://claude.ai link, normalized; null when the result named
   * an https page elsewhere, which is never offered.
   */
  readonly url: string | null;
  readonly artifactId: string | null;
  /** Who can open it ("owner"), or null when the result did not say. */
  readonly audience: string | null;
  /** The publish tool call. */
  readonly itemId: string;
  readonly publishedAt: number | null;
  /**
   * Read from the structured result, from the result's text (its JSON, as a
   * replayed history keeps it, or its one-line answer), or from the list
   * snapshot a continued thread left.
   */
  readonly source: "structured" | "text" | "snapshot";
}

/** The parts of a turn item this module reads; any timeline item fits. */
export interface NativeArtifactToolItem {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null | undefined;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly outputOmitted?: boolean | undefined;
  readonly toolNonExecutionKind?: string | undefined;
  readonly nativeItemRef?: { readonly driver: string } | null | undefined;
  readonly completedAt?: unknown;
  readonly updatedAt?: unknown;
}

interface PublishResult {
  readonly url: string | null;
  readonly path: string;
  readonly artifactId: string | null;
  readonly title: string | null;
  readonly version: string | null;
  readonly seq: number | null;
  readonly audience: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** A version id as a string; some results give a number. */
function versionId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return boundedString(value, MAX_VERSION_LENGTH);
}

function httpsUrl(url: string): URL | null {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** The two forms a published page's link takes: a slug, or a UUID under /code. */
const ARTIFACT_PATHS = [
  /^\/artifact\/[A-Za-z0-9_-]{1,128}$/,
  /^\/code\/artifact\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

/**
 * A published page's link as the browser should get it
 * (`https://claude.ai/artifact/<slug>` or `https://claude.ai/code/artifact/<uuid>`,
 * without query or fragment), or null for anything else.
 */
export function isClaudeArtifactUrl(url: string): string | null {
  const parsed = httpsUrl(url);
  if (parsed === null || parsed.hostname !== ARTIFACT_HOST) return null;
  if (parsed.username || parsed.password || parsed.port) return null;
  const path = parsed.pathname.replace(/\/$/, "");
  return ARTIFACT_PATHS.some((pattern) => pattern.test(path))
    ? `https://${ARTIFACT_HOST}${path}`
    : null;
}

/**
 * What a result's link leaves: the claude.ai link, `null` for an https page
 * elsewhere (the entry stays, without a link), or `undefined` for anything
 * that is not https, which drops the entry.
 */
function publishedLink(url: unknown): string | null | undefined {
  if (typeof url !== "string") return undefined;
  const link = isClaudeArtifactUrl(url);
  if (link !== null) return link;
  return httpsUrl(url) === null ? undefined : null;
}

/** An absolute local path on one line; network shares are refused, as file links refuse them. */
function localSourcePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH || /[\r\n]/.test(value)) return null;
  if (value.startsWith("\\\\") || value.startsWith("//")) return null;
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) ? value : null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** A structured publish result, or null for an error, another action's result or a malformed one. */
export function parseArtifactPublishOutput(output: unknown): PublishResult | null {
  if (!isRecord(output)) return null;
  if (output.isError === true || output.is_error === true) return null;
  if (output.error !== undefined && output.error !== null && output.error !== false) return null;
  if (NON_PUBLISH_OUTPUT_KEYS.some((key) => key in output)) return null;
  const url = publishedLink(output.url);
  const path = localSourcePath(output.path);
  if (url === undefined || path === null) return null;
  return {
    url,
    path,
    artifactId: boundedString(output.artifact_id, MAX_ID_LENGTH),
    title: boundedString(output.title, MAX_TITLE_LENGTH),
    version: versionId(output.version),
    seq: positiveInt(output.seq),
    audience: boundedString(output.audience, MAX_AUDIENCE_LENGTH),
  };
}

const PUBLISHED_TEXT_PATTERN =
  /^Published (.+?) at (https:\/\/\S+?) \(Version (\d+), version id ([^)\s]+)\)/;

/** The tool's own text answer (`Published <path> at <url> (Version N, version id X)`). */
export function parseArtifactPublishText(
  text: string,
): Pick<PublishResult, "url" | "path" | "version" | "seq"> | null {
  const match = PUBLISHED_TEXT_PATTERN.exec(text.trimStart());
  if (!match) return null;
  const url = publishedLink(match[2]);
  const path = localSourcePath(match[1]);
  if (url === undefined || path === null) return null;
  return {
    url,
    path,
    seq: positiveInt(Number(match[3])),
    version: boundedString(match[4], MAX_VERSION_LENGTH),
  };
}

function outputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (!Array.isArray(output) || output.length === 0) return null;
  const parts: string[] = [];
  for (const block of output) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * The result as the tool gave it. A live turn keeps the structured side
 * field; a replayed history keeps only the text, which is the same object as
 * JSON, or the tool's one-line answer.
 */
function publishResultOf(
  output: unknown,
): { result: PublishResult; from: "structured" | "text" } | null {
  if (isRecord(output) && output.type === "structured_tool_use_result" && "value" in output) {
    return publishResultOf(output.value) ?? publishResultOf(output.fallbackValue);
  }
  if (isRecord(output)) {
    const result = parseArtifactPublishOutput(output);
    return result === null ? null : { result, from: "structured" };
  }
  const text = outputText(output);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    const result = parseArtifactPublishOutput(parsed);
    return result === null ? null : { result, from: "text" };
  }
  const line = parseArtifactPublishText(trimmed);
  return line === null
    ? null
    : { result: { ...line, artifactId: null, title: null, audience: null }, from: "text" };
}

/** Only a publish: no action, or "publish". Read, list, watch and asset calls are not pages. */
function isPublishInput(input: unknown): boolean {
  if (!isRecord(input)) return input === undefined || input === null;
  return input.action === undefined || input.action === "publish";
}

function isFinishedClaudeArtifactCall(item: NativeArtifactToolItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    item.toolName === ARTIFACT_TOOL_NAME &&
    item.nativeItemRef?.driver === ARTIFACT_DRIVER &&
    item.status === "completed" &&
    item.toolNonExecutionKind === undefined
  );
}

/**
 * A finished Artifact publish whose result may name a page: worth reading in
 * full when the timeline withheld its output. A summarized input (`{summary,
 * truncated}`) counts too; the full read tells which action it was.
 */
export function isNativeArtifactCandidate(item: NativeArtifactToolItem): boolean {
  return isFinishedClaudeArtifactCall(item) && isPublishInput(item.input);
}

/** The timeline kept only a summary of the result, and the summary is not a failure. */
function needsDetailRead(item: NativeArtifactToolItem): boolean {
  return item.outputOmitted === true && !(isRecord(item.output) && item.output.isError === true);
}

function epochMillis(value: unknown): number | null {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? null : at;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The page one finished publish call names, or null for anything else. */
export function nativeArtifactFromItem(
  item: NativeArtifactToolItem,
): NativeArtifactReference | null {
  if (!isFinishedClaudeArtifactCall(item) || !isPublishInput(item.input)) return null;
  const input = isRecord(item.input) ? item.input : {};
  const parsed = publishResultOf(item.output);
  if (parsed === null) return null;
  const { result } = parsed;
  const title =
    result.title ?? boundedString(input.title, MAX_TITLE_LENGTH) ?? basename(result.path);
  return {
    key: `${item.nativeItemRef!.driver}:${result.url ?? `path:${result.path}`}`,
    provider: item.nativeItemRef!.driver,
    title: title.slice(0, MAX_TITLE_LENGTH),
    version: result.version,
    seq: result.seq,
    localPath: result.path,
    url: result.url,
    artifactId: result.artifactId,
    audience: result.audience,
    itemId: item.id,
    publishedAt: epochMillis(item.completedAt) ?? epochMillis(item.updatedAt),
    source: parsed.from,
  };
}

/** "Version 2", from the service's count, else its version id. */
export function nativeVersionLabel(
  reference: Pick<NativeArtifactReference, "seq" | "version">,
): string | null {
  if (reference.seq !== null) return `Version ${reference.seq}`;
  return reference.version === null ? null : `Version ${reference.version}`;
}

/**
 * One reference per page, newest first: of its publishes the highest version
 * wins, then the latest. `order` is each reference's place in the thread.
 */
function collapse(
  found: ReadonlyArray<readonly [order: number, reference: NativeArtifactReference]>,
): NativeArtifactReference[] {
  const byKey = new Map<string, { order: number; latest: number; ref: NativeArtifactReference }>();
  for (const [order, ref] of found) {
    const current = byKey.get(ref.key);
    if (!current) {
      byKey.set(ref.key, { order, latest: order, ref });
      continue;
    }
    const newer =
      (ref.seq ?? 0) > (current.ref.seq ?? 0) ||
      ((ref.seq ?? 0) === (current.ref.seq ?? 0) && order > current.order);
    byKey.set(ref.key, {
      order: newer ? order : current.order,
      latest: Math.max(order, current.latest),
      ref: newer ? ref : current.ref,
    });
  }
  return [...byKey.values()]
    .toSorted((left, right) => right.latest - left.latest)
    .map((entry) => entry.ref);
}

/** The pages a thread's timeline items name, as far as their own outputs tell. */
export function nativeArtifactReferences(
  items: ReadonlyArray<NativeArtifactToolItem>,
): NativeArtifactReference[] {
  return collapse(
    items.flatMap((item, order) => {
      const ref = nativeArtifactFromItem(item);
      return ref ? [[order, ref] as const] : [];
    }),
  );
}

/** Reads one item in full; rejects when the host could not answer. */
export type NativeArtifactDetailRead<T extends NativeArtifactToolItem = NativeArtifactToolItem> = (
  item: T,
) => Promise<NativeArtifactToolItem | null>;

const DETAIL_CONCURRENCY = 4;

/** Calls that publish the same file or link update one page, so one read tells it. */
function publishGroup(item: NativeArtifactToolItem): string {
  const input = isRecord(item.input) ? item.input : {};
  if (typeof input.url === "string") return `url:${input.url}`;
  if (typeof input.file_path === "string") return `file:${input.file_path}`;
  return `item:${item.id}`;
}

/**
 * The pages a thread's Artifact calls name, reading a withheld output in full
 * only where the timeline lacks it: the newest call of each page first, an
 * older one only when the newer does not parse, a few reads at a time. A read
 * that fails leaves the page out until the next attempt.
 */
export async function resolveNativeArtifacts<T extends NativeArtifactToolItem>(
  items: ReadonlyArray<T>,
  readDetail: NativeArtifactDetailRead<T>,
  concurrency = DETAIL_CONCURRENCY,
): Promise<NativeArtifactReference[]> {
  const groups = new Map<string, Array<readonly [number, T]>>();
  items.forEach((item, order) => {
    if (!isNativeArtifactCandidate(item)) return;
    const group = publishGroup(item);
    groups.set(group, [[order, item] as const, ...(groups.get(group) ?? [])]);
  });
  const found: Array<readonly [number, NativeArtifactReference]> = [];
  const settle = async (calls: ReadonlyArray<readonly [number, T]>) => {
    for (const [order, item] of calls) {
      let ref = nativeArtifactFromItem(item);
      if (ref === null && needsDetailRead(item)) {
        const detail = await readDetail(item).catch(() => undefined);
        // The host did not answer: an older call would not fare better now.
        if (detail === undefined) return;
        ref = detail === null ? null : nativeArtifactFromItem(detail);
      }
      if (ref !== null) {
        found.push([order, ref]);
        return;
      }
    }
  };
  const queue = [...groups.values()];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let calls = queue.shift(); calls; calls = queue.shift()) await settle(calls);
    }),
  );
  return collapse(found);
}

/**
 * A detail read that asks the host once per finished item revision: a
 * remount, another provider's turn or a reopened list answers from memory.
 * A failed read is forgotten, so the next attempt asks again.
 */
export function cachedDetailRead<T extends NativeArtifactToolItem>(
  read: NativeArtifactDetailRead<T>,
  keyOf: (item: T) => string,
  limit = 500,
): NativeArtifactDetailRead<T> {
  const reads = new Map<string, Promise<NativeArtifactToolItem | null>>();
  return (item) => {
    const key = keyOf(item);
    const cached = reads.get(key);
    if (cached) return cached;
    const next = read(item);
    reads.set(key, next);
    next.catch(() => {
      if (reads.get(key) === next) reads.delete(key);
    });
    // The oldest answers go first past the limit.
    while (reads.size > limit) reads.delete(reads.keys().next().value!);
    return next;
  };
}
