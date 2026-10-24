// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect FileSystem has no native realpath (the on-disk spelling) and no bigint stat (file identity).
import * as NodeFSP from "node:fs/promises";

import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as ServerConfig from "../config.ts";
import { FLEET_CONFIG_FILE } from "../studioFleet.ts";

/**
 * Server files the agents the app launches must never open through the paths
 * this module guards. They run as the same OS user, so file modes do not keep
 * them out. A folder covers everything inside it; a file covers that exact file.
 *
 * Covered: Claude Code's own file tools (deny rules), ACP client file requests,
 * the `preview_upload` MCP tool and local-image inlining in `html_preview` /
 * `html_render`. Not covered: shell commands (Claude's Bash rules only catch a
 * command that spells a path out; Claude's sandbox, when the user enables it,
 * is what stops the rest), Codex turns, and work delegated to other providers
 * (`studio_thread_launch`, `create_threads`) or run as commands the server
 * executes (scheduler checks, MCP-launched commands).
 *
 * Only credential stores are listed. The rest of the data home (logs,
 * settings, attachments, browser artifacts and downloads) stays readable
 * because agents legitimately triage and attach from it. That includes
 * `<stateDir>/settings.json`, which still holds the Antigravity `apiKey` and
 * the OpenCode `serverPassword` in plain text: they are redacted for clients
 * only, and moving them out is a data migration that needs the owner's OK.
 */
/** The path operations used here; Effect's Path and `node:path` both fit. */
export type AgentPathOps = Pick<
  Path.Path,
  "basename" | "dirname" | "isAbsolute" | "join" | "relative" | "resolve"
>;

export interface AgentProtectedPaths {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

/** The credential stores of this server, from its real configured paths. */
export function agentProtectedPathsForConfig(
  config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "stateDir" | "secretsDir">,
  path: AgentPathOps,
): AgentProtectedPaths {
  return {
    directories: [
      // BYO provider keys, Codex/GitHub tokens, the signing key, fleet grants,
      // cloud and MCP credentials.
      config.secretsDir,
      // Cookies and saved sign-ins of the server-side browser.
      path.join(config.stateDir, "server-browser", "profiles"),
      // Per-instance Antigravity GEMINI_HOME folders with Google OAuth tokens
      // (antigravityAuthSupport.ts).
      path.join(config.stateDir, "providers", "antigravity"),
    ],
    // Management tokens for the owner's other machines.
    files: [path.join(config.baseDir, FLEET_CONFIG_FILE)],
  };
}

const MAX_LINK_HOPS = 40;

/**
 * The on-disk spelling of an existing path (realpath(3)). On a case-insensitive
 * volume `SECRETS` or `ſecrets` (U+017F, which APFS folds to `s`) comes back as
 * the stored `secrets`, which a string comparison alone would miss.
 */
const nativeRealPath = (target: string) =>
  Effect.tryPromise(() => NodeFSP.realpath(target)).pipe(Effect.option);

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly directory: boolean;
}

/** Which file a path names (links followed), whatever it is spelled or linked as. */
const identityOf = (target: string) =>
  Effect.tryPromise(() => NodeFSP.stat(target, { bigint: true })).pipe(
    Effect.map((info): FileIdentity => ({
      dev: info.dev,
      ino: info.ino,
      directory: info.isDirectory(),
    })),
    Effect.option,
    Effect.map((identity) =>
      identity._tag === "Some" && identity.value.ino !== 0n ? identity.value : undefined,
    ),
  );

const sameFile = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;

/**
 * Where a path really lands: symlinks resolved, including a dangling final
 * link and missing trailing components (a file about to be written).
 */
