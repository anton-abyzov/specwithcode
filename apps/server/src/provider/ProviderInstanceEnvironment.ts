import type { ProviderInstanceEnvironment } from "@specweave-studio/contracts";
import { setWindowsPath } from "@specweave-studio/shared/shell";

import { expandHomePath } from "../pathExpansion.ts";

// Only Codex/Claude consumer launch boundaries use native sanitization.
// Generic drivers, terminals, installation hooks and explicit API instances
// retain their configured environment through the ordinary merge helper.
const NATIVE_AUTH_ENVIRONMENT_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDECODE",
] as const;
const COPIED_OAUTH_KEYS = new Set([
  "OPENAI_ACCESS_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDECODE",
]);
const EXPLICIT_API_KEYS = new Set<string>(
  NATIVE_AUTH_ENVIRONMENT_KEYS.filter((key) => !COPIED_OAUTH_KEYS.has(key)),
);

export function hasExplicitProviderApiEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  provider?: "codex" | "claudeAgent",
): boolean {
  return (
    environment?.some(
      (variable) =>
        EXPLICIT_API_KEYS.has(variable.name) &&
        (provider === undefined ||
          (provider === "codex"
            ? variable.name.startsWith("OPENAI_")
            : variable.name.startsWith("ANTHROPIC_") ||
              variable.name.startsWith("CLAUDE_CODE_USE_"))) &&
        variable.value.trim().length > 0 &&
        variable.value !== "0" &&
        variable.value !== "false",
    ) ?? false
  );
}

/**
 * Whether a Claude launch environment sends its turns to Anthropic's own API
 * on an API key: a key is set and nothing redirects or replaces it. A router
 * or cloud instance (custom base URL, bearer token, Bedrock, Vertex, Foundry)
 * is billed elsewhere and does not count.
 */
export function isDirectAnthropicApiKeyEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const set = (name: string) => {
    const value = environment[name]?.trim() ?? "";
    return value.length > 0 && value !== "0" && value !== "false";
  };
  return (
    set("ANTHROPIC_API_KEY") &&
    ![
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ].some(set)
  );
}

const HOME_PATH_VARIABLES = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME"]);

/**
 * An instance with its own variables gets a copy of the server's environment,
 * taken once when the instance is made. PATH must not be frozen with it: the
 * server keeps PATH current while it runs (`serverPath.ts`), and an agent
 * installed after the copy would never be found. So the copy reads PATH from
 * the server's environment at each use, until something sets it on the copy.
 */
const pathNameTest = (platform: NodeJS.Platform) => (name: string) =>
  platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH";

/**
 * Makes `next`, a copy of `source` taken once, read PATH from `source` at each
 * use. Call it on any environment that is copied when an instance is made and
 * used to start a program later.
 */
export function followEnvironmentPath(
  next: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  followBasePath(next, source, pathNameTest(platform), platform);
  return next;
}

function followBasePath(
  next: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv,
  isPath: (name: string) => boolean,
  platform: NodeJS.Platform,
): void {
  const key = Object.keys(baseEnv).find(isPath) ?? "PATH";
  Object.defineProperty(next, key, {
    enumerable: true,
    configurable: true,
    get: () => {
      const value = baseEnv[Object.keys(baseEnv).find(isPath) ?? key];
      const mount = appImageMountDir(baseEnv, platform);
      return mount === undefined || value === undefined
        ? value
        : withoutMountEntries(value, /:/, mount);
    },
    set: (value: string | undefined) => {
      Object.defineProperty(next, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      });
    },
  });
}

/**
 * The Linux AppImage build runs the server from a temporary mount and sets
 * APPIMAGE, APPDIR and friends, with mount folders first on PATH and the
 * library and data search paths. An agent that inherits them runs the user's
 * tools against the app's bundled libraries. Agent environments drop the
 * launcher variables and every mount entry; the user's own entries stay.
 */
const APPIMAGE_LAUNCHER_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// The dynamic loader also splits LD_LIBRARY_PATH on semicolons.
const APPIMAGE_SEARCH_PATH_SEPARATORS: Record<string, RegExp> = {
  PATH: /:/,
  LD_LIBRARY_PATH: /[:;]/,
  XDG_DATA_DIRS: /:/,
  GSETTINGS_SCHEMA_DIR: /:/,
};

