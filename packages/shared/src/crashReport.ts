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
  /** This machine's hostname, redacted wherever it appears in text. */
  readonly hostname?: string | null;
}

/**
 * Model ids can be user-chosen (a local model file, `user@host/finetune`).
 * Keep only the last path part and drop anything before an `@`.
 */
function safeModelId(value: string | null | undefined, homeDir: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  let model = stripHomePaths(value.trim(), homeDir);
  if (/^(?:~|[A-Za-z]:|[\\/])/u.test(model) || model.includes("\\")) {
    model = model.split(/[\\/]/u).pop() ?? "";
  }
  if (model.includes("@")) model = model.slice(model.lastIndexOf("@") + 1);
  // `ft:gpt-4o:acme-corp:payroll-bot:AbC123` names an organisation and a project;
  // `llama3:8b` is a tag. Two parts keep the tag and drop the rest.
  model = model.split(":").slice(0, 2).join(":");
  const redacted = redactDiagnosticText(model);
  return MODEL_PATTERN.test(redacted.slice(0, 120)) ? redacted.slice(0, 120) : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// No `/` or `@`: a short token is an enum-like word, never a path or an address.
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9._:+-]+$/u;
const MODEL_PATTERN = /^[A-Za-z0-9._:+/-]+$/u;
const MACHINE_PATTERN = /^[a-z0-9_]{1,24}-[a-z0-9_]{1,16}-[0-9a-f]{12}$/u;

/** True unless the value explicitly turns reports off. Unset means on. */
export function crashReportsEnabledFromEnv(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const normalized = value.trim().toLowerCase();
  return !["false", "0", "off", "no", "disabled"].includes(normalized);
}

/**
 * Reads only `crashReportsEnabled` from the text of `settings.json`. Only an
 * explicit `false` turns reports off. A file cut short while it is rewritten
 * does not parse, so the raw field is matched instead.
 */
export function settingsTextAllowsCrashReports(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
    return (parsed as Record<string, unknown>).crashReportsEnabled !== false;
  } catch {
    return !/"crashReportsEnabled"\s*:\s*false/u.test(raw);
  }
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

/**
 * `<os>-<arch>-<hash12>`. The caller hashes the install id together with the
 * hostname, so the label tells one installation's machines apart and cannot be
 * matched against a list of likely hostnames.
 */
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

