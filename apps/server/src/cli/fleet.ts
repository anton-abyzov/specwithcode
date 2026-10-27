/**
 * `specweave-studio fleet` - add your other machines over Tailscale or
 * SpecWithCode Connect.
 *
 * `fleet invite` runs on the machine to add: it publishes the running server
 * on that machine's own Tailscale name (Serve, never Funnel) and/or names its
 * SpecWithCode Connect address, and prints one line for the primary. A
 * Tailscale-only line holds a management token; a line with a Connect address
 * holds a one-time credential the primary redeems for a token bound to its
 * own fleet key. `fleet add <line>` runs on the primary machine and writes it
 * into `studio-fleet.json` after the address answers as that machine. Running
 * both again moves a machine to a new address and renews its token.
 *
 * Machines reach each other by their own addresses, so none of them depends
 * on another being on the same network.
 */
import { EnvironmentId, PortSchema } from "@specweave-studio/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@specweave-studio/tailscale";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { secretsSentTo } from "../fleet/folderTransfer/secretsReport.ts";
import { unlinkPhonesFrom } from "../fleet/phoneLinks.ts";
import { join } from "../nodePath.ts";
import { makeFleetLink } from "../fleet/fleetTransport.ts";
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
import { type FleetInviteVia, fleetInviteLabel } from "../studioFleetInvite.ts";
import {
  bearerHeaders,
  liveServiceClient,
  liveServiceRequestError,
  type LiveServiceConfig,
  liveServiceEndpoint,
  LiveServiceUnsupportedError,
} from "./liveService.ts";
import { type DiscoveredPairTarget, discoverPairTarget, makePairServerConfig } from "./pair.ts";

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

/**
 * Makes the invitation in the running service, as Settings > Connections >
 * Invite this machine does (`POST /api/studio/fleet/invite`), with the
 * credential the service published for this machine's CLI. The live database
 * is never opened here: the management session is issued by the service.
 */
