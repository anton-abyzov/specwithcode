/**
 * Structured blocks agents can write in a fence: `json` data shown as a grid or a table,
 * `status` checklists and `kv` facts. Every parser returns null for text it does not
 * fully understand, so the fence falls back to ordinary highlighted code.
 */

export type JsonData = Record<string, unknown> | ReadonlyArray<unknown>;

/** Beyond this the grid costs more than it helps; the code view stays. */
const MAX_JSON_CHARS = 200_000;

export const STRUCTURED_FENCE_LANGUAGES = new Set(["json", "jsonc", "json5", "status", "kv"]);

export function parseJsonData(text: string): JsonData | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_JSON_CHARS) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  // Integers past 2^53 would come back rounded; the code view keeps their digits.
  if (/(?<![\d.eE])-?\d{16,}(?![\d.eE])/.test(trimmed)) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) return value.length > 0 ? value : null;
    if (isPlainObject(value)) return Object.keys(value).length > 0 ? value : null;
    return null;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

/**
 * Columns for an array shown as a table: every element is an object whose values are
 * scalars (or short scalar lists). Null when the array is better shown another way.
 */
export function tableColumns(rows: ReadonlyArray<unknown>): ReadonlyArray<string> | null {
  if (rows.length === 0 || !rows.every(isPlainObject)) return null;
  const columns: string[] = [];
  for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
    for (const [key, value] of Object.entries(row)) {
      if (!isScalar(value) && !(Array.isArray(value) && value.every(isScalar))) return null;
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns.length > 0 && columns.length <= 12 ? columns : null;
}

/** `oldest_due_age_seconds` and `lastClaimAt` read as words. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (words.length === 0) return key;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function isoDateTime(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 1534 → "25m 34s"; for numbers whose key says they are seconds. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return String(seconds);
  const total = Math.round(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = total % 60;
  const parts =
    days > 0
      ? [`${days}d`, hours > 0 ? `${hours}h` : null]
      : hours > 0
        ? [`${hours}h`, minutes > 0 ? `${minutes}m` : null]
        : minutes > 0
          ? [`${minutes}m`, rest > 0 ? `${rest}s` : null]
          : [`${rest}s`];
  return parts.filter(Boolean).join(" ");
}

export function isSecondsKey(key: string): boolean {
  return /(?:^|[_\s-])(?:seconds|secs?)$|Seconds$|Secs?$/.test(key);
}

export type StatusState = "ok" | "warn" | "fail" | "info" | "running" | "skip";

export interface StatusItem {
  readonly state: StatusState;
  readonly label: string;
  readonly detail: string | null;
}

export interface StatusBlock {
  readonly title: string | null;
  readonly items: ReadonlyArray<StatusItem>;
}

const STATUS_ALIASES: Record<string, StatusState> = {
  ok: "ok",
  pass: "ok",
  passed: "ok",
  done: "ok",
  success: "ok",
  warn: "warn",
  warning: "warn",
  fail: "fail",
  failed: "fail",
  error: "fail",
  blocked: "fail",
  info: "info",
  note: "info",
  running: "running",
  pending: "running",
  wait: "running",
  waiting: "running",
  skip: "skip",
  skipped: "skip",
};

const STATUS_LINE = /^(?:[-*]\s+)?([a-z]+)\s*:\s*(.+)$/i;

/** Splits `label | detail` or `label — detail`. */
function labelAndDetail(text: string): { label: string; detail: string | null } {
  const match = /^(.+?)\s+(?:\||—|–)\s+(.+)$/.exec(text);
  return match
    ? { label: match[1]!.trim(), detail: match[2]!.trim() }
    : { label: text.trim(), detail: null };
}

/**
 * ```status
 * title: Nightly checks
 * ok: Build | 2m 10s
 * warn: Disk at 82%
 * fail: Deploy — waiting on a review
 * ```
 */
export function parseStatusBlock(text: string): StatusBlock | null {
  let title: string | null = null;
  const items: StatusItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = STATUS_LINE.exec(line);
    if (!match) return null;
    const keyword = match[1]!.toLowerCase();
    const rest = match[2]!.trim();
    if (keyword === "title" && title === null && items.length === 0) {
      title = rest;
      continue;
    }
    const state = STATUS_ALIASES[keyword];
    if (state === undefined) return null;
    items.push({ state, ...labelAndDetail(rest) });
  }
  return items.length > 0 ? { title, items } : null;
}

export interface KeyValueGroup {
  readonly heading: string | null;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

/**
 * ```kv
 * # Queue
 * Pending: 1
 * Escalated: 2
 * # Worker
 * Last claim: 08:22
 * ```
 * A `# Heading` line starts a group. Keys run up to the first `: `.
 */
export function parseKeyValueBlock(text: string): ReadonlyArray<KeyValueGroup> | null {
  const groups: Array<{ heading: string | null; entries: Array<{ key: string; value: string }> }> =
    [];
  let current: (typeof groups)[number] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      current = { heading: heading[1]!.trim(), entries: [] };
      groups.push(current);
      continue;
    }
    const entry = /^(?:[-*]\s+)?([^:]{1,80}?)\s*:\s+(.*)$|^(?:[-*]\s+)?([^:]{1,80}?)\s*:$/.exec(
      line,
    );
    if (!entry) return null;
    if (current === null) {
      current = { heading: null, entries: [] };
      groups.push(current);
    }
    current.entries.push({ key: (entry[1] ?? entry[3])!.trim(), value: (entry[2] ?? "").trim() });
  }
  const filled = groups.filter((group) => group.entries.length > 0);
  return filled.length > 0 ? filled : null;
}