// User folder names can contain spaces ("/Users/Anton Abyzov"), so a name runs
// to the next separator, quote or line end rather than the next space.
const HOME_PATTERNS: ReadonlyArray<RegExp> = [
  /\/Users\/[^/\n'"`:)]+/gu,
  /\/home\/[^/\n'"`:)]+/gu,
  /\/root(?=[/\s'"`:)]|$)/gu,
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\n'"`:)]+/gu,
  /\\\\wsl(?:\$|\.localhost)\\[^\\\s]+\\home\\[^\\\n'"`:)]+/giu,
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

// Authorization values: `Bearer <token>`, `Basic <base64>`.
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic|token)[ \t]{1,8}[A-Za-z0-9._~+/=-]{8,4000}/giu;

const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // URL credentials, query strings and fragments.
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"]{1,500}@/giu, "$1<redacted>@"],
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s?#'"]{1,2000})[?#][^\s'"]*/giu, "$1?<redacted>"],
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
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/gu, "<email>"],
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

// The whole dotted name goes, so `git.internal.acme-corp.com` leaves no company domain.
const LOCAL_HOST_PATTERN =
  /(?<![A-Za-z0-9.-])(?:[A-Za-z0-9-]{1,63}\.){1,8}(?:local|lan|home|internal|localdomain)(?:\.[A-Za-z0-9-]{1,63}){0,8}(?![A-Za-z0-9-])/giu;

/** Longest text the redaction rules ever scan; a report is capped at 16 KiB anyway. */
const REDACT_INPUT_MAX_CHARS = 16_384;

const SECRET_KEY_WORD =
  /token|secret|password|passwd|api[_-]?key|apikey|credential|authorization|cookie|session/iu;
// A key is one whole run of name characters, found from its first character
// only, so a long run costs one bounded attempt and not one per position.
const FIELD_KEY_PATTERN = /(?<![A-Za-z0-9_-])["']?([A-Za-z0-9_-]{1,2000})["']?\s{0,8}[:=]\s{0,8}/gu;
// A header value runs to the end of its line: `Bearer <token>`, `sid=a; csrf=b`.
const HEADER_KEY_WORD = /authorization|cookie/iu;
const LINE_REST_PATTERN = /[^\n]{0,4000}/uy;
const SCHEME_REST_PATTERN = /[ \t]{1,8}[^\s,;}&"']{1,4000}/uy;
const FIELD_VALUE_PATTERN = /"[^"\n]{0,4000}"|'[^'\n]{0,4000}'|[^\s,;}&]{1,4000}/uy;

/** Redacts the value of `key=value` and JSON fields whose key names a secret. */
function redactSecretFields(text: string): string {
  let result = "";
  let copied = 0;
  FIELD_KEY_PATTERN.lastIndex = 0;
  for (;;) {
    const match = FIELD_KEY_PATTERN.exec(text);
    if (match === null) break;
    const key = match[1] ?? "";
    if (!SECRET_KEY_WORD.test(key)) {
      // Look again right after the key: its value can hold a field of its own.
      FIELD_KEY_PATTERN.lastIndex = match.index + match[0].indexOf(key) + key.length;
      continue;
    }
    const valueStart = FIELD_KEY_PATTERN.lastIndex;
    FIELD_VALUE_PATTERN.lastIndex = valueStart;
    const value = FIELD_VALUE_PATTERN.exec(text);
    if (value === null) continue;
    let end = FIELD_VALUE_PATTERN.lastIndex;
    // A bare header name (`Cookie: a="b c"; csrf=x`) owns its whole line, quotes
    // included. A quoted key is a JSON field, whose value ends at its own quote.
    if (HEADER_KEY_WORD.test(key) && !/^["']/u.test(match[0])) {
      LINE_REST_PATTERN.lastIndex = valueStart;
      if (LINE_REST_PATTERN.exec(text) !== null) end = Math.max(end, LINE_REST_PATTERN.lastIndex);
    } else if (/^(?:bearer|basic|token)$/iu.test(value[0])) {
      // `token: Bearer abc`: the scheme word is not the secret, the next word is.
      SCHEME_REST_PATTERN.lastIndex = end;
      if (SCHEME_REST_PATTERN.exec(text) !== null) end = SCHEME_REST_PATTERN.lastIndex;
    }
    result += `${text.slice(copied, valueStart)}<redacted>`;
    copied = end;
    FIELD_KEY_PATTERN.lastIndex = copied;
  }
  return result + text.slice(copied);
}

/**
 * Words that identify this machine or user (hostname, account name). Each is
 * replaced wherever it appears, case-insensitively. Short or generic values
 * are skipped so ordinary words are not mangled.
 */
function identifyingTerms(
  homeDir?: string | null,
  terms?: ReadonlyArray<string | null | undefined>,
) {
  const result = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < 3) return;
    if (["root", "user", "admin", "runner", "ubuntu", "localhost"].includes(trimmed.toLowerCase()))
      return;
    result.add(trimmed);
  };
  const home = homeDir?.trim().replace(/[\\/]+$/u, "");
  if (home) add(home.split(/[\\/]/u).pop());
  for (const term of terms ?? []) {
    add(term);
    add(term?.replace(/\.(?:local|lan|home|internal|localdomain)$/iu, ""));
  }
  return [...result].sort((a, b) => b.length - a.length);
}

/**
 * Removes secrets, emails, ids, hostnames and home paths from free text.
 * `terms` are extra identifying words, such as the machine's hostname.
 */
export function redactDiagnosticText(
  text: string,
  homeDir?: string | null,
  terms?: ReadonlyArray<string | null | undefined>,
): string {
  // JSON nested in a JSON string escapes its quotes (\"token\":\"x\"); unescape so the
  // key/value rules see the field names.
  let result = text
    .slice(0, REDACT_INPUT_MAX_CHARS)
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\\{1,8}(["'])/gu, "$1");
  result = stripHomePaths(result, homeDir);
  for (const term of identifyingTerms(homeDir, terms)) {
    result = result.replace(new RegExp(escapeRegExp(term), "giu"), "<redacted>");
  }
  result = result.replace(LOCAL_HOST_PATTERN, "<host>");
  // Before the field rule, which would take the scheme word and leave the token.
  result = result.replace(AUTH_SCHEME_PATTERN, "$1 <redacted>");
  result = redactSecretFields(result);
  for (const [pattern, replacement] of SECRET_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// A segment may hold single spaces ("Client Acme"), so a path runs on to the next
// quote, colon, bracket or line end. Over-redacting the words after a path is fine.
const PATH_SEGMENT = String.raw`[^\\/\s'"\x60:()<>]+(?: [^\\/\s'"\x60:()<>]+)*`;
const ABSOLUTE_PATH_PATTERN = new RegExp(
  String.raw`(?:file:\/\/)?(?:~(?:[\\/]${PATH_SEGMENT})+|(?:[A-Za-z]:)?(?:[\\/]${PATH_SEGMENT}){2,})[\\/]?(?=[\s'"\x60:()<>,]|$)`,
  "gu",
);

const URL_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s'"\x60<>)]{1,2000}/giu;

const FILE_EXTENSIONS =
  "jsonl?|md|txt|pdf|docx?|xlsx?|pptx?|csv|ya?ml|toml|env|pem|key|sqlite|db|log|zip|png|jpe?g|gif|mp4|mov|gguf|tsx?|jsx?|mjs|cjs|py|rb|go|rs|sh|html|css|swift|kt|java|cpp|ini|conf|plist|lock";

// Applied to messages only, in order, after secrets and absolute paths are gone.
const MESSAGE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // A failed command line can carry anything: arguments, commit text, a prompt.
  [/\b(Command failed(?: with exit code \d+)?:)[^\n]*/giu, "$1 <command>"],
  // scp-style remotes: `git@host:org/repo.git` (the address is already `<email>`).
  [/(<email>|<redacted>@[A-Za-z0-9.-]{1,255}):[^\s'"\x60]{1,500}/gu, "<email>:<path>"],
  // A host named after a label: `Could not resolve host: x`, `Host: x`, `DNS:x`.
  [
    // The value must look like a name or an address, not an error code.
    /\b(host|hostname|server|DNS|altnames?)\s{0,4}[:=]\s{0,4}(?!<)(?=[A-Za-z0-9-]{0,63}[.\d-])[A-Za-z0-9.-]{1,255}/giu,
    "$1: <host>",
  ],
  // Domain names: any name of three or more labels under a common ending, and
  // two-label names under the endings that are never a property name.
  [
    /(?<![A-Za-z0-9._@/-])(?:[a-z0-9-]{1,63}\.){2,8}(?:com|net|org|io|dev|ai|co|app|cloud|edu|gov|us|uk|de|fr|ru|corp|tech|xyz|info|biz)(?![A-Za-z0-9_-])/giu,
    "<host>",
  ],
  [/(?<![A-Za-z0-9._@/-])[a-z0-9-]{1,63}\.(?:com|net|org|edu|gov)(?![A-Za-z0-9_.-])/giu, "<host>"],
  // The host a network error names.
  [
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN)\s+[^\s,;)]{1,300}/gu,
    "$1 <host>",
  ],
  // IPv6: four or more groups, or any form with `::`.
  [
    /(?<![A-Za-z0-9:.])(?:(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}|[0-9A-Fa-f:]{0,39}::[0-9A-Fa-f:]{0,39})(?![A-Za-z0-9:])/gu,
    "<ip>",
  ],
  // Relative paths; bare file names follow in `redactFileNames`.
  [
    /(?<![A-Za-z0-9_:/\\.<>@-])[A-Za-z0-9_.@-]{1,100}(?:[\\/][A-Za-z0-9_.@-]{1,100}){1,40}(?![A-Za-z0-9_>])/gu,
    "<path>",
  ],
];

const FILE_NAME_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_./\\<@-])[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,100}\.(?:${FILE_EXTENSIONS})(?![A-Za-z0-9_])`,
  "gu",
);
// `console.log is not a function`, `res.json(`, `process.env.X`: a member access
// reads like a file name. It is kept only when every part is a plain identifier,
// the last part is a word that is also a common property, and what follows is
// how code, not a file, is talked about.
const MEMBER_CHAIN_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]{0,40}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,40}){0,4}\.(?:log|json|env|key|db|go|sh|lock|css|html|conf)$/u;
const MEMBER_USE_PATTERN =
  /^(?:\.[A-Za-z_$]|\s{0,2}\(|\s{1,2}is\s{1,2}(?:not\s{1,2}(?:a\s{1,2}function|defined|iterable|a\s{1,2}constructor)|undefined|null)\b)/u;

function redactFileNames(text: string): string {
  return text.replace(FILE_NAME_PATTERN, (match: string, offset: number) =>
    MEMBER_CHAIN_PATTERN.test(match) &&
    MEMBER_USE_PATTERN.test(text.slice(offset + match.length, offset + match.length + 40))
      ? match
      : "<file>",
  );
}

// Quoted text is a file name, an argument or a user's words more often than
// not. A plain identifier ('length', "ENOENT") stays; anything else goes.
const QUOTED_PATTERN = /(?<![A-Za-z0-9])(["'\x60])([^"'\x60\n]{1,400})\1/gu;
const PLAIN_QUOTED_PATTERN = /^(?:[A-Za-z_$][A-Za-z0-9_$]{0,60}|<[a-z-]{1,20}>)$/u;

/**
 * Error messages from fs and spawn often name user files. Messages keep the
 * error text, but paths, file names, quoted text, command lines and hosts are
 * replaced, so no file, folder or server name leaves.
 */
export function sanitizeErrorMessage(
  message: string,
  homeDir?: string | null,
  terms?: ReadonlyArray<string | null | undefined>,
): string {
  // Cut before the rules run, so their cost never depends on what an error holds.
  const input = message.slice(0, CRASH_REPORT_MAX_MESSAGE_CHARS * 4);
  // URLs first, keeping only the scheme: the host can be a company's own
  // server, and the path rule would otherwise cut a URL in half.
  let redacted = redactDiagnosticText(input, homeDir, terms)
    .replace(URL_PATTERN, "$1<host>")
    .replace(ABSOLUTE_PATH_PATTERN, "<path>");
  for (const [pattern, replacement] of MESSAGE_RULES) {
    redacted = redacted.replace(pattern, replacement);
  }
  redacted = redactFileNames(redacted);
  redacted = redacted.replace(QUOTED_PATTERN, (match, quote: string, inner: string) =>
    PLAIN_QUOTED_PATTERN.test(inner) ? match : `${quote}<redacted>${quote}`,
  );
  return truncate(redacted.trim(), CRASH_REPORT_MAX_MESSAGE_CHARS);
}

const FRAME_PATTERN = /^(\s*at\s+(?:.*?\s+\()?)(.+?)(:\d+(?::\d+)?)?(\)?)$/u;

/**
 * A code location keeps only what names the code, not where it lives on disk:
 * the part after the last `node_modules/`, `app.asar/` or a monorepo
 * `apps/` / `packages/` folder, otherwise just the file name.
 */
export function sanitizeCodeLocation(location: string): string {
  if (/^(?:node:|native|<anonymous>|\[native code\]|internal\/)/u.test(location)) return location;
  const path = location.replace(/^file:\/\//u, "").replace(/\\/gu, "/");
  for (const marker of ["node_modules/", "app.asar/", "app.asar.unpacked/"]) {
    const index = path.lastIndexOf(marker);
    if (index >= 0) return path.slice(index + (marker.startsWith("app.asar") ? marker.length : 0));
  }
  const repo =
    /(?:^|\/)((?:apps|packages|infra)\/[^/]+\/(?:src|dist|dist-electron|build)\/.+)$/u.exec(path);
  if (repo) return repo[1]!;
  // Already trimmed by a sender (the relay sanitizes again): keep it as it is.
  if (/^(?:src|dist|dist-electron|build)\/[A-Za-z0-9_./-]+$/u.test(path)) return path;
  return path.split("/").pop() || "<path>";
}

function sanitizeFrame(line: string): string | null {
  if (!/^\s+at\s/u.test(line)) return null;
  const match = FRAME_PATTERN.exec(line);
  if (!match) return null;
  const [, head = "", location = "", position = "", close = ""] = match;
  return `${head}${sanitizeCodeLocation(location)}${position}${close}`;
}

/**
 * Stacks keep function names and code locations so a failure can be found,
 * with the home directory shown as `~` and secrets redacted.
 */
export function sanitizeStack(
  stack: string,
  homeDir?: string | null,
  terms?: ReadonlyArray<string | null | undefined>,
): string {
  const lines = redactDiagnosticText(
    stack.slice(0, CRASH_REPORT_MAX_STACK_CHARS * 2),
    homeDir,
    terms,
  )
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, 60)
    // Frames keep function names and a code location; every other line (the
    // message, which a stack repeats, and its continuation lines) gets the
    // strict message rules.
    .map((line) => sanitizeFrame(line) ?? sanitizeErrorMessage(line, homeDir, terms));
  return truncate(lines.join("\n"), CRASH_REPORT_MAX_STACK_CHARS);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * An enum-like word (category, provider, error name, OS version). A value the
 * redaction rules would change, such as an id, a host or a user name, is dropped.
 */
function shortToken(
  value: unknown,
  max = CRASH_REPORT_MAX_SHORT_CHARS,
  homeDir?: string | null,
  terms?: ReadonlyArray<string | null | undefined>,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  if (trimmed.length === 0 || !SHORT_TOKEN_PATTERN.test(trimmed)) return undefined;
  if (redactDiagnosticText(trimmed, homeDir, terms) !== trimmed) return undefined;
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
  terms?: ReadonlyArray<string | null | undefined>,
): Record<string, CrashReportDetailValue> | undefined {
  if (!detail) return undefined;
  const result: Record<string, CrashReportDetailValue> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(result).length >= CRASH_REPORT_MAX_DETAIL_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(key)) continue;
    if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string" && value.length > 0) {
      result[key] = truncate(sanitizeErrorMessage(value, homeDir, terms), 200);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Only the numbers of an OS release, plus `-wsl` for a WSL kernel. A kernel
 * release can end in a locally chosen name (`6.1.0-acme-ws042`), so the rest
 * of it never leaves.
 */
function safeOsVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const numbers = /^\d{1,6}(?:\.\d{1,6}){0,4}/u.exec(value.trim())?.[0];
  if (numbers === undefined) return undefined;
  return /microsoft|wsl/iu.test(value.slice(0, 200)) ? `${numbers}-wsl` : numbers;
}

/** Normalizes and sanitizes a report. Every surface goes through this. */
export function buildCrashReport(input: CrashReportInput): CrashReport {
  const parts = errorParts(input.error);
  const homeDir = input.homeDir ?? null;
  const terms = [input.hostname];
  const short = (value: unknown, max?: number) => shortToken(value, max, homeDir, terms);
  const category = short(input.category) ?? input.kind;
  const provider = short(input.provider);
  const model = safeModelId(input.model, homeDir);
  const errorName = short(parts.name);
  const osVersion = safeOsVersion(input.osVersion);
  // Provider errors for a failed turn can quote the prompt or the reply (a
  // content-policy or validation error), so a turn failure carries only its
  // category, code and provider, never its message.
  const freeText = input.kind !== "turn_failed";
  const message =
    freeText && parts.message ? sanitizeErrorMessage(parts.message, homeDir, terms) : undefined;
  const stack = freeText && parts.stack ? sanitizeStack(parts.stack, homeDir, terms) : undefined;
  const detail = sanitizeDetail(input.detail, homeDir, terms);
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
