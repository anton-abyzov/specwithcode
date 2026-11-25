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

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        if (!(arg === "--enable" && TEXT_GENERATION_OFF_FEATURES.has(value))) {
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