export const inviteThroughRunningService = Effect.fn("cli.fleet.invite")(function* (input: {
  readonly config: LiveServiceConfig;
  readonly target: Pick<DiscoveredPairTarget, "state">;
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly label: string | undefined;
  readonly ttl: Duration.Duration | undefined;
  readonly servePort: number;
  readonly via?: FleetInviteVia | undefined;
}) {
  if (input.servePort !== DEFAULT_TAILSCALE_SERVE_PORT) {
    return yield* new LiveServiceUnsupportedError({
      reason: `The running SpecWithCode publishes invitations on the Tailscale HTTPS port it was started with; --tailscale-serve-port ${input.servePort} cannot be chosen here. Start it with that port (serve --tailscale-serve-port), or leave the option out.`,
    });
  }
  // The service issues invitations in whole days; a TTL that is not one is refused, not rounded.
  const millis = input.ttl === undefined ? undefined : Duration.toMillis(input.ttl);
  const days = millis === undefined ? undefined : millis / 86_400_000;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
    return yield* new LiveServiceUnsupportedError({
      reason: `--ttl must be a whole number of days from 1 to 365; it was ${Duration.format(input.ttl ?? Duration.zero)}.`,
    });
  }
  const { origin, token } = yield* liveServiceEndpoint(input.config, input.target.state);
  return yield* Effect.gen(function* () {
    const client = yield* liveServiceClient(origin);
    return yield* client.studioFleet.inviteFleetMachine({
      headers: bearerHeaders(token),
      payload: {
        coordinatorEnvironmentId: input.coordinatorEnvironmentId,
        ...(input.label === undefined ? {} : { label: input.label.slice(0, 80) }),
        ...(days === undefined ? {} : { days }),
        ...(input.via === undefined ? {} : { via: input.via }),
      },
    });
  }).pipe(Effect.mapError(liveServiceRequestError(origin, "make the invitation")));
});

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
  via: Flag.Literals("via", ["auto", "tailscale", "connect"]).pipe(
    Flag.withDescription(
      "Which address the line carries: `tailscale`, `connect` (SpecWithCode Connect), or `auto` (both when both work). Default auto.",
    ),
    Flag.withDefault("auto" as const),
  ),
}).pipe(
  Command.withDescription(
    "On a machine to add: publish this server on its Tailscale name or SpecWithCode Connect address and print a line for `fleet add` on your primary machine.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = Option.getOrElse(yield* GlobalFlag.LogLevel, () => "Warn" as const);
      const target = yield* discoverPairTarget(Option.getOrUndefined(flags.baseDir));
      const config = yield* makePairServerConfig({ target, logLevel });
      const invitation = yield* inviteThroughRunningService({
        config,
        target,
        coordinatorEnvironmentId: flags.coordinator,
        label: Option.getOrUndefined(flags.label),
        ttl: Option.getOrUndefined(flags.ttl),
        servePort: flags.tailscaleServePort,
        via: flags.via,
      });
      const descriptor = target.descriptor;
      const { code, url } = invitation;
      const label = fleetInviteLabel(Option.getOrUndefined(flags.label), descriptor.label);
      const where = invitation.connectUrl
        ? `${url} (private to your tailnet) and ${invitation.connectUrl} (SpecWithCode Connect)`
        : invitation.sessionId
          ? `${url} (private to your tailnet)`
          : `${url} (SpecWithCode Connect)`;
      const revoke = invitation.sessionId
        ? `Revoke it with \`${cliName()} auth session revoke ${invitation.sessionId}\`.`
        : `Use it within an hour, by ${invitation.redeemBy ?? "then"}; it works once, and anyone who sees it first can use it from the internet. Revoke it unused with \`${cliName()} auth pairing revoke ${invitation.pairingId ?? "<id>"}\`.`;
      // A v2 line (no session id) needs a main machine from this release on.
      const compatibility = invitation.sessionId
        ? []
        : [
            "",
            `Note: a main machine on an older SpecWithCode does not accept this line. Update it, or run \`${cliName()} fleet invite --via tailscale\` for a Tailscale-only line.`,
          ];
      yield* Console.log(
        [
          `${label || "This machine"} is published at ${where}.`,
          "",
          "On your primary machine, run:",
          "",
          `  ${cliName()} fleet add ${code}`,
          "",
          "or paste the line below into Settings > Connections > Add a machine there.",
          "",
          code,
          "",
          `It works until ${invitation.expiresAt}. Treat it like a password: it lets the primary pair with this machine. ${revoke}`,
          ...compatibility,
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
      // A line with a SpecWithCode Connect address is redeemed for this machine's id.
      const localEnvironmentId = yield* discoverPairTarget(
        Option.getOrUndefined(flags.baseDir),
      ).pipe(
        Effect.map((target) => target.descriptor.environmentId as string),
        Effect.orElseSucceed(() => undefined),
      );
      const added = yield* Effect.tryPromise({
        try: () =>
          addFleetMachine({
            baseDir,
            code: flags.code,
            id: Option.getOrUndefined(flags.id),
            label: Option.getOrUndefined(flags.label),
            link: makeFleetLink({ fetch: globalThis.fetch, baseDir }),
            localEnvironmentId,
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
      const skipped = (config?.invalidEntries ?? []).map(
        (entry) =>
          `#${entry.index + 1}${entry.label ? ` ${entry.label}` : ""}\tskipped: ${entry.reason}`,
      );
      if (config === null || config.machines.length === 0) {
        if (skipped.length > 0) {
          yield* Console.log(
            [
              ...skipped,
              "",
              "No valid machines are configured; fix or remove the lines above.",
              "",
            ].join("\n"),
          );
          return;
        }
        yield* Console.log(
          `No other machines are configured. Run \`${cliName()} fleet invite --coordinator '<main-machine-environment-id>'\` on one. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here. Then \`fleet add\` here.\n`,
        );
        return;
      }
      const snapshot = yield* Effect.promise(() =>
        discoverFleet(config, undefined, makeFleetLink({ fetch: globalThis.fetch, baseDir })),
      );
      const via = (transport: string | undefined) =>
        transport === "connect" ? "via Connect" : transport === "tailnet" ? "via Tailscale" : "-";
      yield* Console.log(
        [
          ...snapshot.machines.map(
            (machine) =>
              `${machine.id}\t${machine.label}\t${machine.url}${machine.connectUrl ? ` ${machine.connectUrl}` : ""}\t${machine.status}\t${via(machine.transport)}${machine.pairingConfigured ? "" : "\tno management token"}`,
          ),
          ...skipped,
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
      const link = makeFleetLink({ fetch: globalThis.fetch, baseDir });
      const removed = yield* Effect.tryPromise({
        try: () =>
          removeFleetMachineEverywhere({
            baseDir,
            machine: flags.machine,
            fetcher: link,
            revokeWorkerAccess: (target) =>
              revokeWorkerAccessByLabel(link, target, localEnvironmentId),
            unlinkPhones: (target) =>
              unlinkPhonesFrom({
                stateDir: join(baseDir, "userdata"),
                fetcher: link,
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
    "Add your other machines over Tailscale or SpecWithCode Connect so coordinators here can start work on them.",
  ),
  Command.withSubcommands([inviteCommand, addCommand, listCommand, removeCommand]),
);
