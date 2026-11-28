/**
 * Checks the link an MCP server asks the person to open (`elicitation/create`
 * in URL mode, or the `-32042` "URL elicitation required" error). The server
 * adapter refuses what must never be shown, and the web card highlights the
 * registrable domain and shows the warnings, so both read the link the same
 * way.
 *
 * - Only `http` and `https` links are shown; anything else is refused. The
 *   link must spell out `http://` or `https://`: a browser resolves
 *   `https:host/path` against the page it is on, not to `host` (1498 review).
 * - Whitespace, control characters and backslashes are refused: the parser
 *   drops or rewrites them, so the link would not go where it reads.
 * - A link with user info (`user@host` or `user:pass@host`) is refused: it
 *   hides where it goes behind a name that looks like a host.
 * - A host in Punycode (`xn--`), a host that mixes scripts, and a link that is
 *   not `https` (other than a loopback `http` link) get a warning.
 * - The link itself is never changed: {@link McpElicitationUrl.url} is the
 *   string exactly as the server sent it.
 *
 * Browser-safe: no Node modules, so the web card uses it too.
 *
 * @module mcpElicitationUrl
 */

/** A link longer than this is refused rather than shown. */
export const MCP_ELICITATION_URL_MAX_LENGTH = 8 * 1024;

export type McpElicitationUrlRefusal = "unparseable" | "too-long" | "scheme" | "user-info";

export type McpElicitationUrlWarning = "punycode" | "mixed-script" | "not-https";

export interface McpElicitationUrl {
  /** The link exactly as the server sent it. */
  readonly url: string;
  readonly scheme: "http" | "https";
  /** The host as the browser resolves it (ASCII, Punycode kept). */
  readonly host: string;
  /** The host as a person reads it, Punycode labels decoded. */
  readonly displayHost: string;
  /** The part of {@link displayHost} a person must trust, for example `example.co.uk`. */
  readonly registrableDomain: string;
  readonly warnings: ReadonlyArray<McpElicitationUrlWarning>;
}

export type McpElicitationUrlCheck =
  | { readonly ok: true; readonly link: McpElicitationUrl }
  | { readonly ok: false; readonly reason: McpElicitationUrlRefusal };

// Suffixes under which a name is registered one label deeper: country second
// levels, and hosting suffixes where each tenant is its own owner
// (`tenant.gitlab.io`). A short list of the common ones, not the Public Suffix
// List, which would weigh down the web bundle: a miss highlights one label too
// few, and the full host is still shown beside it.
const MULTI_LABEL_SUFFIXES = new Set([
  "ac.uk",
  "co.uk",
  "gov.uk",
  "ltd.uk",
  "me.uk",
  "net.uk",
  "org.uk",
  "plc.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "co.in",
  "net.in",
  "org.in",
  "co.za",
  "com.br",
  "net.br",
  "org.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.mx",
  "com.sg",
  "com.tr",
  "com.tw",
  "com.ua",
  "co.il",
  "github.io",
  "gitlab.io",
  "bitbucket.io",
  "codeberg.page",
  "readthedocs.io",
  "firebaseapp.com",
  "web.app",
  "cloudfunctions.net",
  "r2.dev",
  "fly.dev",
  "deno.dev",
  "onrender.com",
  "railway.app",
  "replit.app",
  "repl.co",
  "glitch.me",
  "surge.sh",
  "now.sh",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "amplifyapp.com",
  "azurestaticapps.net",
  "sharepoint.com",
  "myshopify.com",
  "wixsite.com",
  "webflow.io",
  "framer.app",
  "blogspot.com",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
]);

