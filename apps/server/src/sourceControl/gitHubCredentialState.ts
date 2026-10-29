// @effect-diagnostics nodeBuiltinImport:off - gh and git run as child processes of this server.
/**
 * What GitHub access this machine already has, read without touching it: gh's
 * version and logins, token variable names, a token saved in Settings (and
 * whether another machine copied it here), and git's credential helpers by
 * program name. No token value, helper command line or password is read into
 * the result. `inUse` follows GitHubCredentials' order, so it names what
 * SpecWithCode's GitHub features use here.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { GitHubCredentialState, GitHubSettings } from "@specweave-studio/contracts";

import { ghTooOldForJson, type GhResult } from "../fleet/MachineReadiness.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";

export const GITHUB_HOST = "github.com";
const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
/** The variables gh itself uses for github.com. */
const GITHUB_DOT_COM_VARIABLES = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly missing: boolean;
  readonly stderr?: string;
}

export interface GitHubCredentialProbe {
  readonly ghVersion: () => Promise<CommandResult>;
  readonly ghAuthStatus: () => Promise<GhResult>;
  /** `git config --global <args>`; stdout only. */
  readonly gitConfig: (args: ReadonlyArray<string>) => Promise<CommandResult>;
}

/** SHA-256 of a token, which ties a copy note to the token it describes. */
export const tokenFingerprint = (token: string): string =>
  NodeCrypto.createHash("sha256").update(token.trim()).digest("hex");

/** The note for the saved token when it is the one another machine copied here. */
export function copiedNote(settings: GitHubSettings, host = GITHUB_HOST) {
  const saved = settings.tokens[host]?.trim();
  const note = settings.copiedTokens[host];
  return saved && note?.fingerprint === tokenFingerprint(saved) ? note : undefined;
}

/** A helper's program name only: an inline `!f() { ... }` helper may hold a password. */
export function helperName(value: string): string | null {
  const command = value.trim().replace(/^!/u, "").trim();
  const first = command.split(/\s+/u)[0] ?? "";
  if (!first || /[(){};=]/u.test(first)) return command ? "custom command" : null;
  return NodePath.basename(first).slice(0, 255);
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { env: { ...env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "", NO_COLOR: "1" }, timeout: 15_000 },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          code: error ? (typeof code === "number" ? code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr).slice(0, 4000),
          missing: code === "ENOENT",
        });
      },
    );
  });

export function makeNodeGitHubCredentialProbe(env: NodeJS.ProcessEnv): GitHubCredentialProbe {
  return {
    ghVersion: () => run("gh", ["--version"], env),
    ghAuthStatus: () => run("gh", ["auth", "status", "--json", "hosts"], env),
    gitConfig: (args) => run("git", ["config", "--global", ...args], env),
  };
}

export async function readGitHubCredentialState(input: {
  readonly probe: GitHubCredentialProbe;
  readonly env: NodeJS.ProcessEnv;
  readonly settings: GitHubSettings;
}): Promise<GitHubCredentialState> {
  const { probe, env, settings } = input;
  const host = GITHUB_HOST;
  const failed: CommandResult = { code: null, stdout: "", missing: false };
  const [version, status, helpers, gitHubHelpers] = await Promise.all([
    probe.ghVersion().catch(() => failed),
    probe.ghAuthStatus().catch(() => failed),
    probe.gitConfig(["--get-all", "credential.helper"]).catch(() => failed),
    probe
      .gitConfig(["--name-only", "--get-regexp", "^credential\\..*github\\.com.*\\.helper$"])
      .catch(() => failed),
  ]);
  const installed = !version.missing && version.code === 0;
  const parsed = parseGitHubAuthStatus(status.stdout);
  const accounts = parsed.accounts.filter((account) => account.host === host);
  const stored = accounts.filter((account) => account.environmentVariable === null);
  const environmentVariables = TOKEN_VARIABLES.filter((name) => (env[name] ?? "").trim() !== "");
  const savedToken = settings.tokens[host]?.trim() ?? "";
  const note = copiedNote(settings, host);
  const choice = settings.hosts[host];
  const hostEnabled = choice?.enabled !== false;

  const usable = stored.filter((account) => account.authenticated);
  const envLogin =
    accounts.find((account) => account.environmentVariable !== null)?.account ?? null;
  const inUse: GitHubCredentialState["inUse"] = !hostEnabled
    ? null
    : savedToken
      ? { source: note ? "copied" : "saved", login: note?.login ?? null }
      : environmentVariables.some((name) => GITHUB_DOT_COM_VARIABLES.has(name))
        ? { source: "env", login: envLogin }
        : (() => {
            const login =
              (choice?.account !== undefined
                ? usable.find((account) => account.account === choice.account)
                : undefined) ??
              usable.find((account) => account.active) ??
              usable[0];
            return login ? { source: "gh" as const, login: login.account } : null;
          })();

  return {
    host,
    hostEnabled,
    gh: {
      installed,
      version: installed
        ? (/(\d+\.\d+\.\d+)/u.exec(version.stdout)?.[1]?.slice(0, 64) ?? null)
        : null,
      outdated: installed && !parsed.parsed && ghTooOldForJson(status),
    },
    ghAccounts: stored.map((account) => ({
      login: account.account.slice(0, 255),
      active: account.active,
      authenticated: account.authenticated,
    })),
    environmentVariables,
    saved: savedToken
      ? {
          copiedFrom: note?.from.slice(0, 255) ?? null,
          copiedAt: note?.at.slice(0, 64) ?? null,
          login: note?.login?.slice(0, 255) ?? null,
        }
      : null,
    credentialHelpers: [
      ...new Set(
        helpers.stdout
          .split("\n")
          .map(helperName)
          .filter((name): name is string => name !== null),
      ),
    ].slice(0, 16),
    gitHubCredentialHelper: gitHubHelpers.code === 0 && gitHubHelpers.stdout.trim() !== "",
    inUse,
  };
}
