/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `.claude/skills` in the cwd and every parent up to the repository root
 * (project scope), one directory per skill with a `SKILL.md` carrying YAML
 * frontmatter. The user root wins on name collisions, matching the CLI.
 * Skills in `.claude/skills` folders below the cwd are not scanned: they load
 * only once the agent touches files there and cannot be invoked by name
 * before that (https://code.claude.com/docs/en/skills, "Load skills in
 * monorepos and subdirectories"). `.agents/skills` is a Codex location: verified against the
 * CLI, a skill that lives only there is answered with `Unknown command`, so it
 * is not scanned here.
 * Skills of the Claude Code plugins enabled for the cwd are reported too,
 * under the `<plugin>:<skill>` name the CLI gives them and the `plugin` scope.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { fromLenientJson } from "@specweave-studio/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project" | "plugin";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const frontmatter = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(frontmatter);
  } catch {
    // Claude Code accepts plain scalars containing `: `. Repair only those,
    // leaving comments and YAML structure for the full-document parser.
    const repaired = frontmatter.replace(
      /^([\w-]+:[ \t]*)([^\r\n]*)/gm,
      (line, prefix: string, value: string) => {
        const scalar = value.split(/[ \t]+#/)[0] ?? "";
        if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
          return line;
        }
        return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
      },
    );
    try {
      parsed = parseYamlDocument(repaired);
    } catch {
      return { kind: "malformed" };
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

/** One settings file Claude Code merges, in the precedence order it was read. */
type ClaudeSettingsFile = { readonly path: string; readonly contents: string };

/**
 * Read the settings files in `skillOverrideSettingsPaths` order, lowest
 * precedence first, skipping the ones that do not exist. Both
 * `skillOverrides` and `enabledPlugins` merge across these files.
 */
const readClaudeSettingsFiles = Effect.fn("readClaudeSettingsFiles")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string | undefined,
): Effect.fn.Return<ReadonlyArray<ClaudeSettingsFile>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const files: Array<ClaudeSettingsFile> = [];
  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents !== undefined) {
      files.push({ path: settingsPath, contents });
    }
  }
  return files;
});

