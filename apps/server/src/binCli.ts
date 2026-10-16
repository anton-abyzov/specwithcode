import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as NetService from "@specweave-studio/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { acpMcpBridgeCommand, acpMcpCallCommand } from "./cli/acpMcpBridge.ts";
import { authCommand } from "./cli/auth.ts";
import { appCommand } from "./cli/app.ts";
import { browserCommand } from "./cli/browser.ts";
import { connectCommand } from "./cli/connect.ts";
import { dbCommand } from "./cli/db.ts";
import { modsCommand } from "./cli/mods.ts";
import { pairCommand } from "./cli/pair.ts";
import { hasCloudPublicConfig } from "./cloud/publicConfig.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { invokedCliName, type StudioCliName } from "./cli/cliName.ts";
import { projectCommand } from "./cli/project.ts";
import { skillsCommand } from "./cli/skills.ts";
import { runDefaultServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { updateCommand } from "./cli/update.ts";
import { uninstallCommand } from "./cli/uninstall.ts";
import { serviceLauncherCommand } from "./cli/serviceLauncher.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { sshHelperCommand } from "./cli/sshHelper.ts";
import { serviceCommand } from "./cli/service.ts";
import { servicePreflightCommand } from "./cli/servicePreflight.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";
import { triageCommand } from "./cli/triage.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);

const connectPublicConfigMissingMessage =
  "SpecWithCode Connect commands are unavailable: this build is missing SpecWithCode Connect public configuration.";

class ConnectPublicConfigMissingError extends CliError.UserError {
  override get message() {
    return connectPublicConfigMissingMessage;
  }
}

const connectUnavailableCommand = Command.make("connect", {
  command: Argument.String("command").pipe(Argument.variadic),
}).pipe(
  Command.withDescription(
    "SpecWithCode Connect is unavailable in builds without public configuration.",
  ),
  Command.unlisted,
  Command.withHandler(() =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["specweave-studio", "connect"],
        errors: [new ConnectPublicConfigMissingError({ cause: connectPublicConfigMissingMessage })],
      }),
    ),
  ),
);

// Generic over the name so `makeCli()` keeps the literal "specweave-studio" command type.
export const makeCli = <const Name extends StudioCliName = "specweave-studio">({
  cloudEnabled = hasCloudPublicConfig,
  name = "specweave-studio" as Name,
}: { readonly cloudEnabled?: boolean; readonly name?: Name } = {}) =>
  Command.make(name, { ...sharedServerCommandFlags }).pipe(
    Command.withDescription(
      "Run the SpecWithCode server. For bounded Anthropic API workflows, see specweave-studio managed-agents --help (beta).",
    ),
    Command.withHandler(runDefaultServerCommand),
    Command.withSubcommands([
      Command.make("help").pipe(
        Command.withDescription("Show command help."),
        Command.withHandler(() =>
          Effect.fail(new CliError.ShowHelp({ commandPath: [name], errors: [] })),
        ),
      ),
      acpMcpBridgeCommand,
      acpMcpCallCommand,
      startCommand,
      serveCommand,
      appCommand,
      pairCommand,
      authCommand,
      browserCommand,
      projectCommand,
      skillsCommand,
      serviceCommand,
      updateCommand,
      uninstallCommand,
      serviceLauncherCommand,
      claudeHistoryCommand,
      sshHelperCommand,

      servicePreflightCommand,
      themeCommand,
      modsCommand,
      traceCommand,
      triageCommand,
      dbCommand,
      cloudEnabled ? connectCommand : connectUnavailableCommand,
    ]),
  );

export const cli = makeCli();

export function runCli() {
  const name = invokedCliName({ env: process.env.STUDIO_CLI_NAME, argv1: process.argv[1] });
  // Same command tree; only the root name (shown by --version and help) differs.
  Command.run(makeCli({ name }), { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(layerCliRuntime),
    NodeRuntime.runMain,
  );
}
