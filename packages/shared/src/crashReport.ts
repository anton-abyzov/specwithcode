/**
 * Automatic crash and error reports.
 *
 * Every surface (desktop main process, server, mobile, web) builds a report
 * with {@link buildCrashReport} and posts it to the relay's
 * `POST /v1/crash-reports`. The relay validates it again with
 * {@link parseCrashReport} and writes one structured Workers Logs line.
 *
 * Reports carry product metadata and a sanitized error only: never prompts,
 * responses, file contents, tokens, account ids, conversation ids or raw paths.
 * This module has no platform imports so mobile and the Worker can use it.
 */

export const CRASH_REPORT_FORMAT = 1 as const;
export const CRASH_REPORT_DEFAULT_RELAY_ORIGIN = "https://relay.spec-weave.com";
export const CRASH_REPORT_PATH = "/v1/crash-reports";
export const SITE_EVENT_PATH = "/v1/site-events";
/** Hard cap on the encoded request body, enforced by clients and the relay. */
export const CRASH_REPORT_MAX_BYTES = 16_384;
export const CRASH_REPORT_MAX_MESSAGE_CHARS = 1_000;
export const CRASH_REPORT_MAX_STACK_CHARS = 8_000;
export const CRASH_REPORT_MAX_SHORT_CHARS = 80;
export const CRASH_REPORT_MAX_DETAIL_KEYS = 12;
/** Env var that turns automatic reports off (`false`, `0`, `off`, `no`). */
export const CRASH_REPORTS_ENV = "STUDIO_CRASH_REPORTS";
/** Env var that overrides the relay origin reports go to (https only). */
export const CRASH_REPORT_URL_ENV = "STUDIO_CRASH_REPORT_URL";

export const CRASH_REPORT_SURFACES = ["desktop", "server", "mobile", "web", "relay"] as const;
export type CrashReportSurface = (typeof CRASH_REPORT_SURFACES)[number];

export const CRASH_REPORT_KINDS = [
  "uncaught_exception",
  "unhandled_rejection",
  "renderer_gone",
  "child_process_gone",
  "server_exit",
  "fatal",
  "turn_failed",
  "js_error",
  "test",
] as const;
export type CrashReportKind = (typeof CRASH_REPORT_KINDS)[number];

export type CrashReportDetailValue = string | number | boolean;

export interface CrashReport {
  readonly v: typeof CRASH_REPORT_FORMAT;
  /** Random per-installation UUID. Never an account or conversation id. */
  readonly installId: string;
  /** Coarse machine label: `<os>-<arch>-<12 hex of a hostname hash>`. */
  readonly machine: string;
  readonly surface: CrashReportSurface;
  readonly kind: CrashReportKind;
  /** Failure category, e.g. a provider failure class or a renderer exit reason. */
  readonly category: string;
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion?: string;
  readonly arch: string;
  readonly provider?: string;
  readonly model?: string;
  readonly errorName?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly detail?: Readonly<Record<string, CrashReportDetailValue>>;
  /** How many identical reports were folded into this one on the client. */
  readonly count?: number;
}

export interface CrashReportInput {
  readonly installId: string;
  readonly machine: string;
  readonly surface: CrashReportSurface;
  readonly kind: CrashReportKind;
  readonly category?: string | null;
  readonly appVersion: string;
  readonly os: string;
  readonly osVersion?: string | null;
  readonly arch: string;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly error?: unknown;
  readonly detail?: Readonly<Record<string, unknown>> | null;
  readonly count?: number | null;
  /** Home directory to strip from messages and stacks, when known. */
  readonly homeDir?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9._:+/@-]+$/u;
const MACHINE_PATTERN = /^[a-z0-9_]{1,24}-[a-z0-9_]{1,16}-[0-9a-f]{12}$/u;

/** True unless the value explicitly turns reports off. Unset means on. */
export function crashReportsEnabledFromEnv(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const normalized = value.trim().toLowerCase();
  return !["false", "0", "off", "no", "disabled"].includes(normalized);
}

/** Resolves the full report endpoint, falling back to the production relay. */
export function crashReportEndpoint(override?: string | null, path = CRASH_REPORT_PATH): string {
  const origin = normalizeHttpsOrigin(override) ?? CRASH_REPORT_DEFAULT_RELAY_ORIGIN;
  return `${origin}${path}`;
}