const readSkillOverrides = Effect.fn("readSkillOverrides")(function* (
  settingsFiles: ReadonlyArray<ClaudeSettingsFile>,
): Effect.fn.Return<ReadonlyMap<string, SkillOverride>> {
  const overridesByName = new Map<string, SkillOverride>();

  for (const settingsFile of settingsFiles) {
    const parsed = yield* decodeSkillOverrideSettings(settingsFile.contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsFile.path,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides) {
      continue;
    }

    for (const [name, value] of Object.entries(overrides)) {
      overridesByName.set(name, parseSkillOverride(value));
    }
  }

  return overridesByName;
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Project skill folders Claude Code loads for a session started in `cwd`:
 * `.claude/skills` in the cwd and in every parent up to the repository root,
 * or the cwd alone outside a repository. A linked worktree stops at its own
 * root because its `.git` entry is a file there. Documented at
 * https://code.claude.com/docs/en/skills ("Claude Code loads project skills
 * from `.claude/skills/` in the directory where you start it and in every
 * parent directory up to the repository root"). The docs do not rank a parent
 * copy against a deeper one of the same name; the repository root comes first
 * here because for a nested clash the docs give the bare `/name` to the root
 * skill.
 */
export function claudeProjectSkillDirectories(
  path: Path.Path,
  cwd: string,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> {
  const start = path.resolve(cwd);
  const chain = [start];
  if (repositoryRoot !== undefined) {
    let current = start;
    while (current !== repositoryRoot) {
      const parent = path.dirname(current);
      if (parent === current) break;
      chain.push(parent);
      current = parent;
    }
  }
  return chain.toReversed().map((directory) => path.join(directory, ".claude", "skills"));
}

/**
 * The main checkout behind a linked git worktree, or undefined when
 * `repositoryRoot` is a normal checkout. A linked worktree's `.git` is a file
 * pointing at `<main>/.git/worktrees/<name>`, whose `commondir` names the
 * shared `.git` directory.
 */
const findMainCheckout = Effect.fn("findMainCheckout")(function* (
  repositoryRoot: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dotGit = path.join(repositoryRoot, ".git");
  const info = yield* fileSystem.stat(dotGit).pipe(Effect.orElseSucceed(() => undefined));
  if (info?.type !== "File") return undefined;
  const pointer = yield* fileSystem.readFileString(dotGit).pipe(Effect.orElseSucceed(() => ""));
  const gitDirMatch = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!gitDirMatch?.[1]) return undefined;
  const gitDir = path.resolve(repositoryRoot, gitDirMatch[1]);
  const commonDirText = yield* fileSystem
    .readFileString(path.join(gitDir, "commondir"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (commonDirText === undefined) return undefined;
  const commonDir = path.resolve(gitDir, commonDirText.trim());
  if (path.basename(commonDir) !== ".git") return undefined;
  const mainCheckout = path.dirname(commonDir);
  return mainCheckout === path.resolve(repositoryRoot) ? undefined : mainCheckout;
});

/**
 * `claudeProjectSkillDirectories` plus the linked-worktree rule: "when the
 * worktree checkout has no `.claude/skills` directory at its root, Claude
 * Code loads the main checkout's project skills instead"
 * (https://code.claude.com/docs/en/skills, "Load skills in monorepos and
 * subdirectories", Claude Code v2.1.277 or later).
 */
export const resolveClaudeProjectSkillDirectories = Effect.fn(
  "resolveClaudeProjectSkillDirectories",
)(function* (
  cwd: string,
  repositoryRoot: string | undefined,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = claudeProjectSkillDirectories(path, cwd, repositoryRoot);
  if (repositoryRoot === undefined) return directories;
  const rootSkills = path.join(repositoryRoot, ".claude", "skills");
  const rootHasSkills = yield* fileSystem
    .exists(rootSkills)
    .pipe(Effect.orElseSucceed(() => false));
  if (rootHasSkills) return directories;
  const mainCheckout = yield* findMainCheckout(repositoryRoot);
  if (mainCheckout === undefined) return directories;
  const mainSkills = path.join(mainCheckout, ".claude", "skills");
  return directories.map((directory) => (directory === rootSkills ? mainSkills : directory));
});

/**
 * `enabledPlugins` merges key by key across the same settings files as
 * `skillOverrides`, the highest-precedence file that mentions a plugin id
 * deciding it, with managed policy last so its `true` force-enables and its
 * `false` blocks (https://code.claude.com/docs/en/plugins/loading, "Find
 * where a plugin is enabled"). Values other than booleans are ignored.
 */
const PluginEnablementSettings = fromLenientJson(
  Schema.Struct({
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodePluginEnablementSettings = Schema.decodeUnknownEffect(PluginEnablementSettings);

const LenientJsonRecord = fromLenientJson(Schema.Record(Schema.String, Schema.Unknown));
const decodeLenientJsonRecord = Schema.decodeUnknownEffect(LenientJsonRecord);

const readEnabledPlugins = Effect.fn("readEnabledPlugins")(function* (
  settingsFiles: ReadonlyArray<ClaudeSettingsFile>,
): Effect.fn.Return<ReadonlyMap<string, boolean>> {
  const enabledById = new Map<string, boolean>();
  for (const settingsFile of settingsFiles) {
    const parsed = yield* decodePluginEnablementSettings(settingsFile.contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [id, value] of Object.entries(parsed?.enabledPlugins ?? {})) {
      if (typeof value === "boolean") {
        enabledById.set(id.trim(), value);
      }
    }
  }
  return enabledById;
});

/** One install of a plugin, as `installed_plugins.json` records it. */
type ClaudePluginInstall = {
  readonly scope: string;
  readonly installPath: string;
  readonly projectPath?: string;
};

/**
 * Where Claude Code keeps `installed_plugins.json` and the plugin cache:
 * `<config dir>/plugins`, unless `CLAUDE_CODE_PLUGIN_CACHE_DIR` moves it
 * (https://code.claude.com/docs/en/plugins/loading, "Find plugins on disk").
 * The variable is taken verbatim, as `CLAUDE_CONFIG_DIR` is.
 */
export function claudePluginsRootPath(
  path: Path.Path,
  configDirPath: string,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
): string {
  const override = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim() ?? "";
  if (override.length > 0) {
    return cwd ? path.resolve(cwd, override) : path.resolve(override);
  }
  return path.join(configDirPath, "plugins");
}

/**
 * `target` with symlinks resolved, so a workspace reached through a link
 * (macOS `/tmp` is `/private/tmp`) still matches the real path Claude Code
 * records for a project install. Falls back to the lexical path when the
 * folder no longer exists.
 */
const canonicalPath = Effect.fn("canonicalPath")(function* (
  target: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(target);
  return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
});

const readInstalledPlugins = Effect.fn("readInstalledPlugins")(function* (
  pluginsRoot: string,
): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<ClaudePluginInstall>>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(pluginsRoot, "installed_plugins.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  const installsById = new Map<string, ReadonlyArray<ClaudePluginInstall>>();
  if (contents === undefined) return installsById;
  const parsed = yield* decodeLenientJsonRecord(contents).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const plugins = parsed?.plugins;
  if (typeof plugins !== "object" || plugins === null) return installsById;
  for (const [id, rawInstalls] of Object.entries(plugins)) {
    if (!Array.isArray(rawInstalls)) continue;
    const installs: Array<ClaudePluginInstall> = [];
    for (const raw of rawInstalls) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const installPath = typeof record.installPath === "string" ? record.installPath.trim() : "";
      if (!installPath) continue;
      const projectPath = typeof record.projectPath === "string" ? record.projectPath.trim() : "";
      installs.push({
        scope: typeof record.scope === "string" ? record.scope : "user",
        installPath: path.resolve(installPath),
        ...(projectPath ? { projectPath: yield* canonicalPath(projectPath) } : {}),
      });
    }
    if (installs.length > 0) installsById.set(id.trim(), installs);
  }
  return installsById;
});

/**
 * Installs that belong to this workspace, most specific first: a `local` or
 * `project` install recorded for the workspace or its repository root, then
 * the machine-wide `user` and `managed` installs. Project installs recorded
 * for other folders are left out.
 */
function applicablePluginInstalls(
  installs: ReadonlyArray<ClaudePluginInstall>,
  projectRoots: ReadonlyArray<string>,
): ReadonlyArray<ClaudePluginInstall> {
  const rank = (install: ClaudePluginInstall): number | undefined => {
    switch (install.scope) {
      case "local":
      case "project":
        return install.projectPath !== undefined && projectRoots.includes(install.projectPath)
          ? install.scope === "local"
            ? 0
            : 1
          : undefined;
      case "user":
      case "managed":
        return 2;
      default:
        return undefined;
    }
  };
  return installs
    .flatMap((install) => {
      const order = rank(install);
      return order === undefined ? [] : [{ install, order }];
    })
    .toSorted((left, right) => left.order - right.order)
    .map((entry) => entry.install);
}

type ClaudePluginManifest = {
  readonly name?: string;
  readonly skills: ReadonlyArray<string>;
  readonly hasSkillsKey: boolean;
  readonly defaultEnabled?: boolean;
};

const readPluginManifest = Effect.fn("readPluginManifest")(function* (
  pluginRoot: string,
): Effect.fn.Return<ClaudePluginManifest, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fileSystem
    .readFileString(path.join(pluginRoot, ".claude-plugin", "plugin.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  const parsed =
    contents === undefined
      ? undefined
      : yield* decodeLenientJsonRecord(contents).pipe(Effect.orElseSucceed(() => undefined));
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  const rawSkills = parsed?.skills;
  const skills = (Array.isArray(rawSkills) ? rawSkills : [rawSkills]).filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return {
    ...(name ? { name } : {}),
    skills,
    hasSkillsKey: rawSkills !== undefined,
    ...(typeof parsed?.defaultEnabled === "boolean"
      ? { defaultEnabled: parsed.defaultEnabled }
      : {}),
  };
});

/**
 * A manifest `skills` path, resolved inside the plugin root. Claude Code
 * requires `./` (or the bare `.` for the root) and refuses a path that leaves
 * the plugin directory, so those are dropped here too.
 */
function resolvePluginSkillPath(
  path: Path.Path,
  pluginRoot: string,
  entry: string,
): string | undefined {
  const trimmed = entry.trim();
  if (trimmed !== "." && !trimmed.startsWith("./")) return undefined;
  if (trimmed.includes("\\")) return undefined;
  const resolved = path.resolve(pluginRoot, trimmed);
  const relative = path.relative(pluginRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return resolved;
}

/**
 * The `SKILL.md` files a plugin contributes, with the directory name Claude
 * Code falls back to when the frontmatter has no `name`. Plugin skills come
 * from `skills/<name>/SKILL.md` plus every directory the manifest's `skills`
 * key adds; each such directory either holds `<name>/SKILL.md` folders or is
 * one skill folder itself. A plugin with `SKILL.md` at its root, no `skills/`
 * and no `skills` key is a single skill
 * (https://code.claude.com/docs/en/plugins-reference, "Standard layout").
 */
const listPluginSkillFiles = Effect.fn("listPluginSkillFiles")(function* (
  pluginRoot: string,
  manifest: ClaudePluginManifest,
  namespace: string,
): Effect.fn.Return<
  ReadonlyArray<{ readonly skillPath: string; readonly fallbackName: string }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const defaultSkills = path.join(pluginRoot, "skills");
  const defaultSkillsExists = yield* exists(defaultSkills);
  const rootSkill = path.join(pluginRoot, "SKILL.md");
  if (!defaultSkillsExists && !manifest.hasSkillsKey && (yield* exists(rootSkill))) {
    return [{ skillPath: rootSkill, fallbackName: namespace }];
  }

  const directories = [
    defaultSkills,
    ...manifest.skills.flatMap((entry) => {
      const resolved = resolvePluginSkillPath(path, pluginRoot, entry);
      return resolved === undefined ? [] : [resolved];
    }),
  ];
  const files: Array<{ readonly skillPath: string; readonly fallbackName: string }> = [];
  const seen = new Set<string>();
  const add = (skillPath: string, fallbackName: string) => {
    if (seen.has(skillPath)) return;
    seen.add(skillPath);
    files.push({ skillPath, fallbackName });
  };
  for (const directory of new Set(directories)) {
    const ownSkill = path.join(directory, "SKILL.md");
    if (yield* exists(ownSkill)) {
      add(ownSkill, directory === pluginRoot ? namespace : path.basename(directory));
      continue;
    }
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      const skillPath = path.join(directory, entry, "SKILL.md");
      if (yield* exists(skillPath)) add(skillPath, entry);
    }
  }
  return files;
});

/**
 * Skills from the Claude Code plugins enabled for `cwd`, named the way the
 * CLI publishes them: `<plugin>:<skill>`, where `<plugin>` is the manifest
 * `name` (the id before `@` without one) and `<skill>` is the frontmatter
 * `name`, else the skill's directory. A frontmatter name that already carries
 * the plugin prefix is not prefixed again
 * (https://code.claude.com/docs/en/skills, "Where skills live").
 *
 * A plugin loads when the merged `enabledPlugins` says `true` and an install
 * exists on disk, or, without any entry, when it is installed for this
 * workspace (user scope, or a project/local install recorded for this folder)
 * and its manifest does not set `defaultEnabled: false`. The files load from
 * the install's `installPath`, the cached copy Claude Code itself runs.
 *
 * `skillOverrides` is deliberately not applied: "Plugin skills are not
 * affected by `skillOverrides`. Manage those through `/plugin` instead."
 * (https://code.claude.com/docs/en/skills, "Override skill visibility from
 * settings"). Frontmatter `disable-model-invocation` and `user-invocable`
 * still apply. Plugins synced from claude.ai (`<name>@synced`) and
 * session-only `--plugin-dir` plugins have no install record and are not
 * reported.
 */
export const discoverClaudePluginSkills = Effect.fn("discoverClaudePluginSkills")(
  function* (input: {
    readonly pluginsRoot: string;
    readonly settingsFiles: ReadonlyArray<ClaudeSettingsFile>;
    readonly cwd: string | undefined;
    readonly repositoryRoot: string | undefined;
  }): Effect.fn.Return<
    ReadonlyArray<ServerProviderSkill>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const enabledById = yield* readEnabledPlugins(input.settingsFiles);
    const installsById = yield* readInstalledPlugins(input.pluginsRoot);
    const projectRoots: Array<string> = [];
    for (const root of [input.cwd, input.repositoryRoot]) {
      if (root === undefined) continue;
      projectRoots.push(path.resolve(root), yield* canonicalPath(root));
    }

    const skills: Array<ServerProviderSkill> = [];
    const seenNames = new Set<string>();
    const seenNamespaces = new Set<string>();
    for (const id of [...installsById.keys()].sort()) {
      const explicit = enabledById.get(id);
      if (explicit === false) continue;
      const installs = installsById.get(id) ?? [];
      const applicable = applicablePluginInstalls(installs, projectRoots);
      if (explicit === undefined && applicable.length === 0) continue;
      const candidates = explicit === true ? [...applicable, ...installs] : applicable;

      let pluginRoot: string | undefined;
      for (const candidate of candidates) {
        const info = yield* fileSystem
          .stat(candidate.installPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type === "Directory") {
          pluginRoot = candidate.installPath;
          break;
        }
      }
      // An enabled plugin with no cached copy does not load in Claude Code
      // either; it reports `Plugin "<name>" not cached`.
      if (pluginRoot === undefined) continue;

      const manifest = yield* readPluginManifest(pluginRoot);
      if (explicit === undefined && manifest.defaultEnabled === false) continue;
      const atIndex = id.lastIndexOf("@");
      const namespace = manifest.name ?? (atIndex > 0 ? id.slice(0, atIndex) : id);
      if (!namespace || seenNamespaces.has(namespace)) continue;
      seenNamespaces.add(namespace);

      for (const file of yield* listPluginSkillFiles(pluginRoot, manifest, namespace)) {
        const contents = yield* fileSystem
          .readFileString(file.skillPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (contents === undefined) continue;
        const frontmatter = parseSkillFrontmatter(contents);
        if (frontmatter.kind === "malformed") continue;
        const declared = frontmatter.kind === "parsed" ? frontmatter.name : undefined;
        const prefix = `${namespace}:`;
        const leaf = (
          declared?.startsWith(prefix)
            ? declared.slice(prefix.length)
            : (declared ?? file.fallbackName)
        ).trim();
        if (!leaf) continue;
        const name = `${prefix}${leaf}`;
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        skills.push({
          name,
          path: file.skillPath,
          enabled: true,
          scope: "plugin",
          ...(frontmatter.kind === "parsed" && frontmatter.description
            ? { description: frontmatter.description }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true
            ? { userInvocationOnly: true }
            : {}),
          ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
            ? { userInvocable: false }
            : {}),
        });
      }
    }
    return skills;
  },
);

/**
 * Enumerate Claude Code skills from the user config dir and the project
 * `.claude/skills` folders from the cwd up to the repository root. Discovery is best-effort: unreadable roots and malformed
 * skill entries are skipped so a broken skill never degrades the provider
 * snapshot. Roots are listed highest precedence first and the first hit for a
 * name wins, matching Claude Code: verified against the CLI with the same
 * skill name in both scopes, the user copy is the one that runs. Reporting the
 * project copy instead would attach its invocation metadata to a command
 * Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const repositoryRoot = cwd ? yield* findRepositoryRoot(cwd) : undefined;
  const settingsFiles = yield* readClaudeSettingsFiles(
    configDirPath,
    cwd,
    environment ?? process.env,
    repositoryRoot,
  );
  const skillOverrides = yield* readSkillOverrides(settingsFiles);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd
      ? (yield* resolveClaudeProjectSkillDirectories(cwd, repositoryRoot)).map((directory) => ({
          directory,
          scope: "project" as const,
        }))
      : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      // Claude Code identifies a skill by its directory, not by the
      // frontmatter `name`: verified against the CLI, a skill in `probe-alias/`
      // declaring `name: probe-alias-frontmatter` is published as
      // `probe-alias`, and only `skillOverrides["probe-alias"]` switches it
      // off. Keying off the frontmatter name would report a command that does
      // not exist and miss the override that disables it.
      const name = entry.trim();
      if (!name) {
        continue;
      }

      // First root wins, so a later root never displaces a higher-precedence
      // skill of the same name.
      if (skillsByName.has(name)) {
        continue;
      }

      const override = skillOverrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {}),
      });
    }
  }

  const pluginSkills = yield* discoverClaudePluginSkills({
    pluginsRoot: claudePluginsRootPath(path, configDirPath, environment ?? process.env, cwd),
    settingsFiles,
    cwd,
    repositoryRoot,
  });
  for (const skill of pluginSkills) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
