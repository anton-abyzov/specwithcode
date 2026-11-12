import {
  ClaudeSettings,
  CodexSettings,
  type ExecutionEnvironmentPlatformOs,
  type ServerProvider,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const SAFE_SHELL_BINARY_PATTERN = /^[A-Za-z0-9_./:\\-]+$/;

function quoteProviderBinary(
  binaryPath: string,
  fallback: string,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  if (
    SAFE_SHELL_BINARY_PATTERN.test(binaryPath) &&
    (platform === "windows" || !binaryPath.includes("\\"))
  ) {
    return binaryPath;
  }
  if (platform === "windows") return `& '${binaryPath.replaceAll("'", "''")}'`;
  if (platform === "darwin" || platform === "linux") {
    if (binaryPath.startsWith("~/") || binaryPath.startsWith("~\\")) {
      return `~/'${binaryPath.slice(2).replaceAll("'", `'"'"'`)}'`;
    }
    return `'${binaryPath.replaceAll("'", `'"'"'`)}'`;
  }
  return fallback;
}

export function getOnboardingProviderState(provider: ServerProvider | undefined) {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  if (!provider.installed && provider.status === "warning" && provider.auth.status === "unknown")
    return "checking";
  if (!provider.installed) return "install";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return "attention";
}

/**
 * Official standalone installers. Neither needs Node or npm, and both land in
 * the paths the server's provider maintenance recognizes as native, so the
 * one-click updater in Settings keeps working after install.
 */
const NATIVE_INSTALL_COMMANDS = {
  claudeAgent: {
    windows: "irm https://claude.ai/install.ps1 | iex",
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  codex: {
    windows: "irm https://chatgpt.com/codex/install.ps1 | iex",
    posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  },
} as const;

/**
 * Install command for the setup terminal, keyed on the environment's platform
 * (not the client's): a Windows desktop driving a WSL server gets the shell
 * script. Unknown platforms get the shell script too, since the terminal there
 * is a POSIX shell in practice.
 */
export function resolveOnboardingProviderInstallCommand(
  driver: keyof typeof NATIVE_INSTALL_COMMANDS,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  const commands = NATIVE_INSTALL_COMMANDS[driver];
  return platform === "windows" ? commands.windows : commands.posix;
}

/**
 * Each agent's own sign-in, as typed in a terminal. Pi has no sign-in command:
 * it signs in from inside, with /login. Agents missing here sign in through
 * the app alone.
 */
const SIGN_IN_COMMANDS: Readonly<
  Record<string, { readonly command: string; readonly args: string }>
> = {
  claudeAgent: { command: "claude", args: "auth login" },
  codex: { command: "codex", args: "login" },
  cursor: { command: "cursor-agent", args: "login" },
  grok: { command: "grok", args: "login" },
  muse: { command: "muse", args: "login" },
  opencode: { command: "opencode", args: "auth login" },
  pi: { command: "pi", args: "" },
};

function savedBinaryPath(config: unknown): string | undefined {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return undefined;
  const { binaryPath } = config;
  return typeof binaryPath === "string" && binaryPath.trim().length > 0
    ? binaryPath.trim()
    : undefined;
}

/**
 * The sign-in command of one agent entry, with the command path saved for that
 * entry. Null for an agent that has no sign-in command of its own.
 */
export function resolveAgentSignInCommand(
  provider: Pick<ServerProvider, "driver" | "instanceId">,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string | null {
  if (!Object.hasOwn(SIGN_IN_COMMANDS, provider.driver)) return null;
  const signIn = SIGN_IN_COMMANDS[provider.driver]!;
  const instance = settings.providerInstances[provider.instanceId];
  const older = (settings.providers as Readonly<Record<string, unknown>>)[provider.driver];
  let binaryPath = savedBinaryPath(instance ? instance.config : older) ?? signIn.command;
  if (provider.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance ? (instance.config ?? {}) : older);
    binaryPath = Option.isSome(config) ? config.value.binaryPath : signIn.command;
  } else if (provider.driver === "codex") {
    const config = decodeCodexSettings(instance ? (instance.config ?? {}) : older);
    binaryPath = Option.isSome(config) ? config.value.binaryPath : signIn.command;
  }
  const binary = quoteProviderBinary(binaryPath, signIn.command, platform);
  return signIn.args.length > 0 ? `${binary} ${signIn.args}` : binary;
}

/** Use the selected provider instance's binary when the setup terminal opens its login flow. */
export function resolveOnboardingProviderLoginCommand(
  provider: ServerProvider,
  settings: ServerSettings,
  platform: ExecutionEnvironmentPlatformOs,
): string {
  return resolveAgentSignInCommand(provider, settings, platform) ?? provider.driver;
}

/** One line on what an agent runs on, for its row. */
const AGENT_USES: Readonly<Record<string, string>> = {
  codex: "Uses your ChatGPT plan",
  claudeAgent: "Uses your Claude plan",
  cursor: "Uses your Cursor plan",
  grok: "Uses your Grok account",
  muse: "Uses your Meta account",
  opencode: "Uses the accounts set up in OpenCode",
  pi: "Uses the accounts set up in Pi",
  antigravity: "Uses your Google account",
  gemini: "Uses your Google account",
  "github-copilot-cli": "Uses your GitHub Copilot plan",
};

/** The English phrase; the row translates it. */
export function onboardingAgentUses(agent: string): string {
  return Object.hasOwn(AGENT_USES, agent) ? AGENT_USES[agent]! : "Uses its own sign-in";
}

export function canInstallOnboardingAgent(
  agent: string,
): agent is keyof typeof NATIVE_INSTALL_COMMANDS {
  return Object.hasOwn(NATIVE_INSTALL_COMMANDS, agent);
}

export type OnboardingProviderState = ReturnType<typeof getOnboardingProviderState>;

/** An agent the machine's search found that has no entry that is on. */
export interface FoundOnboardingAgent {
  readonly agent: string;
  readonly kind: "builtIn" | "registry";
  readonly state: "ready" | "signed-out" | "installed";
}

export type OnboardingAgentRow =
  | {
      readonly kind: "agent";
      readonly key: string;
      /** The driver kind. */
      readonly agent: string;
      /** Undefined until the machine has listed it. */
      readonly provider: ServerProvider | undefined;
      readonly state: OnboardingProviderState;
    }
  | ({ readonly kind: "found"; readonly key: string } & Omit<FoundOnboardingAgent, "kind"> & {
        readonly registry: boolean;
      });

export interface OnboardingAgentList {
  readonly rows: ReadonlyArray<OnboardingAgentRow>;
  /** Agents that are not on this machine, by driver kind or registry id. */
  readonly notInstalled: ReadonlyArray<string>;
}

const ROW_ORDER: Readonly<Record<string, number>> = { codex: 0, claudeAgent: 1 };

/**
 * Every agent the Agents step shows for one machine: each entry that is on and
 * installed, each found agent that is not on yet, and the names of the rest.
 * Codex always has a row, because its ChatGPT sign-in needs nothing installed.
 */
export function listOnboardingAgents(input: {
  readonly providers: ReadonlyArray<ServerProvider> | null | undefined;
  readonly found?: ReadonlyArray<FoundOnboardingAgent>;
  /** Agents the search looked for and did not find. */
  readonly notFound?: ReadonlyArray<string>;
}): OnboardingAgentList {
  const providers = input.providers ?? [];
  const rows: OnboardingAgentRow[] = [];
  const missing: string[] = [];
  if (!providers.some((provider) => provider.driver === "codex")) {
    rows.push({
      kind: "agent",
      key: "codex",
      agent: "codex",
      provider: undefined,
      state: "checking",
    });
  }
  for (const provider of providers) {
    const state = getOnboardingProviderState(provider);
    if (provider.driver !== "codex") {
      if (state === "disabled") continue;
      if (state === "install") {
        missing.push(provider.driver);
        continue;
      }
    }
    rows.push({
      kind: "agent",
      key: provider.instanceId,
      agent: provider.driver,
      provider,
      state,
    });
  }
  const listed = new Set(rows.map((row) => row.agent));
  for (const found of input.found ?? []) {
    if (listed.has(found.agent)) continue;
    listed.add(found.agent);
    rows.push({
      kind: "found",
      key: `found:${found.agent}`,
      agent: found.agent,
      registry: found.kind === "registry",
      state: found.state,
    });
  }
  const order = (row: OnboardingAgentRow) =>
    Object.hasOwn(ROW_ORDER, row.agent) ? ROW_ORDER[row.agent]! : 2;
  return {
    // A stable sort: agents after Codex and Claude keep the machine's order.
    rows: rows
      .map((row, index) => ({ row, index }))
      .toSorted((a, b) => order(a.row) - order(b.row) || a.index - b.index)
      .map(({ row }) => row),
    notInstalled: [...new Set([...missing, ...(input.notFound ?? [])])].filter(
      (agent) => !listed.has(agent),
    ),
  };
}