/** Checks a link from an MCP server; see the module notes for the rules. */
export function checkMcpElicitationUrl(raw: unknown): McpElicitationUrlCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "unparseable" };
  if (raw.length > MCP_ELICITATION_URL_MAX_LENGTH) return { ok: false, reason: "too-long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return { ok: false, reason: "unparseable" };
  // Bidirectional controls can reorder the link as the card shows it.
  if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(raw))
    return { ok: false, reason: "unparseable" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return { ok: false, reason: "scheme" };
  // An explicit `//` and a host right after it: `https:host` resolves against
  // the page, and `https:///@host` reads as one host but opens another.
  if (!/^https?:\/\/[^/?#]/i.test(raw)) return { ok: false, reason: "unparseable" };
  // A `.` or `..` segment, plain or as `%2e`, is folded away on opening, so the
  // path opened would not be the path shown.
  if (hasDotSegment(raw)) return { ok: false, reason: "unparseable" };
  // The parser keeps user info only in these fields; a bare `@` before the
  // host also counts, even when both are empty (`https://@evil.example`).
  if (parsed.username !== "" || parsed.password !== "" || hasEmptyUserInfo(raw))
    return { ok: false, reason: "user-info" };
  const host = parsed.hostname;
  if (host === "") return { ok: false, reason: "unparseable" };
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const displayHost = host
    .split(".")
    .map((label) =>
      label.startsWith("xn--") ? (decodePunycodeLabel(label.slice(4)) ?? label) : label,
    )
    .join(".");
  const warnings: Array<McpElicitationUrlWarning> = [];
  if (host.split(".").some((label) => label.startsWith("xn--"))) warnings.push("punycode");
  if (mixesScripts(displayHost)) warnings.push("mixed-script");
  if (scheme === "http" && !isLoopbackHost(host)) warnings.push("not-https");
  return {
    ok: true,
    link: {
      url: raw,
      scheme,
      host,
      displayHost,
      registrableDomain: registrableDomainOf(displayHost),
      warnings,
    },
  };
}

/** The registrable domain of a host, for example `example.co.uk` for `a.b.example.co.uk`. */
export function registrableDomainOf(host: string): string {
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  if (isIpHost(bare) || !bare.includes(".")) return bare;
  const labels = bare.split(".");
  const lastTwo = labels.slice(-2).join(".");
  const lower = bare.toLowerCase();
  const wildcard = WILDCARD_SUFFIXES.find((suffix) => lower.endsWith(`.${suffix}`));
  const depth =
    wildcard !== undefined
      ? wildcard.split(".").length + 2
      : MULTI_LABEL_SUFFIXES.has(lastTwo.toLowerCase())
        ? 3
        : 2;
  return labels.slice(-depth).join(".");
}

// Wildcard suffixes (`*.run.app`): every name one label below is itself a
// suffix, so a name is registered two labels deeper.
// Longest first.
const WILDCARD_SUFFIXES = ["mtls.run.app", "run.app"];

function hasDotSegment(raw: string): boolean {
  const afterAuthority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const path = afterAuthority.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function hasEmptyUserInfo(raw: string): boolean {
  const afterScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

function isIpHost(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

// Scripts a host's letters may come from. Japanese mixes Han, Hiragana and
// Katakana, and Korean mixes Han and Hangul, so those count as one each.
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["cjk", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ["thai", /\p{Script=Thai}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["georgian", /\p{Script=Georgian}/u],
];

/** True when one label of the host has letters from more than one script. */
function mixesScripts(displayHost: string): boolean {
  return displayHost.split(".").some((label) => {
    const seen = new Set<string>();
    for (const char of label) {
      // Marks shared by scripts (the Japanese long-vowel mark, digits) count for none.
      if (!/\p{L}/u.test(char) || /[\p{Script=Common}\p{Script=Inherited}]/u.test(char)) continue;
      const script = SCRIPTS.find(([, pattern]) => pattern.test(char))?.[0] ?? "other";
      seen.add(script);
      if (seen.size > 1) return true;
    }
    return false;
  });
}

// RFC 3492 decoding of one label's Punycode, without the `xn--` prefix.
// Returns null for input that is not valid Punycode.
function decodePunycodeLabel(input: string): string | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const skew = 38;
  const damp = 700;
  const adapt = (delta: number, points: number, first: boolean) => {
    let d = first ? Math.floor(delta / damp) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew));
  };
  const digit = (code: number) =>
    code >= 48 && code <= 57
      ? code - 22
      : code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 97
          : base;
  const lastDash = input.lastIndexOf("-");
  const output: Array<number> = [];
  for (let i = 0; i < Math.max(lastDash, 0); i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = lastDash > 0 ? lastDash + 1 : 0; index < input.length;) {
    const oldI = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (index >= input.length) return null;
      const d = digit(input.charCodeAt(index++));
      if (d >= base) return null;
      i += d * w;
      if (i > 0x10ffff * 64) return null;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    const points = output.length + 1;
    bias = adapt(i - oldI, points, oldI === 0);
    n += Math.floor(i / points);
    i %= points;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}