export const resolveAgentPath = Effect.fn("AgentProtectedPaths.resolve")(function* (
  fileSystem: FileSystem.FileSystem,
  path: AgentPathOps,
  target: string,
) {
  let current = path.resolve(target);
  const missing: Array<string> = [];
  let linkHops = 0;
  while (true) {
    const real = yield* nativeRealPath(current);
    if (real._tag === "Some") return path.join(real.value, ...missing);
    const link = yield* fileSystem.readLink(current).pipe(Effect.option);
    if (link._tag === "Some" && linkHops < MAX_LINK_HOPS) {
      // A dangling link: follow it to where a write would land.
      linkHops++;
      current = path.resolve(path.dirname(current), link.value);
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(current, ...missing);
});

/** Each protected entry as configured and as it really resolves, without duplicates. */
export const expandAgentProtectedPaths = Effect.fn("AgentProtectedPaths.expand")(function* (
  fileSystem: FileSystem.FileSystem,
  path: AgentPathOps,
  paths: AgentProtectedPaths,
) {
  const expand = (entries: ReadonlyArray<string>) =>
    Effect.forEach(entries, (entry) =>
      resolveAgentPath(fileSystem, path, entry).pipe(
        Effect.map((real) => [path.resolve(entry), real]),
      ),
    ).pipe(Effect.map((pairs) => [...new Set(pairs.flat())]));
  return {
    directories: yield* expand(paths.directories),
    files: yield* expand(paths.files),
  } satisfies AgentProtectedPaths;
});

function isInside(
  path: AgentPathOps,
  fold: (value: string) => string,
  root: string,
  candidate: string,
): boolean {
  const relative = path.relative(fold(root), fold(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Checks agent-supplied host paths against the protected entries. */
export interface AgentPathGuard {
  /**
   * Whether a path is, or resolves through links to, a protected entry, or is
   * the same file as one (a hard link, or a spelling the volume folds).
   * A relative path is resolved against `cwd` when given, else the process folder.
   */
  readonly isProtected: (target: string, cwd?: string | null) => Effect.Effect<boolean>;
  /** The first of `targets` that is protected or contains a protected entry. */
  readonly firstExposing: (targets: ReadonlyArray<string>) => Effect.Effect<string | undefined>;
}

/**
 * One guard per adapter or service: the link-resolved entries are expanded
 * once, on first use. Protected identities are re-read on every check (a few
 * stat calls), so a folder created or replaced later is still recognised.
 */
export function makeAgentPathGuard(
  fileSystem: FileSystem.FileSystem,
  path: AgentPathOps,
  paths: AgentProtectedPaths,
): AgentPathGuard {
  let expandedCache: AgentProtectedPaths | undefined;
  const expanded = Effect.suspend(() =>
    expandedCache === undefined
      ? expandAgentProtectedPaths(fileSystem, path, paths).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              expandedCache = value;
            }),
          ),
        )
      : Effect.succeed(expandedCache),
  );
  // macOS and Windows volumes are case-insensitive by default. Lower case is
  // only the fast path; file identity below is the authoritative check.
  const folder = Effect.map(
    HostProcessPlatform,
    (platform) => (value: string) =>
      platform === "darwin" || platform === "win32" ? value.toLowerCase() : value,
  );
  const identities = (entries: ReadonlyArray<string>) =>
    Effect.forEach(entries, identityOf).pipe(
      Effect.map((found) => found.filter((identity) => identity !== undefined)),
    );
  /** `target` and each existing folder above it, as file identities. */
  const lineage = Effect.fnUntraced(function* (target: string) {
    const found: Array<{ readonly identity: FileIdentity; readonly self: boolean }> = [];
    let current = path.resolve(target);
    while (true) {
      const identity = yield* identityOf(current);
      if (identity !== undefined) found.push({ identity, self: current === path.resolve(target) });
      const parent = path.dirname(current);
      if (parent === current) return found;
      current = parent;
    }
  });
  const candidatesFor = Effect.fnUntraced(function* (target: string, cwd?: string | null) {
    // A relative path means the request's folder when it names one, and the
    // process folder only when it does not.
    const spelling =
      cwd === undefined || cwd === null ? path.resolve(target) : path.resolve(cwd, target);
    return new Set([spelling, yield* resolveAgentPath(fileSystem, path, spelling)]);
  });

  const isProtected = Effect.fn("AgentProtectedPaths.isProtected")(function* (
    target: string,
    cwd?: string | null,
  ) {
    const fold = yield* folder;
    const entries = yield* expanded;
    const candidates = yield* candidatesFor(target, cwd);
    for (const candidate of candidates) {
      if (entries.directories.some((root) => isInside(path, fold, root, candidate))) return true;
      if (entries.files.some((file) => fold(file) === fold(candidate))) return true;
    }
    const protectedDirectories = yield* identities(paths.directories);
    const protectedFiles = yield* identities(paths.files);
    for (const candidate of candidates) {
      for (const { identity, self } of yield* lineage(candidate)) {
        if (protectedDirectories.some((entry) => sameFile(entry, identity))) return true;
        if (self && protectedFiles.some((entry) => sameFile(entry, identity))) return true;
      }
    }
    return false;
  });

  /** Whether a folder holds a protected entry, so uploading it whole would expose one. */
  const containsProtected = Effect.fnUntraced(function* (target: string) {
    const fold = yield* folder;
    const entries = yield* expanded;
    const candidates = yield* candidatesFor(target);
    const all = [...entries.directories, ...entries.files];
    for (const candidate of candidates) {
      if (all.some((entry) => isInside(path, fold, candidate, entry))) return true;
    }
    const targetIdentities = yield* identities([...candidates]);
    if (targetIdentities.length === 0) return false;
    for (const entry of [...paths.directories, ...paths.files]) {
      for (const { identity } of yield* lineage(entry)) {
        if (targetIdentities.some((candidate) => sameFile(candidate, identity))) return true;
      }
    }
    return false;
  });

  const firstExposing = Effect.fn("AgentProtectedPaths.firstExposing")(function* (
    targets: ReadonlyArray<string>,
  ) {
    for (const target of targets) {
      if ((yield* isProtected(target)) || (yield* containsProtected(target))) return target;
    }
    return undefined;
  });

  return { isProtected, firstExposing };
}

/** A one-off check; services keep a guard from {@link makeAgentPathGuard} instead. */
export const isAgentProtectedPath = (
  fileSystem: FileSystem.FileSystem,
  path: AgentPathOps,
  paths: AgentProtectedPaths,
  target: string,
  cwd?: string | null,
) => makeAgentPathGuard(fileSystem, path, paths).isProtected(target, cwd);

/** Claude rule paths: `//` marks an absolute path; Windows drives become `//c/...`. */
export function claudeRulePath(absolutePath: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(absolutePath);
  if (drive !== null) {
    return `//${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`;
  }
  return `/${absolutePath}`;
}

/** The ways a shell command can spell a path under the home folder. */
function shellSpellings(path: AgentPathOps, absolutePath: string, homeDir: string | undefined) {
  const spellings = [absolutePath];
  if (homeDir !== undefined && homeDir.length > 0) {
    const relative = path.relative(homeDir, absolutePath);
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      // `~` and `$HOME` are POSIX shell spellings (Git Bash on Windows), so
      // the rest of the path is written with `/` there too.
      const shellRelative = relative.replaceAll("\\", "/");
      spellings.push(`~/${shellRelative}`, `$HOME/${shellRelative}`, `\${HOME}/${shellRelative}`);
    }
  }
  return spellings;
}

