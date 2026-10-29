/**
 * GitHub access for the processes SpecWithCode starts: agent sessions,
 * terminals and its own git commands. When this machine's chosen GitHub
 * credential is the token saved (or copied) in Settings, each such process gets
 * `GH_TOKEN` and `GITHUB_TOKEN` plus a git credential helper for
 * https://github.com passed through `GIT_CONFIG_*` variables. The
 * helper reads the token from `GH_TOKEN` at run time, so no config value holds
 * it. Nothing is written to global git config, credential stores or gh's
 * hosts.yml, and when gh's own login is the chosen credential nothing is added.
 * Access the user set up for a process wins: a `GH_TOKEN` or `GITHUB_TOKEN`
 * already in its environment (a provider instance's, or one a caller passed)
 * means nothing is added, and a credential helper in its own `GIT_CONFIG_*`
 * entries means no helper is added. The token the server itself started with
 * is not such a choice: the saved or copied token replaces it, as it does for
 * the server's own GitHub API calls.
 *
 * Never log an environment built here.
 */

export const GITHUB_HELPER_KEY = "credential.https://github.com.helper";
/** Answers github.com HTTPS with the token in `GH_TOKEN`; other hosts keep their helpers. */
export const GITHUB_HELPER_VALUE =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';

let spawnToken: string | null = null;

/**
 * A token in `env` that the user chose for this process, not the one inherited
 * from the server's own environment, which a saved or copied token replaces.
 */
const ownToken = (env: NodeJS.ProcessEnv, name: "GH_TOKEN" | "GITHUB_TOKEN") => {
  const value = env[name]?.trim();
  return !!value && value !== process.env[name]?.trim();
};

/** Sets the saved or copied token processes get, or null when gh's own login (or nothing) is chosen. */
export function setGitHubSpawnToken(token: string | null): void {
  const trimmed = token?.trim();
  spawnToken = trimmed ? trimmed : null;
}

/** Whether processes currently get a GitHub token. */
export const hasGitHubSpawnToken = (): boolean => spawnToken !== null;

const configCount = (env: NodeJS.ProcessEnv) => {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const hasGitHubHelper = (env: NodeJS.ProcessEnv, count: number) => {
  for (let index = 0; index < count; index += 1)
    if (
      env[`GIT_CONFIG_KEY_${index}`] === GITHUB_HELPER_KEY &&
      env[`GIT_CONFIG_VALUE_${index}`] === GITHUB_HELPER_VALUE
    )
      return true;
  return false;
};

/** A credential helper the process's own `GIT_CONFIG_*` entries set, which ours would clear. */
const hasOwnCredentialHelper = (env: NodeJS.ProcessEnv, count: number) => {
  for (let index = 0; index < count; index += 1)
    if (/^credential(?:\..+)?\.helper$/i.test(env[`GIT_CONFIG_KEY_${index}`] ?? "")) return true;
  return false;
};

/**
 * `env` plus the GitHub variables for `token`, after any `GIT_CONFIG_*` entries
 * already there, which stay as they are. The empty helper entry first clears
 * helpers for github.com only, so a stale keychain entry cannot answer before the
 * token. A token or helper the user set in `env` wins and is left alone. Applying it
 * twice adds nothing.
 */
export function gitHubSpawnEnvironment(
  env: NodeJS.ProcessEnv,
  token: string | null,
): NodeJS.ProcessEnv {
  if (!token || ownToken(env, "GH_TOKEN") || ownToken(env, "GITHUB_TOKEN")) return env;
  const next: NodeJS.ProcessEnv = { ...env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const count = configCount(env);
  if (hasGitHubHelper(env, count) || hasOwnCredentialHelper(env, count)) return next;
  next.GIT_CONFIG_COUNT = String(count + 2);
  next[`GIT_CONFIG_KEY_${count}`] = GITHUB_HELPER_KEY;
  next[`GIT_CONFIG_VALUE_${count}`] = "";
  next[`GIT_CONFIG_KEY_${count + 1}`] = GITHUB_HELPER_KEY;
  next[`GIT_CONFIG_VALUE_${count + 1}`] = GITHUB_HELPER_VALUE;
  return next;
}

/** `env` with the current GitHub variables, or `env` itself when there are none. */
export const withGitHubSpawnEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  gitHubSpawnEnvironment(env, spawnToken);

/**
 * The variables the GitHub access adds to `env`, for a tool that filters what its
 * commands inherit (Codex's `shell_environment_policy`): the token variables and
 * the whole `GIT_CONFIG_*` list, so the numbering stays complete. Empty without a
 * token, or when `env` already has its own.
 */
export function gitHubSpawnVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  if (spawnToken === null) return {};
  const next = gitHubSpawnEnvironment(env, spawnToken);
  if (next === env) return {};
  const count = configCount(next);
  const names = ["GH_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_COUNT"];
  for (let index = 0; index < count; index += 1)
    names.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = next[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}
