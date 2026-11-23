import type { ProjectWorkspaceSettings } from "@specweave-studio/contracts";

/**
 * Patterns for secrets that must never leave a machine during personal
 * assistant memory sync (API keys, OAuth tokens, private keys, and `.env`
 * secret assignments).
 */
const MEMORY_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/,
  /\b1\/\/[0-9A-Za-z_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
  /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY)[A-Z0-9_]*[ \t]*=[ \t]*['"]?[^\s'"#]{8,}/m,
];

/** Returns true when memory file content matches a known secret pattern. */
export function containsMemorySecret(content: string): boolean {
  return MEMORY_SECRET_PATTERNS.some((pattern) => pattern.test(content));
}

/** Set of memory file names marked local-only in the project's workspace settings. */
export function localOnlyMemorySet(
  settings: { readonly localOnlyMemoryFiles?: readonly string[] | undefined } | null | undefined,
): ReadonlySet<string> {
  return new Set(settings?.localOnlyMemoryFiles ?? []);
}