/**
 * Deny rules for Claude Code. Read rules cover the built-in readers (also
 * Grep and Glob); Edit rules cover every file-editing tool, Write included,
 * and Claude Code warns on a Write(path) rule. Bash rules only refuse a
 * command that spells a protected path out; `cd` into the data home and a
 * relative path, globs (`secret?/`) or quoting (`"$HOME"/…`) get past them.
 * Only Claude's sandbox, when the user enables it, stops those.
 */
export function claudeAgentSecretDenyRules(
  path: AgentPathOps,
  paths: AgentProtectedPaths,
  homeDir: string | undefined,
): ReadonlyArray<string> {
  const rules: Array<string> = [];
  for (const directory of paths.directories) {
    const rulePath = claudeRulePath(directory);
    rules.push(`Read(${rulePath})`, `Read(${rulePath}/**)`, `Edit(${rulePath}/**)`);
  }
  for (const file of paths.files) {
    const rulePath = claudeRulePath(file);
    rules.push(`Read(${rulePath})`, `Edit(${rulePath})`);
  }
  // Bash rules match command text. A folder is matched as the folder itself
  // at the end of the text or followed by `/`, so a sibling such as
  // `secrets-backup` is not refused; a file is matched as a substring, so
  // `studio-fleet.json.bak` is refused too.
  for (const directory of paths.directories) {
    for (const spelling of shellSpellings(path, directory, homeDir)) {
      rules.push(`Bash(*${spelling}/*)`, `Bash(*${spelling})`);
      if (spelling.includes("\\")) rules.push(`Bash(*${spelling}\\*)`);
    }
  }
  for (const file of paths.files) {
    for (const spelling of shellSpellings(path, file, homeDir)) {
      rules.push(`Bash(*${spelling}*)`);
    }
  }
  return [...new Set(rules)];
}

