// @effect-diagnostics nodeBuiltinImport:off - small files are read with no-follow descriptors.
/**
 * Secret checks that need a file's content, not just its name: what a direnv
 * `.envrc` does, and well-known token formats in small untracked config files.
 * Also which folders hold someone else's code (vendored checkouts, submodules),
 * whose marker files say nothing about this project's secrets.
 *
 * @module secretContent
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type { FileClass } from "./classify.ts";

/** Bytes read from one file for a content check. */
export const MAX_CONTENT_PROBE_BYTES = 64 * 1024;
/** Files whose content one scan reads, so a folder of ignored data cannot cost thousands of reads. */
export const MAX_CONTENT_PROBES = 300;

/** Folders that hold third-party source: their `.envrc` and vault markers are upstream's, not the project's. */
const VENDORED_SEGMENTS = new Set([
  ".repos",
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "Pods",
  "Carthage",
]);

/** True for a path inside a vendored folder or inside one of `submodules` (folder-relative paths). */
export function isVendoredPath(relative: string, submodules: ReadonlyArray<string> = []): boolean {
  const parts = relative.split("/");
  if (parts.slice(0, -1).some((part) => VENDORED_SEGMENTS.has(part))) return true;
  return submodules.some((folder) => folder !== "." && relative.startsWith(`${folder}/`));
}

/**
 * High-confidence token formats, the kind GitHub secret scanning and gitleaks
 * match: each has a fixed prefix and length, so ordinary config rarely trips them.
 */
const TOKEN_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  { kind: "private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u },
  { kind: "AWS access key", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/u },
  {
    kind: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,})\b/u,
  },
  { kind: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20}\b/u },
  { kind: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u },
  { kind: "Stripe key", pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/u },
  { kind: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/u },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/u },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
  { kind: "PyPI token", pattern: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,}/u },
];

/** The kind of the first well-known token in `text`, or null. */
export function tokenKind(text: string): string | null {
  return TOKEN_PATTERNS.find((item) => item.pattern.test(text))?.kind ?? null;
}

/** Names whose content is worth one read: config and data formats people paste keys into. */
const PROBED_NAME =
  /(?:\.(?:json|ya?ml|toml|ini|cfg|conf|config|properties|xml|plist|txt|sh|env|vars|rc)|rc)$|^\.[^.]+$/iu;

/** A secret-looking variable name: `API_KEY`, `DB_PASSWORD`, `SENTRY_DSN`, `DATABASE_URL`. */
const SECRET_NAME =
  /(?:KEY|TOKEN|SECRET|PASSW(?:OR)?D|PASS|CREDENTIALS?|AUTH|PRIVATE|DSN|DATABASE_URL|CONN(?:ECTION)?_?STRING)$/iu;

export interface EnvrcReading {
  /** It sets secret values itself (`export API_KEY=...`, a token): it travels only as a ticked secret. */
  readonly holdsValues: boolean;
  /** Where it loads secrets from at run time: "a .env file", "a command", "1Password". Empty for none. */
  readonly loads: ReadonlyArray<string>;
}

/** Sources that are files in the folder, which the scan lists on their own. */
export const ENVRC_FILE_SOURCES: ReadonlySet<string> = new Set(["a .env file", "another env file"]);

const ENVRC_SOURCES: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "1Password", pattern: /\bop:\/\/|\bop\s+(?:read|run|inject)\b/u },
  { label: "Doppler", pattern: /\bdoppler\b/u },
  { label: "Infisical", pattern: /\binfisical\b/u },
  { label: "HashiCorp Vault", pattern: /\bvault\s+(?:kv|read)\b/u },
  { label: "SOPS", pattern: /\bsops\b/u },
  { label: "pass", pattern: /\b(?:gopass|pass)\s+(?:show|cat)\b/u },
  { label: "Bitwarden", pattern: /\bbws?\s+(?:get|secret)\b/u },
  {
    label: "the keychain",
    pattern: /\bsecurity\s+find-(?:generic|internet)-password\b|\bsecret-tool\s+lookup\b/u,
  },
  {
    label: "a cloud secret manager",
    pattern: /\baws\s+(?:secretsmanager|ssm)\b|\bgcloud\s+secrets\b|\baz\s+keyvault\b/u,
  },
  { label: "a .env file", pattern: /^\s*dotenv(?:_if_exists)?\b/mu },
  {
    label: "another env file",
    pattern: /^\s*(?:source_env(?:_if_exists)?|source|\.)\s+(?!\S*\.envrc\s*$)\S/mu,
  },
];

