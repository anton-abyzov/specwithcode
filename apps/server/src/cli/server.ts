import { AuthStandardClientScopes } from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { runServer } from "../server.ts";
import { buildPairingUrl } from "../startupAccess.ts";
import {
  type CliServerFlags,
  resolveServerConfig,
  ServerAlreadyRunningError,
  sharedServerCommandFlags,
} from "./config.ts";
import {
  discoverPairTarget,
  makePairServerConfig,
  mintPairingLink,
  resolveDirectPairingBaseUrl,
} from "./pair.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  });

/** What `specwithcode` prints when it opens a server that was already running. */
export const formatOpenedRunningServer = (input: {
  readonly origin: string;
  readonly opened: boolean;
}): string =>
  input.opened
    ? `SpecWithCode is already running on this machine (${input.origin}). Opened it in your browser.`
    : `SpecWithCode is already running on this machine (${input.origin}). Open the SpecWithCode app, or run \`specwithcode pair\` for a sign-in link.`;

/**
 * `specwithcode` on a machine where SpecWithCode already runs (the desktop app,
 * the service or another terminal): open that server rather than failing.
 * Starting a second server on the same state directory stays refused.
 */
const openRunningServer = Effect.fn("cli.openRunningServer")(function* (
  running: ServerAlreadyRunningError,
  flags: CliServerFlags,
) {
  const envNoBrowser = yield* Config.Boolean("STUDIO_NO_BROWSER").pipe(Config.option);
  const noBrowser =
    Option.getOrElse(flags.noBrowser ?? Option.none(), () => false) ||
    Option.getOrElse(envNoBrowser, () => false);
  if (noBrowser) {
    yield* Console.log(formatOpenedRunningServer({ origin: running.origin, opened: false }));
    return;
  }
  const opened = yield* Effect.gen(function* () {
    const target = yield* discoverPairTarget(running.baseDir);
    const config = yield* makePairServerConfig({ target, logLevel: "Warn" });
    const issued = yield* mintPairingLink({
      config,
      scopes: AuthStandardClientScopes,
      ttl: Option.some(Duration.minutes(5)),
      label: Option.some("specwithcode (opened from the terminal)"),
    });
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    yield* launcher.launchBrowser(
      buildPairingUrl(resolveDirectPairingBaseUrl(target.state), issued.credential),
    );
    return true;
  }).pipe(
    Effect.provide(Layer.merge(FetchHttpClient.layer, ExternalLauncher.layer)),
    // A server that is alive but not answering yet, or no browser here: say where it is.
    Effect.catch(() => Effect.succeed(false)),
  );
  yield* Console.log(formatOpenedRunningServer({ origin: running.origin, opened }));
});

const runInteractiveServerCommand = (flags: CliServerFlags) =>
  runServerCommand(flags, { rejectRunningServer: true }).pipe(
    Effect.catchTags({
      ServerAlreadyRunningError: (running) => openRunningServer(running, flags),
    }),
  );

/** Bare words can name existing directories, but must not create typo projects. */
export const runDefaultServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value.trim();
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const explicitPath =
        cwd === "." ||
        cwd === ".." ||
        cwd === "~" ||
        /[/\\]/.test(cwd) ||
        (platform === "win32" && /^[a-z]:/i.test(cwd));
      if (
        !explicitPath &&
        (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")
      ) {
        return yield* new CliError.UserError({
          cause: cwd,
          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "specweave-studio --help" for commands or an explicit path such as "specweave-studio ./my-project" for a new directory.`,
        });
      }
    }
    return yield* runInteractiveServerCommand(flags);
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the SpecWithCode server."),
  Command.withHandler(runInteractiveServerCommand),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the SpecWithCode server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