const union = (existing: ReadonlyArray<string> | undefined, added: ReadonlyArray<string>) => [
  ...new Set([...(existing ?? []), ...added]),
];

/** What Claude Code is told to refuse, computed once per adapter. */
export interface ClaudeAgentSecretDeny {
  readonly rules: ReadonlyArray<string>;
  readonly sandboxPaths: ReadonlyArray<string>;
}

export function makeClaudeAgentSecretDeny(
  path: AgentPathOps,
  paths: AgentProtectedPaths,
  homeDir: string | undefined,
): ClaudeAgentSecretDeny {
  return {
    rules: claudeAgentSecretDenyRules(path, paths, homeDir),
    sandboxPaths: [...new Set([...paths.directories, ...paths.files])],
  };
}

/**
 * Adds the deny rules to the settings Claude Code receives as `--settings`.
 * Existing rules and sandbox paths are kept; user, project and local settings
 * files are separate sources Claude Code merges itself, so they are untouched.
 * The sandbox paths take effect only when the user has Claude's sandbox on.
 */
export function withClaudeAgentSecretDenySettings(
  settings: ClaudeSdkSettings,
  deny: ClaudeAgentSecretDeny,
): ClaudeSdkSettings {
  const permissions = settings.permissions ?? {};
  const sandbox = settings.sandbox ?? {};
  const filesystem = sandbox.filesystem ?? {};
  return {
    ...settings,
    permissions: { ...permissions, deny: union(permissions.deny, deny.rules) },
    sandbox: {
      ...sandbox,
      filesystem: {
        ...filesystem,
        denyRead: union(filesystem.denyRead, deny.sandboxPaths),
        denyWrite: union(filesystem.denyWrite, deny.sandboxPaths),
      },
    },
  };
}

/** The Claude deny settings for this server's real (and link-resolved) credential paths. */
export const claudeAgentSecretDenyForConfig = Effect.fn("AgentProtectedPaths.claudeDeny")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: AgentPathOps;
    readonly config: Pick<
      ServerConfig.ServerConfig["Service"],
      "baseDir" | "stateDir" | "secretsDir"
    >;
    readonly homeDir: string | undefined;
  }) {
    const paths = yield* expandAgentProtectedPaths(
      input.fileSystem,
      input.path,
      agentProtectedPathsForConfig(input.config, input.path),
    );
    return makeClaudeAgentSecretDeny(input.path, paths, input.homeDir);
  },
);
