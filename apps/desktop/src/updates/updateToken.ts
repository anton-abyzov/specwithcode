import { execFile } from "node:child_process";

/**
 * The GitHub token update checks use for Studio's private releases. Studio
 * never stores one: it reads `STUDIO_UPDATE_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`,
 * or asks the `gh` CLI the owner already signed in with. The value lives in
 * memory for a few minutes and is sent only to the GitHub API.
 */

const TOKEN_CACHE_MS = 10 * 60 * 1000;
// Finder-launched apps get a minimal PATH, so look where Homebrew puts gh.
const GH_CANDIDATES = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"];

export type RunGhAuthToken = (command: string) => Promise<string | null>;

const runGhAuthToken: RunGhAuthToken = (command) =>
  new Promise((resolve) => {
    execFile(
      command,
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 10_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const token = String(stdout).trim();
        resolve(/^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null);
      },
    );
  });

export function readEnvironmentUpdateToken(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["STUDIO_UPDATE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export function makeUpdateTokenResolver(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly runGh?: RunGhAuthToken;
    readonly now?: () => number;
  } = {},
) {
  const env = options.env ?? process.env;
  const runGh = options.runGh ?? runGhAuthToken;
  const now = options.now ?? Date.now;
  let cached: { readonly token: string | null; readonly at: number } | null = null;

  return {
    resolve: async (): Promise<string | null> => {
      const fromEnv = readEnvironmentUpdateToken(env);
      if (fromEnv) return fromEnv;
      if (cached && now() - cached.at < TOKEN_CACHE_MS) return cached.token;
      let token: string | null = null;
      for (const candidate of GH_CANDIDATES) {
        token = await runGh(candidate);
        if (token) break;
      }
      cached = { token, at: now() };
      return token;
    },
    /** Forget the cached value, for example after GitHub rejects it. */
    invalidate: () => {
      cached = null;
    },
  };
}

export const updateTokenResolver = makeUpdateTokenResolver();
