/**
 * `specweave-studio fleet` - add your other machines over Tailscale.
 *
 * `fleet invite` runs on the machine to add: it publishes the running server
 * on that machine's own Tailscale name (Serve, never Funnel) and prints one
 * line holding its address, its environment id and a management token. `fleet
 * add <line>` runs on the primary machine and writes it into
 * `studio-fleet.json` after the address answers as that machine. Running both
 * again moves a machine to a new address and renews its token.
 *
 * Machines reach each other by their own Tailscale names, so none of them
 * depends on another being on the same network.
 */
import { AuthAccessWriteScope, PortSchema } from "@specweave-studio/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { discoverFleet, FleetError, readFleetConfig } from "../studioFleet.ts";
import {
  addFleetMachine,
  encodeFleetJoinCode,
  FleetJoinError,
  removeFleetMachine,
} from "../studioFleetJoin.ts";
import { invokedCliName } from "./cliName.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";
import { discoverPairTarget, makePairServerConfig, resolveTailscalePairingBase } from "./pair.ts";

/** The name the user typed, so printed commands can be pasted as they are. */
const cliName = () => invokedCliName({ env: process.env.STUDIO_CLI_NAME, argv1: process.argv[1] });

/** A year: the primary uses this token for every pairing on the machine, unattended. */
const DEFAULT_INVITE_TTL = Duration.days(365);

export class FleetCommandError extends Schema.TaggedError<FleetCommandError>()(
  "FleetCommandError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fleetFailure = (error: unknown) =>
  new FleetCommandError({
    detail:
      error instanceof FleetJoinError || error instanceof FleetError
        ? error.message
        : "The private machine list could not be changed.",
  });

/**
 * The server home whose `studio-fleet.json` the running server reads: the
 * running server's own, else the explicit or default home.
 */
const resolveFleetBaseDir = (explicit: Option.Option<string>) =>
  discoverPairTarget(Option.getOrUndefined(explicit)).pipe(
    Effect.map((target) => target.baseDir),
    Effect.catchTags({
      NoRunningServerError: () =>
        Effect.gen(function* () {
          const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
          return yield* resolveBaseDir(
            Option.getOrUndefined(Option.orElse(explicit, () => envHome)),
          );
        }),
    }),
  );

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Name shown for this machine on the primary. Defaults to its own name."),
  Flag.optional,
);

const inviteCommand = Command.make("invite", {
  baseDir: baseDirFlag,
  label: labelFlag,
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "How long the primary may use this invitation, for example `90d`. Default 365d.",
    ),
    Flag.optional,
  ),
  tailscaleServePort: Flag.Int("tailscale-serve-port").pipe(
    Flag.withSchema(PortSchema),
    Flag.withDescription("HTTPS port on this machine's Tailscale name. Default 443."),
    Flag.withDefault(DEFAULT_TAILSCALE_SERVE_PORT),
  ),
}).pipe(
  Command.withDescription(
    "On a machine to add: publish this server on its Tailscale name and print a line for `fleet add` on your primary machine.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = Option.getOrElse(yield* GlobalFlag.LogLevel, () => "Warn" as const);
      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));
      const served = yield* resolveTailscalePairingBase({
        target,
        servePort: flags.tailscaleServePort,
      });
      const config = yield* makePairServerConfig({ target, logLevel });
      const issued = yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        return yield* environmentAuth.issueSession({
          scopes: [AuthAccessWriteScope],
          label: "Fleet management (fleet invite)",
          ttl: Option.getOrElse(flags.ttl, () => DEFAULT_INVITE_TTL),
        });
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
      const url = new URL(served.baseUrl).origin;
      const label = Option.getOrElse(flags.label, () => target.descriptor.label)
        .trim()
        .slice(0, 80)
        .trim();
      const code = encodeFleetJoinCode({
        url,
        environmentId: target.descriptor.environmentId,
        label: label || "Machine",
        managementToken: issued.token,
      });
      yield* Console.log(
        [
          `${label || "This machine"} is published at ${url} (private to your tailnet).`,
          "",
          "On your primary machine, run:",
          "",
          `  ${cliName()} fleet add ${code}`,
          "",
          "or paste the line below into Settings > Connections > Add a machine there.",
          "",
          code,
          "",
          `It works until ${DateTime.formatIso(issued.expiresAt)}. Treat it like a password: it lets the primary pair with this machine. Revoke it with \`${cliName()} auth session revoke ${issued.sessionId}\`.`,
          ...served.notes.flatMap((note) => ["", `Note: ${note}`]),
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const addCommand = Command.make("add", {
  baseDir: baseDirFlag,
  label: labelFlag,
  id: Flag.String("id").pipe(
    Flag.withDescription(
      "Short id for a new machine, such as `m1`. Defaults to one made from its name.",
    ),
    Flag.optional,
  ),
  code: Argument.String("invitation").pipe(
    Argument.withDescription("The line `fleet invite` printed on the other machine."),
  ),
}).pipe(
  Command.withDescription(
    "On the primary machine: add the machine an invitation names, or move a configured one to its new address.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      const added = yield* Effect.tryPromise({
        try: () =>
          addFleetMachine({
            baseDir,
            code: flags.code,
            id: Option.getOrUndefined(flags.id),
            label: Option.getOrUndefined(flags.label),
          }),
        catch: fleetFailure,
      });
      yield* Console.log(
        [
          added.change === "added"
            ? `Added ${added.label} as \`${added.id}\` at ${added.url}.`
            : added.previousUrl
              ? `Moved ${added.label} from ${added.previousUrl} to ${added.url}.`
              : `Renewed ${added.label} at ${added.url}.`,
          "",
          added.change === "added"
            ? "Open Settings > Connections: with Connect automatically on, your browser pairs with it within a minute. Choose Allow workers there to let coordinators start work on it."
            : "Browsers add the new address on their own. Workers already allowed there carry over the next time a coordinator uses them.",
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const listCommand = Command.make("list", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("List configured machines and whether this machine reaches them now."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      const config = yield* Effect.tryPromise({
        try: () => readFleetConfig(baseDir),
        catch: fleetFailure,
      });
      if (config === null || config.machines.length === 0) {
        yield* Console.log(
          `No other machines are configured. Run \`${cliName()} fleet invite\` on one, then \`fleet add\` here.\n`,
        );
        return;
      }
      const snapshot = yield* Effect.promise(() => discoverFleet(config, undefined));
      yield* Console.log(
        [
          ...snapshot.machines.map(
            (machine) =>
              `${machine.id}\t${machine.label}\t${machine.url}\t${machine.status}${machine.pairingConfigured ? "" : "\tno management token"}`,
          ),
          "",
        ].join("\n"),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const removeCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  machine: Argument.String("machine").pipe(
    Argument.withDescription("The machine's id or name, as `fleet list` shows it."),
  ),
}).pipe(
  Command.withDescription("Remove a machine from the primary's list."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      const removed = yield* Effect.tryPromise({
        try: () => removeFleetMachine({ baseDir, machine: flags.machine }),
        catch: fleetFailure,
      });
      yield* Console.log(
        `Removed ${removed.label}. Its management token stays valid there until you revoke it on that machine with \`${cliName()} auth session list\` and \`auth session revoke\`.\n`,
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

export const fleetCommand = Command.make("fleet").pipe(
  Command.withDescription(
    "Add your other machines over Tailscale so coordinators here can start work on them.",
  ),
  Command.withSubcommands([inviteCommand, addCommand, listCommand, removeCommand]),
);
