/**
 * The Git settings a folder copy carries to another machine (1328).
 *
 * A repository's `.git/config` can name commands Git runs later: hooks paths,
 * fsmonitor, filter and diff drivers, credential helpers, `ext::` remotes,
 * `!command` submodule updates, aliases, includes. Copied as it is, the next
 * ordinary Git call or agent on the destination runs them, and remote URLs can
 * hold a token. So a copied config keeps only an allowlist of plain settings,
 * with user info stripped from every URL; everything else stays behind.
 */
// @effect-diagnostics nodeBuiltinImport:off - folder transfer runs on plain Node promises.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runGit } from "./git.ts";

const PLAIN_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "core.sparsecheckout",
  "core.sparsecheckoutcone",
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
  "core.longpaths",
  "core.splitindex",
  "core.untrackedcache",
  "core.commitgraph",
  "core.multipackindex",
  "extensions.objectformat",
  "extensions.refstorage",
  "extensions.worktreeconfig",
  "extensions.preciousobjects",
  "extensions.partialclone",
  "index.sparse",
  "index.version",
  "lfs.repositoryformatversion",
  "pull.rebase",
  "pull.ff",
  "fetch.prune",
]);

/** Per-name sections whose listed keys are plain values. */
const SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  remote: new Set(["url", "fetch", "promisor", "partialclonefilter", "tagopt"]),
  branch: new Set(["remote", "merge", "rebase", "pushremote"]),
  submodule: new Set(["url", "active", "update", "branch", "shallow"]),
};

const URL_KEYS = new Set(["remote.url", "submodule.url"]);
const SUBMODULE_UPDATE = new Set(["checkout", "rebase", "merge", "none"]);

/**
 * A remote URL safe to carry: user info removed, and only transports that run
 * no local command. Null when it must stay behind.
 */
export function safeRemoteUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2_048) return null;
  // `ext::cmd`, `fd::` and other `<helper>::<address>` forms start programs.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (!["https", "http", "ssh", "git"].includes(scheme)) return null;
    try {
      const url = new URL(value);
      // ssh keeps a plain user name (git@); a password never travels.
      url.password = "";
      if (scheme !== "ssh") url.username = "";
      return url.toString();
    } catch {
      return null;
    }
  }
  // scp-like `user@host:path`; the user part holds no secret but a password cannot appear here.
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return value;
  // Local paths would point at the source machine's folders.
  return null;
}

/** Which entries of a copied config are kept, given `git config --list` pairs. */
export function safeGitConfigEntries(
  entries: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  const kept: Array<readonly [string, string]> = [];
  for (const [rawKey, value] of entries) {
    const key = rawKey.trim();
    const lower = key.toLowerCase();
    if (PLAIN_KEYS.has(lower)) {
      kept.push([key, value]);
      continue;
    }
    if (lower === "core.worktree") {
      // A submodule's checkout lives at a relative path; an absolute one names the source machine.
      if (value.length > 0 && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value))
        kept.push([key, value]);
      continue;
    }
    const first = lower.indexOf(".");
    const last = lower.lastIndexOf(".");
    if (first <= 0 || last === first) continue;
    const section = lower.slice(0, first);
    const name = lower.slice(last + 1);
    if (!SECTION_KEYS[section]?.has(name)) continue;
    if (URL_KEYS.has(`${section}.${name}`)) {
      const url = safeRemoteUrl(value);
      if (url !== null) kept.push([key, url]);
      continue;
    }
    if (section === "submodule" && name === "update" && !SUBMODULE_UPDATE.has(value.trim()))
      continue;
    kept.push([key, value]);
  }
  return kept;
}

/** Parses `git config --null --list` output: `key\nvalue\0` records. */
export function parseNullConfigList(output: string): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const newline = record.indexOf("\n");
    entries.push(
      newline < 0 ? [record, "true"] : [record.slice(0, newline), record.slice(newline + 1)],
    );
  }
  return entries;
}

/** Writes `target` holding only the safe entries of `source`, read without following includes. */
async function writeSafeGitConfig(
  source: string,
  target: string,
  options: { readonly signal?: AbortSignal },
): Promise<void> {
  const cwd = NodePath.dirname(source);
  const signal = options.signal ? { signal: options.signal } : {};
  const listed = await runGit(
    cwd,
    ["config", "--file", source, "--no-includes", "--null", "--list"],
    signal,
  );
  const kept = safeGitConfigEntries(parseNullConfigList(listed.stdout));
  await NodeFSP.rm(target, { force: true });
  await NodeFSP.writeFile(target, "", { mode: 0o600 });
  for (const [key, value] of kept)
    await runGit(cwd, ["config", "--file", target, "--add", key, value], signal);
}

/**
 * Rewrites one copied config file to its safe entries. Reads it without
 * following includes, then writes a fresh file in its place.
 */
export async function rewriteCopiedGitConfig(
  file: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const exists = await NodeFSP.lstat(file).catch(() => null);
  if (!exists?.isFile()) return;
  const fresh = `${file}.safe`;
  await writeSafeGitConfig(file, fresh, options);
  await NodeFSP.rename(fresh, file);
}

/**
 * The bytes a copy would carry for a live config file, so a later drift check
 * compares like with like. Null when the file is missing.
 */
export async function safeGitConfigBytes(file: string): Promise<Buffer | null> {
  const exists = await NodeFSP.lstat(file).catch(() => null);
  if (!exists?.isFile()) return null;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-safe-config-"));
  try {
    const target = NodePath.join(directory, "config");
    await writeSafeGitConfig(file, target, {});
    return await NodeFSP.readFile(target);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Every config file in a copied Git directory: its own and its per-worktree
 * `config.worktree` files (sparse checkout lives there), and those of the
 * submodules' Git directories under `modules/`.
 */
export async function rewriteCopiedGitConfigs(
  gitDir: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  await rewriteCopiedGitConfig(NodePath.join(gitDir, "config"), options);
  await rewriteCopiedGitConfig(NodePath.join(gitDir, "config.worktree"), options);
  for (const admin of await NodeFSP.readdir(NodePath.join(gitDir, "worktrees"), {
    withFileTypes: true,
  }).catch(() => []))
    if (admin.isDirectory())
      await rewriteCopiedGitConfig(
        NodePath.join(gitDir, "worktrees", admin.name, "config.worktree"),
        options,
      );
  // Submodule Git directories nest as modules/<name>[/modules/<name>…].
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 16) return;
    const children = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const nested = NodePath.join(dir, child.name);
      if (await NodeFSP.lstat(NodePath.join(nested, "HEAD")).catch(() => null)) {
        await rewriteCopiedGitConfig(NodePath.join(nested, "config"), options);
        await rewriteCopiedGitConfig(NodePath.join(nested, "config.worktree"), options);
      }
      if (child.name !== "objects" && child.name !== "refs" && child.name !== "logs")
        await walk(nested, depth + 1);
    }
  };
  await walk(NodePath.join(gitDir, "modules"), 0);
}

/** Git directory parts never carried: hooks run commands on the next Git call. */
export function isUncarriedGitPath(relative: string, isDirectory: boolean): boolean {
  return isDirectory && relative.slice(relative.lastIndexOf("/") + 1) === "hooks";
}