function normalizeHttpsOrigin(value: string | null | undefined): string | null {
  if (!value || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `<os>-<arch>-<hash12>`; the caller hashes the hostname with its own crypto. */
export function crashReportMachineLabel(os: string, arch: string, hostnameHashHex: string): string {
  const hash = hostnameHashHex
    .toLowerCase()
    .replace(/[^0-9a-f]/gu, "")
    .slice(0, 12)
    .padEnd(12, "0");
  return `${shortSlug(os, 24)}-${shortSlug(arch, 16)}-${hash}`;
}

function shortSlug(value: string, max: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, max);
  return slug.length > 0 ? slug : "unknown";
}

const HOME_PATTERNS: ReadonlyArray<RegExp> = [
  /\/Users\/[^/\s'"`:)]+/gu,
  /\/home\/[^/\s'"`:)]+/gu,
  /\/root(?=[/\s'"`:)]|$)/gu,
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`:)]+/gu,
  /\\\\wsl(?:\$|\.localhost)\\[^\\\s]+\\home\\[^\\\s'"`:)]+/giu,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Replaces the user's home directory with `~` everywhere it appears. */
export function stripHomePaths(text: string, homeDir?: string | null): string {
  let result = text;
  const home = homeDir?.trim();
  if (home && home.length > 1) {
    const variants = new Set([home, home.replace(/\\/gu, "/"), home.replace(/\//gu, "\\")]);
    for (const variant of variants) {
      result = result.replace(new RegExp(escapeRegExp(variant), "giu"), "~");
    }
  }
  for (const pattern of HOME_PATTERNS) {
    result = result.replace(pattern, "~");
  }
  return result;
}

const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // URL credentials, query strings and fragments.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/giu, "$1<redacted>@"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"]+)[?#][^\s'"]*/giu, "$1?<redacted>"],
  // Authorization values.
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 <redacted>"],
  // key=value and JSON secret fields.
  [
    /(["']?(?:[a-z_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential|authorization|cookie|session)[a-z_-]*)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/giu,
    "$1<redacted>",
  ],
  // Well-known token shapes.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/gu, "<redacted-key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu, "<redacted-key>"],
  [
    /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/gu,
    "<redacted-key>",
  ],
  [/\b(?:grok_|xai[_-]|crsr_|vsk_|sw_)[A-Za-z0-9_-]{12,}/gu, "<redacted-key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "<redacted-jwt>"],
  // Emails.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, "<email>"],
  // Long opaque blobs (hex or base64) that look like keys or ids.
  [/\b[A-Fa-f0-9]{32,}\b/gu, "<hex>"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/gu, "<blob>"],
  // UUIDs can be conversation or account ids.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<uuid>"],
  // IPv4 addresses.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "<ip>"],
];

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Removes secrets, emails, ids and home paths from free text. */
export function redactDiagnosticText(text: string, homeDir?: string | null): string {
  let result = stripHomePaths(text.replace(CONTROL_CHARACTERS, ""), homeDir);
  for (const [pattern, replacement] of SECRET_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

const ABSOLUTE_PATH_PATTERN =
  /(?:~(?:[\\/][^\\/\s'"`:()<>]+)+|(?:[A-Za-z]:)?(?:[\\/][^\\/\s'"`:()<>]+){2,})[\\/]?(?=[\s'"`:()<>,]|$)/gu;

/**
 * Error messages from fs and spawn often name user files. Messages keep the
 * error text but every path is replaced, so no file or folder name leaves.
 */
export function sanitizeErrorMessage(message: string, homeDir?: string | null): string {
  const redacted = redactDiagnosticText(message, homeDir).replace(ABSOLUTE_PATH_PATTERN, "<path>");
  return truncate(redacted.trim(), CRASH_REPORT_MAX_MESSAGE_CHARS);
}

/**
 * Stacks keep function names and code locations so a failure can be found,
 * with the home directory shown as `~` and secrets redacted.
 */
export function sanitizeStack(stack: string, homeDir?: string | null): string {
  const lines = redactDiagnosticText(stack, homeDir)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 60);
  // The first line repeats the message; it goes through the stricter message rules.
  if (lines.length > 0 && !/^\s+at\s/u.test(lines[0]!)) {
    lines[0] = sanitizeErrorMessage(lines[0]!, homeDir);
  }
  return truncate(lines.join("\n"), CRASH_REPORT_MAX_STACK_CHARS);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function shortToken(value: unknown, max = CRASH_REPORT_MAX_SHORT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  if (trimmed.length === 0 || !SHORT_TOKEN_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function safeVersion(value: unknown): string {
  return typeof value === "string" &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/u.test(value.trim())
    ? value.trim()
    : "unknown";
}

interface ErrorParts {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
}

function errorParts(error: unknown): ErrorParts {
  if (error === undefined || error === null) return {};
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === "string") return { message: error };
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record._tag === "string" && typeof record.name !== "string"
        ? { name: record._tag }
        : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    };
  }
  return { message: String(error) };
}

function sanitizeDetail(
  detail: Readonly<Record<string, unknown>> | null | undefined,
  homeDir?: string | null,
): Record<string, CrashReportDetailValue> | undefined {
  if (!detail) return undefined;
  const result: Record<string, CrashReportDetailValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(result).length >= CRASH_REPORT_MAX_DETAIL_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(key)) continue;
    if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string" && value.length > 0) {
      result[key] = truncate(sanitizeErrorMessage(value, homeDir), 200);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Normalizes and sanitizes a report. Every surface goes through this. */
export function buildCrashReport(input: CrashReportInput): CrashReport {
  const parts = errorParts(input.error);
  const homeDir = input.homeDir ?? null;
  const category = shortToken(input.category) ?? input.kind;
  const provider = shortToken(input.provider);
  const model = shortToken(input.model, 120);
  const errorName = shortToken(parts.name);
  const osVersion = shortToken(input.osVersion, 40);
  const message = parts.message ? sanitizeErrorMessage(parts.message, homeDir) : undefined;
  const stack = parts.stack ? sanitizeStack(parts.stack, homeDir) : undefined;
  const detail = sanitizeDetail(input.detail, homeDir);
  const count =
    typeof input.count === "number" && Number.isInteger(input.count) && input.count > 1
      ? Math.min(input.count, 1_000_000)
      : undefined;
  return {
    v: CRASH_REPORT_FORMAT,
    installId: UUID_PATTERN.test(input.installId)
      ? input.installId
      : "00000000-0000-0000-0000-000000000000",
    machine: MACHINE_PATTERN.test(input.machine) ? input.machine : "unknown-unknown-000000000000",
    surface: input.surface,
    kind: input.kind,
    category,
    appVersion: safeVersion(input.appVersion),
    os: shortSlug(input.os, 24),
    ...(osVersion ? { osVersion } : {}),
    arch: shortSlug(input.arch, 16),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(errorName ? { errorName } : {}),
    ...(message ? { message } : {}),
    ...(stack ? { stack } : {}),
    ...(detail ? { detail } : {}),
    ...(count ? { count } : {}),
  };
}

/** JSON body for the relay, shrunk to fit {@link CRASH_REPORT_MAX_BYTES}. */
export function encodeCrashReport(report: CrashReport): string {
  let body = JSON.stringify(report);
  if (utf8Length(body) <= CRASH_REPORT_MAX_BYTES) return body;
  const { stack: _stack, ...withoutStack } = report;
  const shorter: CrashReport = report.stack
    ? { ...withoutStack, stack: report.stack.slice(0, 2_000) }
    : withoutStack;
  body = JSON.stringify(shorter);
  if (utf8Length(body) <= CRASH_REPORT_MAX_BYTES) return body;
  const { stack: _s, detail: _d, ...minimal } = shorter;
  return JSON.stringify({ ...minimal, message: (minimal.message ?? "").slice(0, 400) });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isOneOf<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
  return typeof value === "string" && (values as ReadonlyArray<string>).includes(value);
}

/**
 * Relay-side validation of an untrusted body. Returns a re-sanitized report
 * or null when the shape is wrong. Text is sanitized again because the relay
 * must not trust that an old or modified client did it.
 */
export function parseCrashReport(value: unknown): CrashReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== CRASH_REPORT_FORMAT) return null;
  if (typeof record.installId !== "string" || !UUID_PATTERN.test(record.installId)) return null;
  if (typeof record.machine !== "string" || !MACHINE_PATTERN.test(record.machine)) return null;
  if (!isOneOf(CRASH_REPORT_SURFACES, record.surface)) return null;
  if (!isOneOf(CRASH_REPORT_KINDS, record.kind)) return null;
  if (
    typeof record.appVersion !== "string" ||
    typeof record.os !== "string" ||
    typeof record.arch !== "string"
  ) {
    return null;
  }
  const detail =
    typeof record.detail === "object" && record.detail !== null && !Array.isArray(record.detail)
      ? (record.detail as Record<string, unknown>)
      : null;
  const report = buildCrashReport({
    installId: record.installId,
    machine: record.machine,
    surface: record.surface,
    kind: record.kind,
    category: typeof record.category === "string" ? record.category : null,
    appVersion: record.appVersion,
    os: record.os,
    osVersion: typeof record.osVersion === "string" ? record.osVersion : null,
    arch: record.arch,
    provider: typeof record.provider === "string" ? record.provider : null,
    model: typeof record.model === "string" ? record.model : null,
    error: {
      ...(typeof record.errorName === "string" ? { name: record.errorName } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
    },
    detail,
    count: typeof record.count === "number" ? record.count : null,
  });
  return report;
}

/** Key a client uses to fold repeats of the same failure. */
export function crashReportFingerprint(report: CrashReport): string {
  const firstFrame =
    report.stack
      ?.split("\n")
      .find((line) => /^\s+at\s/u.test(line))
      ?.trim() ?? "";
  return [report.surface, report.kind, report.category, report.errorName ?? "", firstFrame].join(
    "|",
  );
}

// ---------------------------------------------------------------------------
// Marketing site events (download clicks), sent to `POST /v1/site-events`.

export const SITE_EVENT_PLATFORMS = [
  "mac",
  "windows",
  "linux-deb",
  "linux-appimage",
  "linux-server",
  "install-script",
  "other",
] as const;
export type SiteEventPlatform = (typeof SITE_EVENT_PLATFORMS)[number];

export const SITE_EVENT_NAMES = [
  "download_click",
  "install_copy",
  "mobile_store_click",
  "chrome_extension_click",
  "github_star_click",
  "feedback_click",
] as const;
export type SiteEventName = (typeof SITE_EVENT_NAMES)[number];

export interface SiteEvent {
  readonly v: 1;
  readonly event: SiteEventName;
  readonly platform: SiteEventPlatform;
  /** Asset suffix or file name such as `arm64.dmg` or `SpecWithCode-1.0.1-x64.exe`. */
  readonly asset?: string;
  /** Where on the page the control sits, e.g. `hero` or `download-page-windows`. */
  readonly placement?: string;
  /** Page path, e.g. `/code/download/`. */
  readonly page?: string;
}

export const SITE_EVENT_MAX_BYTES = 1_024;

export function parseSiteEvent(value: unknown): SiteEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (!isOneOf(SITE_EVENT_NAMES, record.event)) return null;
  const platform = isOneOf(SITE_EVENT_PLATFORMS, record.platform) ? record.platform : "other";
  const asset = shortToken(record.asset, 80);
  const placement = shortToken(record.placement, 60);
  const page =
    typeof record.page === "string" && /^\/[A-Za-z0-9/_.-]{0,80}$/u.test(record.page)
      ? record.page
      : undefined;
  return {
    v: 1,
    event: record.event,
    platform,
    ...(asset ? { asset } : {}),
    ...(placement ? { placement } : {}),
    ...(page ? { page } : {}),
  };
}

/** Maps a release asset name or suffix to the download platform it serves. */
export function siteEventPlatformForAsset(asset: string): SiteEventPlatform {
  const name = asset.toLowerCase();
  if (name.endsWith(".dmg") || name.endsWith("-mac.zip")) return "mac";
  if (name.endsWith(".exe") || name.endsWith(".msi")) return "windows";
  if (name.endsWith(".deb")) return "linux-deb";
  if (name.endsWith(".appimage")) return "linux-appimage";
  if (/linux-(x64|arm64)/u.test(name) && name.endsWith(".tar.gz")) return "linux-server";
  if (name.endsWith("install.sh") || name.endsWith("install.ps1")) return "install-script";
  return "other";
}
