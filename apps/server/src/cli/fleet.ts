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
import { EnvironmentId, PortSchema } from "@specweave-studio/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
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
import { secretsSentTo } from "../fleet/folderTransfer/secretsReport.ts";
import { unlinkPhonesFrom } from "../fleet/phoneLinks.ts";
import { join } from "../nodePath.ts";
import { discoverFleet, FleetError, readFleetConfig } from "../studioFleet.ts";
import {
  addFleetMachine,
  FleetJoinError,
  type FleetRemoveResult,
  removeFleetMachineEverywhere,
  revokeWorkerAccessByLabel,
} from "../studioFleetJoin.ts";
import { invokedCliName } from "./cliName.ts";
import { baseDirFlag, DurationFromString } from "./config.ts";
import { fleetInviteLabel, issueFleetInvitation } from "../studioFleetInvite.ts";
import { discoverPairTarget, makePairServerConfig } from "./pair.ts";

/** The name the user typed, so printed commands can be pasted as they are. */
const cliName = () => invokedCliName({ env: process.env.STUDIO_CLI_NAME, argv1: process.argv[1] });

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
  coordinator: Flag.String("coordinator").pipe(
    Flag.withSchema(EnvironmentId),
    Flag.withDescription("Environment ID of the main machine you approve to manage this machine."),
  ),
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
      const config = yield* makePairServerConfig({ target, logLevel });
      const { invitation, notes } = yield* issueFleetInvitation({
        environmentId: target.descriptor.environmentId,
        coordinatorEnvironmentId: flags.coordinator,
        ownLabel: target.descriptor.label,
        state: target.state,
        servePort: flags.tailscaleServePort,
        label: Option.getOrUndefined(flags.label),
        ttl: Option.getOrUndefined(flags.ttl),
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
      const { code, url } = invitation;
      const label = fleetInviteLabel(Option.getOrUndefined(flags.label), target.descriptor.label);
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
          `It works until ${invitation.expiresAt}. Treat it like a password: it lets the primary pair with this machine. Revoke it with \`${cliName()} auth session revoke ${invitation.sessionId}\`.`,
          ...notes.flatMap((note) => ["", `Note: ${note}`]),
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
          `No other machines are configured. Run \`${cliName()} fleet invite --coordinator '<main-machine-environment-id>'\` on one. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here. Then \`fleet add\` here.\n`,
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
  Command.withDescription(
    "Remove a machine from this one's list and revoke what this machine holds there.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      // Worker grants there are found by this machine's id, known while its server runs.
      const localEnvironmentId = yield* discoverPairTarget(
        Option.getOrUndefined(flags.baseDir),
      ).pipe(
        Effect.map((target) => target.descriptor.environmentId as string),
        Effect.orElseSucceed(() => undefined),
      );
      const removed = yield* Effect.tryPromise({
        try: () =>
          removeFleetMachineEverywhere({
            baseDir,
            machine: flags.machine,
            fetcher: globalThis.fetch,
            revokeWorkerAccess: (target) =>
              revokeWorkerAccessByLabel(globalThis.fetch, target, localEnvironmentId),
            unlinkPhones: (target) =>
              unlinkPhonesFrom({
                stateDir: join(baseDir, "userdata"),
                fetcher: globalThis.fetch,
                target,
                hubEnvironmentId: localEnvironmentId,
              }),
          }),
        catch: fleetFailure,
      });
      yield* Console.log(`${fleetRemoveSummary(removed, cliName())}\n`);
      const sent = yield* Effect.promise(() => secretsSentTo(baseDir, removed.environmentId));
      if (sent.length > 0)
        yield* Console.log(
          [
            `Rotate these secrets if ${removed.label} is no longer trusted. This machine sent them there during a folder copy:`,
            ...sent.map((entry) => `  ${entry.folder}/${entry.path}\t${entry.sentAt}`),
            "",
          ].join("\n"),
        );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

/** What `fleet remove` tells the user, including anything still valid on that machine. */
export function fleetRemoveSummary(removed: FleetRemoveResult, cli: string): string {
  const lines = [`Removed ${removed.label}.`];
  if (removed.workerAccess === "revoked")
    lines.push(`Revoked this machine's worker access on ${removed.label}.`);
  else if (removed.workerAccess === "kept")
    lines.push(
      `Worker access this machine may hold on ${removed.label} could not be revoked from here. On ${removed.label}, revoke it under Settings > Connections > Who can run work on this Mac.`,
    );
  if (removed.managementToken === "revoked")
    lines.push(`Revoked this machine's management token on ${removed.label}.`);
  else if (removed.managementToken === "kept")
    lines.push(
      `Its management token is still valid on ${removed.label}: that machine could not be reached or is too old to revoke it remotely. Revoke it there with \`${cli} auth session revoke ${removed.managementSessionId ?? "<id from auth session list>"}\`.`,
    );
  return lines.join("\n");
}

export const fleetCommand = Command.make("fleet").pipe(
  Command.withDescription(
    "Add your other machines over Tailscale so coordinators here can start work on them.",
  ),
  Command.withSubcommands([inviteCommand, addCommand, listCommand, removeCommand]),
);