// APPDIR alone is a common variable of other tools; only the Linux AppImage
// runtime sets APPIMAGE, so that is the signal.
const isAppImageEnvironment = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean =>
  platform === "linux" && Boolean(env.APPIMAGE);

function appImageMountDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (!isAppImageEnvironment(env, platform)) return undefined;
  const mount = env.APPDIR?.replace(/\/+$/, "");
  return mount ? mount : undefined;
}

/** `value` without entries inside `mount`; undefined when nothing else was in it. */
function withoutMountEntries(value: string, separator: RegExp, mount: string): string | undefined {
  const entries = value.split(separator);
  const kept = entries.filter((entry) => entry !== mount && !entry.startsWith(`${mount}/`));
  if (kept.length === entries.length) return value;
  if (kept.length === 0) return undefined;
  // An empty entry means the current folder; alone it must stay ":", since "" means none.
  return kept.length === 1 && kept[0] === "" ? ":" : kept.join(":");
}

/** A copy of `env` without the AppImage launcher variables and mount entries. */
export function withoutAppImageRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!isAppImageEnvironment(env, platform)) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_LAUNCHER_KEYS) delete next[key];
  const mount = appImageMountDir(env, platform);
  if (mount === undefined) return next;
  for (const [key, separator] of Object.entries(APPIMAGE_SEARCH_PATH_SEPARATORS)) {
    const value = next[key];
    if (value === undefined) continue;
    const kept = withoutMountEntries(value, separator, mount);
    if (kept === undefined) delete next[key];
    else next[key] = kept;
  }
  return next;
}

/**
 * A thread's MCP credentials and identity belong to the session that set
 * them. The server's own environment can carry another thread's (a server
 * started from an agent shell), so an inherited layer drops them in any case.
 */
export const isThreadScopedVariable = (name: string): boolean => {
  const upper = name.toUpperCase();
  return upper.startsWith("STUDIO_ACP_MCP_") || upper === "SPECWEAVE_STUDIO_THREAD_ID";
};

/**
 * The server's environment as an agent may inherit it: no AppImage runtime
 * and no thread-scoped credentials. The same object when nothing is dropped.
 */
export function inheritableAgentEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const scrubbed = withoutAppImageRuntimeEnvironment(env, platform);
  const threadScoped = Object.keys(scrubbed).filter(isThreadScopedVariable);
  if (threadScoped.length === 0) return scrubbed;
  const next: NodeJS.ProcessEnv = { ...scrubbed };
  for (const key of threadScoped) delete next[key];
  return next;
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const inheritable = inheritableAgentEnvironment(baseEnv, platform);
  if ((!environment || environment.length === 0) && inheritable === baseEnv) return baseEnv;
  const next: NodeJS.ProcessEnv = inheritable === baseEnv ? { ...baseEnv } : inheritable;
  const isPath = pathNameTest(platform);
  if (!environment?.some((variable) => isPath(variable.name)))
    followBasePath(next, baseEnv, isPath, platform);
  for (const variable of environment ?? []) {
    if (platform === "win32" && variable.name.toUpperCase() === "PATH") {
      setWindowsPath(next, variable.value);
      continue;
    }
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] = HOME_PATH_VARIABLES.has(variable.name)
      ? expandHomePath(variable.value)
      : variable.value;
  }
  return next;
}

/** Empty overrides prevent extendEnv:true from restoring parent API credentials. */
export function mergeNativeSubscriptionEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  provider?: "codex" | "claudeAgent",
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (hasExplicitProviderApiEnvironment(environment, provider))
    return mergeProviderInstanceEnvironment(environment, baseEnv, platform);
  const next = { ...mergeProviderInstanceEnvironment(environment, baseEnv, platform) };
  // This second copy would freeze PATH as the first would have (see `followBasePath`).
  const isPath = pathNameTest(platform);
  if (!environment?.some((variable) => isPath(variable.name)))
    followBasePath(next, baseEnv, isPath, platform);
  for (const key of NATIVE_AUTH_ENVIRONMENT_KEYS) next[key] = "";
  return next;
}
