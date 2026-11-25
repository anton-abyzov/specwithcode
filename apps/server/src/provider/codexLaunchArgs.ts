import {
  teamRulesOwnsProviderLaunch,
  type TeamRulesState,
} from "@specweave-studio/shared/teamRules";
import { readMachineTeamRules } from "../teamRules/TeamRules.ts";
import { tokenizeCliArgs } from "@specweave-studio/shared/cliArgs";

const STUDIO_CODEX_LAUNCH_ARGS_ENV = "STUDIO_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
  rules: TeamRulesState = readMachineTeamRules(),
) =>
  // Rules that own the launch leave no back door through the environment.
  (teamRulesOwnsProviderLaunch(rules, "codex")
    ? undefined
    : environment[STUDIO_CODEX_LAUNCH_ARGS_ENV]?.trim()) ||
  launchArgs?.trim() ||
  "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

/**
 * Features text generation keeps off: plugins, apps and connectors start MCP
 * servers that could act on the prompt, and hooks run the user's commands. An
 * explicit `--enable` would beat the trailing `--config` that turns them off.
 */
const TEXT_GENERATION_OFF_FEATURES = new Set([
  "plugins",
  "apps",
  "connectors",
  "hooks",
  "codex_hooks",
]);

/** Trailing overrides that keep {@link TEXT_GENERATION_OFF_FEATURES} off. */
export const CODEX_TEXT_GENERATION_FEATURES_OFF = [...TEXT_GENERATION_OFF_FEATURES].flatMap(
  (feature) => ["--config", `features.${feature}=false`],
);

/** A `--config` value that declares or changes an MCP server. */
const isMcpServerConfig = (value: string): boolean => /^\s*mcp_servers\b/.test(value);

/**
 * `--config` overrides that turn off each named MCP server. Codex merges a
 * whole-table override such as `mcp_servers={}` into the loaded config, so
 * each server is named; a name that is not a bare TOML key is quoted.
 */
export const codexMcpServersOffConfig = (names: ReadonlyArray<string>): Array<string> =>
  names.flatMap((name) => [
    "--config",
    `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`,
  ]);

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      // Text generation never adds MCP servers, whatever the launch args say.
      if (!isMcpServerConfig(arg.slice(arg.indexOf("=") + 1))) execArgs.push(arg);
    } else if (arg === "--strict-config") {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        if (
          !(arg === "--enable" && TEXT_GENERATION_OFF_FEATURES.has(value)) &&
          !((arg === "--config" || arg === "-c") && isMcpServerConfig(value))
        ) {
          execArgs.push(arg, value);
        }
        index++;
      }
    } else if (arg.startsWith("--enable=")) {
      if (!TEXT_GENERATION_OFF_FEATURES.has(arg.slice("--enable=".length))) execArgs.push(arg);
    } else if (arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