/**
 * What a direnv `.envrc` does with secrets. `use flake`, `use nix`, `layout python`
 * and `PATH_add` load none; `dotenv`, `source_env`, a command or a vault CLI load
 * them from elsewhere; `export TOKEN=...` with a literal value holds one.
 */
export function readEnvrc(text: string): EnvrcReading {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  let holdsValues = tokenKind(lines.join("\n")) !== null;
  let command = false;
  for (const line of lines) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !SECRET_NAME.test(match[1]!)) continue;
    const value = match[2]!.trim().replace(/^["']|["']$/gu, "");
    // `TOKEN=$(gh auth token)` loads a value; `$OTHER` refers to one; anything else holds it.
    if (value.startsWith("$(") || value.startsWith("`")) command = true;
    else if (value !== "" && !value.startsWith("$")) holdsValues = true;
  }
  const body = lines.join("\n");
  const loads = ENVRC_SOURCES.filter((source) => source.pattern.test(body)).map(
    (source) => source.label,
  );
  // A vault CLI already says where the value comes from.
  if (command && loads.length === 0) loads.push("a command");
  return { holdsValues, loads };
}

/** Reads a small regular file without following a link; null when it is gone, large or a link. */
export async function readSmallText(absolute: string, limit: number): Promise<string | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const bytes = await handle.readFile();
    // Binary files (a NUL in the first kilobyte) hold no config text.
    if (bytes.subarray(0, 1024).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export interface ContentBudget {
  probes: number;
}

/**
 * The class of a file once its content is known. A name-matched `.envrc` that
 * holds no secret values is an ordinary file again (direnv needs `direnv allow`
 * on the new machine, nothing else); a small untracked config file holding a
 * well-known token becomes a secret. Tracked files and Git data never change.
 */
export async function refineClassByContent(input: {
  readonly absolute: string;
  readonly relative: string;
  readonly size: number;
  readonly fileClass: FileClass;
  readonly gitState: "tracked" | "untracked" | "ignored" | "outside";
  readonly budget: ContentBudget;
}): Promise<FileClass> {
  const name = input.relative.split("/").at(-1) ?? "";
  const envrc = name === ".envrc" && input.fileClass === "secret";
  const probe =
    (input.fileClass === "untracked" || input.fileClass === "ignoredData") &&
    PROBED_NAME.test(name);
  if ((!envrc && !probe) || input.size > MAX_CONTENT_PROBE_BYTES) return input.fileClass;
  if (input.budget.probes >= MAX_CONTENT_PROBES) return input.fileClass;
  input.budget.probes += 1;
  const text = await readSmallText(input.absolute, MAX_CONTENT_PROBE_BYTES);
  if (text === null) return input.fileClass;
  if (envrc) {
    if (readEnvrc(text).holdsValues) return "secret";
    return input.gitState === "ignored" ? "ignoredData" : "untracked";
  }
  return tokenKind(text) === null ? input.fileClass : "secret";
}

/**
 * Whether captured bytes of a file the scan judged by its content would now be a secret:
 * a `.envrc` that holds values, or a config file holding a known token. A probed file
 * grown past the probe limit (or unreadable, `bytes` null) cannot be judged and counts as
 * one, and so does a `.envrc` turned binary; other binary files keep their class, as the
 * scan keeps it.
 */
export function capturedContentIsSecret(
  relative: string,
  bytes: Uint8Array | null,
  size: number,
): boolean {
  if (bytes === null || size > MAX_CONTENT_PROBE_BYTES) return true;
  const envrc = relative.split("/").at(-1) === ".envrc";
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 1024).includes(0)) return envrc;
  const text = buffer.toString("utf8");
  return envrc ? readEnvrc(text).holdsValues : tokenKind(text) !== null;
}
