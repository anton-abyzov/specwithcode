import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Copilot sign-ins this machine already has, found without reading any token:
 * VS Code's Copilot extension folders and the host/account lines that plain
 * `gh auth status` prints. Never `--show-token`, never a credential file.
 */
export interface CopilotGhAccount {
  readonly host: string;
  readonly account: string;
}

export interface CopilotExistingSignIns {
  readonly vscodeCopilot: boolean;
  readonly ghAccounts: ReadonlyArray<CopilotGhAccount>;
}

export const NO_COPILOT_EXISTING_SIGN_INS: CopilotExistingSignIns = {
  vscodeCopilot: false,
  ghAccounts: [],
};

/** A folder or `gh` that could not be checked; the finding just leaves it out. */
export class CopilotProbeError extends Data.TaggedError("CopilotProbeError")<{
  readonly cause?: unknown;
}> {}

export interface CopilotExistingSignInsProbe {
  readonly environment: NodeJS.ProcessEnv;
  readonly join: (...segments: ReadonlyArray<string>) => string;
  /** Entry names of a directory; any failure counts as "no entries". */
  readonly readDirectory: (path: string) => Effect.Effect<ReadonlyArray<string>, CopilotProbeError>;
  /** Runs a command without a shell and returns its stdout and stderr text, whatever its exit code. */
  readonly exec: (
    command: string,
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
  ) => Effect.Effect<string, CopilotProbeError>;
}

const MAX_ACCOUNTS = 16;

/** Extension folders of VS Code stable and Insiders for this user. */
export function vscodeExtensionDirectories(
  environment: NodeJS.ProcessEnv,
  join: (...segments: ReadonlyArray<string>) => string,
): ReadonlyArray<string> {
  const directories: string[] = [];
  const custom = environment.VSCODE_EXTENSIONS?.trim();
  if (custom) directories.push(custom);
  const home = (environment.USERPROFILE ?? environment.HOME)?.trim();
  if (home)
    directories.push(
      join(home, ".vscode", "extensions"),
      join(home, ".vscode-insiders", "extensions"),
    );
  return Array.from(new Set(directories));
}

/** `github.copilot-1.2.3` or `github.copilot-chat-0.30.0` (any platform suffix). */
export const isCopilotExtensionFolder = (name: string): boolean =>
  /^github\.copilot(?:-chat)?-\d/iu.test(name);

// oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const LOGGED_IN =
  /Logged in to ([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+) (?:account|as) ([a-z0-9][a-z0-9_-]{0,99})(?=$|[\s(])/iu;

/**
 * Hosts and accounts from `gh auth status` text. Handles the current wording
 * ("Logged in to HOST account NAME (keyring)") and the older one
 * ("Logged in to HOST as NAME (oauth_token)"). Failed sign-ins are skipped.
 */
export function parseGhAuthStatus(text: string): ReadonlyArray<CopilotGhAccount> {
  const accounts: CopilotGhAccount[] = [];
  const seen = new Set<string>();
  for (const line of text.replace(ANSI, "").split(/\r?\n/u)) {
    const match = LOGGED_IN.exec(line);
    if (!match) continue;
    const host = match[1]!.toLowerCase();
    const account = match[2]!;
    const key = `${host}\n${account.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ host, account });
    if (accounts.length >= MAX_ACCOUNTS) break;
  }
  return accounts;
}

/** The enterprise host to sign in against: only when exactly one non-github.com host is signed in. */
export function copilotEnterpriseHost(
  accounts: ReadonlyArray<CopilotGhAccount>,
): string | undefined {
  const hosts = new Set(
    accounts.map((account) => account.host).filter((host) => host !== "github.com"),
  );
  return hosts.size === 1 ? hosts.values().next().value : undefined;
}

/** Never fails: anything it cannot check counts as "not found". */
export const findCopilotExistingSignIns = (
  probe: CopilotExistingSignInsProbe,
): Effect.Effect<CopilotExistingSignIns> =>
  Effect.all(
    [
      Effect.forEach(
        vscodeExtensionDirectories(probe.environment, probe.join),
        (directory) =>
          probe.readDirectory(directory).pipe(
            Effect.map((names) => names.some(isCopilotExtensionFolder)),
            Effect.orElseSucceed(() => false),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((found) => found.some(Boolean))),
      probe
        .exec("gh", ["auth", "status"], {
          ...probe.environment,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        })
        .pipe(
          Effect.timeout("10 seconds"),
          Effect.map(parseGhAuthStatus),
          Effect.orElseSucceed((): ReadonlyArray<CopilotGhAccount> => []),
        ),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.map(([vscodeCopilot, ghAccounts]) => ({ vscodeCopilot, ghAccounts })));
