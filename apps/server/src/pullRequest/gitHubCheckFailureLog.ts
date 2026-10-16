/**
 * Pure helpers for reading the failing output of a GitHub Actions check: where a check URL points,
 * and how to cut what `gh run view --log-failed` prints down to something an agent can be handed.
 */

/** Lines kept from the end of a failing log. */
export const CHECK_FAILURE_LOG_MAX_LINES = 400;
/** UTF-8 bytes kept from the end of a failing log, after the line cap. */
export const CHECK_FAILURE_LOG_MAX_BYTES = 24 * 1024;

export interface GitHubActionsJobRef {
  /** Absent for a check-run URL, which names only the job; `gh` finds the run itself. */
  readonly runId: string | null;
  readonly jobId: string;
}

const DIGITS = /^\d{1,20}$/;

/**
 * The Actions run and job a check URL names, or null when it is not an Actions job of
 * `repository` on `host`. Accepts `/<owner>/<repo>/actions/runs/<run>/job/<job>` (and `jobs`)
 * and the check-run form `/<owner>/<repo>/runs/<job>`, whose id is the job's own.
 */
export function parseGitHubActionsJobUrl(
  url: string,
  expected: { readonly host: string; readonly repository: string },
): GitHubActionsJobRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname.toLowerCase() !== expected.host.trim().toLowerCase()) return null;
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 4) return null;
  const [owner, name, ...rest] = segments;
  if (`${owner}/${name}`.toLowerCase() !== expected.repository.trim().toLowerCase()) return null;
  if (
    rest.length >= 5 &&
    rest[0] === "actions" &&
    rest[1] === "runs" &&
    (rest[3] === "job" || rest[3] === "jobs") &&
    DIGITS.test(rest[2] ?? "") &&
    DIGITS.test(rest[4] ?? "")
  ) {
    return { runId: rest[2] ?? null, jobId: rest[4] ?? "" };
  }
  if (rest.length >= 2 && rest[0] === "runs" && DIGITS.test(rest[1] ?? "")) {
    return { runId: null, jobId: rest[1] ?? "" };
  }
  return null;
}

// CSI and OSC sequences, plus the lone escapes some runners emit.
const ANSI_PATTERN =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** `gh run view --log` prefixes every line with `<job>\t<step>\t`. */
const GH_LOG_PREFIX = /^[^\t\n]*\t[^\t\n]*\t/;
/** The runner's own timestamp, often behind a byte-order mark. */
const RUNNER_TIMESTAMP = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]"],
  [/\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}|xox[abposr]-[A-Za-z0-9-]{10,})\b/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [
    /(\b(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|password|secret)\b\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    "$1[redacted]",
  ],
];

/** Removes credential shapes, and any exact secret the caller knows about, from log text. */
export function scrubLogSecrets(text: string, known: ReadonlyArray<string> = []): string {
  let result = text;
  for (const secret of known) {
    if (secret.length >= 8) result = result.split(secret).join("[redacted]");
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** One log line without colour codes, `gh`'s job/step columns or the runner's timestamp. */
export function cleanLogLine(line: string): string {
  return line
    .replace(ANSI_PATTERN, "")
    .replace(GH_LOG_PREFIX, "")
    .replace(RUNNER_TIMESTAMP, "")
    .replace(/\r$/, "");
}

/**
 * The last `maxLines` cleaned lines, then the last `maxBytes` of those, scrubbed of secrets.
 * `truncated` is true when anything was dropped here or `alreadyTruncated` says the reader did.
 * An empty log is null: a failed step that printed nothing has nothing to hand over.
 */
export function trimFailureLog(
  raw: string,
  options: {
    readonly maxLines?: number;
    readonly maxBytes?: number;
    readonly alreadyTruncated?: boolean;
    readonly knownSecrets?: ReadonlyArray<string>;
  } = {},
): { readonly log: string | null; readonly truncated: boolean } {
  const maxLines = options.maxLines ?? CHECK_FAILURE_LOG_MAX_LINES;
  const maxBytes = options.maxBytes ?? CHECK_FAILURE_LOG_MAX_BYTES;
  let truncated = options.alreadyTruncated ?? false;
  const lines = raw.split("\n").map(cleanLogLine);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  if (lines.length === 0) return { log: null, truncated: false };
  let kept = lines;
  if (kept.length > maxLines) {
    kept = kept.slice(-maxLines);
    truncated = true;
  }
  let text = scrubLogSecrets(kept.join("\n"), options.knownSecrets);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength > maxBytes) {
    // Cut on a byte boundary, then drop the partial first line and any split character.
    const tail = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(-maxBytes));
    const firstBreak = tail.indexOf("\n");
    text = (firstBreak === -1 ? tail : tail.slice(firstBreak + 1)).replace(/^�+/, "");
    truncated = true;
  }
  return { log: text.length === 0 ? null : text, truncated };
}

/** A bounded tail of a byte stream, for reading a log whose end is the part that matters. */
export class ByteTail {
  private chunks: Array<Uint8Array> = [];
  private bytes = 0;
  /** The kept text starts part-way through a line the dropped chunks began. */
  private startsMidLine = false;
  overflowed = false;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.bytes -= dropped?.byteLength ?? 0;
      this.startsMidLine = dropped?.[dropped.byteLength - 1] !== 0x0a;
      this.overflowed = true;
    }
  }

  /** The kept text, without a first line the dropped bytes cut in half. */
  text(): string {
    const joined = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
    if (!this.startsMidLine) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? text : text.slice(firstBreak + 1);
  }
}
