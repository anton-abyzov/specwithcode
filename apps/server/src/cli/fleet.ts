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
// @effect-diagnostics-next-line nodeBuiltinImport:off - the id file is read once, like the fleet file.
import { readFile } from "node:fs/promises";
import { makeFleetLink } from "../fleet/fleetTransport.ts";
import {
  type FleetUpdateAction,
  FleetUpdateFailure,
  legacySelfUpdateOverSocket,
  runFleetUpdate,
} from "../fleet/fleetUpdate.ts";
import {
  type FleetSkillAsk,
  isFleetSkillName,
  isFleetSkillVersion,
  runFleetSkillInstalls,
} from "../fleet/fleetSkills.ts";
import { discoverFleet, FleetError, type FleetTarget, readFleetConfig } from "../studioFleet.ts";
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
      `Worker access this machine may hold on ${removed.label} could not be revoked from here. On ${removed.label}, revoke it under Settings > Machines > Who can run work on this Mac.`,
    );
  if (removed.managementToken === "revoked")
    lines.push(`Revoked this machine's management token on ${removed.label}.`);
  else if (removed.managementToken === "kept")
    lines.push(
      `Its management token is still valid on ${removed.label}: that machine could not be reached or is too old to revoke it remotely. Revoke it there with \`${cli} auth session revoke ${removed.managementSessionId ?? "<id from auth session list>"}\`.`,
    );
  return lines.join("\n");
}

const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The primary's own environment id: its running server's, else the id file in its home. */
const primaryEnvironmentId = (baseDir: string, explicit: Option.Option<string>) =>
  discoverPairTarget(Option.getOrUndefined(explicit)).pipe(
    Effect.map((target) => target.descriptor.environmentId as string),
    Effect.catch(() =>
      Effect.tryPromise(() => readFile(join(baseDir, "userdata", "environment-id"), "utf8")).pipe(
        Effect.map((raw) => raw.trim()),
        Effect.orElseSucceed(() => ""),
      ),
    ),
  );

/** Which `fleet update` action the flags ask for, or why they do not make one. */
export function fleetUpdateActionOf(flags: {
  readonly version: Option.Option<string>;
  readonly holdMinutes: Option.Option<number>;
  readonly noHold: boolean;
  readonly status: boolean;
  readonly check: boolean;
  readonly cancel: Option.Option<string>;
}): FleetUpdateAction | string {
  const chosen = [
    Option.isSome(flags.version),
    flags.status,
    flags.check,
    Option.isSome(flags.cancel),
  ].filter(Boolean).length;
  if (chosen !== 1) return "Choose exactly one of --version, --status, --check or --cancel.";
  if (Option.isSome(flags.version)) {
    const holdMinutes = Option.getOrUndefined(flags.holdMinutes);
    if (holdMinutes !== undefined && (flags.noHold || holdMinutes < 1 || holdMinutes > 15))
      return "--hold-minutes is 1 to 15, and only for a held install (without --no-hold).";
    return { kind: "request", version: flags.version.value, hold: !flags.noHold, holdMinutes };
  }
  if (Option.isSome(flags.cancel)) return { kind: "cancel", request: flags.cancel.value };
  return flags.status ? { kind: "status" } : { kind: "check" };
}

/** A human line for one `fleet update` outcome. */
export function describeFleetUpdate(label: string, outcome: Record<string, unknown>): string {
  const via = outcome.transport === "connect" ? "over SpecWithCode Connect" : "over Tailscale";
  if (outcome.result === undefined)
    return `${label} runs ${String(outcome.version ?? outcome.serverVersion)} (${String(outcome.method ?? "no update path")}, ${String(outcome.phase)}${outcome.message ? `: ${String(outcome.message)}` : ""}), reached ${via}.`;
  const request = outcome.request as { installRequest?: { version?: string } | null } | undefined;
  const version = request?.installRequest?.version;
  switch (outcome.result) {
    case "requested":
      return `Asked ${label} to install ${version ?? "the release"} ${via}; read progress with --status.`;
    case "accepted":
      return `${label} took the update request ${via} and is ${String(outcome.phase)}; read progress with --status.`;
    case "checking":
      return `${label}'s update agent does not offer that release yet; it is looking now. Ask again in a minute.`;
    case "check-requested":
      return `Asked ${label} to look for a release now.`;
    case "already-installed":
      return `${label} already runs that version.`;
    case "cancelled":
      return `Cancelled the install request on ${label}.`;
    default:
      return `${label}: ${String(outcome.result)}.`;
  }
}

const updateCommand = Command.make("update", {
  baseDir: baseDirFlag,
  machine: Argument.String("machine").pipe(
    Argument.withDescription("The machine's id or name, as `fleet list` shows it."),
  ),
  version: Flag.String("version").pipe(
    Flag.withDescription(
      "Ask the machine to install this published release (X.Y.Z). A macOS service drains and holds as Update now does; a Linux service updates itself.",
    ),
    Flag.optional,
  ),
  holdMinutes: Flag.Int("hold-minutes").pipe(
    Flag.withDescription("How long a held install may retry, 1 to 15 minutes. Default 15."),
    Flag.optional,
  ),
  noHold: Flag.Boolean("no-hold").pipe(
    Flag.withDescription(
      "Request the install without stopping work; the update agent waits for a quiet moment.",
    ),
    Flag.withDefault(false),
  ),
  status: Flag.Boolean("status").pipe(
    Flag.withDescription("Read the machine's update status."),
    Flag.withDefault(false),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription("Ask the machine to look for a release now."),
    Flag.withDefault(false),
  ),
  cancel: Flag.String("cancel").pipe(
    Flag.withDescription("Cancel the install request made at this time (its installRequestedAt)."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print one JSON line, shaped like update_request.py's, and exit 1 on failure.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "On the primary machine: ask another machine to install a release, over SpecWithCode Connect or Tailscale, with the management token saved for it.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // With --json a script reads the one line; the exit code still says it failed.
      const fail = (reason: string, error: string): Effect.Effect<void, FleetCommandError> =>
        flags.json
          ? Console.log(encodeJsonLine({ error, reason })).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  process.exitCode = 1;
                }),
              ),
            )
          : Effect.fail(new FleetCommandError({ detail: error }));
      const action = fleetUpdateActionOf(flags);
      if (typeof action === "string") return yield* fail("usage", action);
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      const config = yield* Effect.tryPromise({
        try: () => readFleetConfig(baseDir),
        catch: fleetFailure,
      });
      const wanted = flags.machine.trim().toLowerCase();
      const target = config?.machines.find(
        (machine) => machine.id === wanted || machine.label.trim().toLowerCase() === wanted,
      );
      if (target === undefined)
        return yield* fail("unknown-machine", new FleetError("unknown-machine").message);
      const coordinatorEnvironmentId = yield* primaryEnvironmentId(baseDir, flags.baseDir);
      if (coordinatorEnvironmentId === "")
        return yield* fail(
          "unauthorized",
          "This machine's environment ID could not be read; start its SpecWithCode service, or pass --base-dir.",
        );
      const outcome = yield* Effect.tryPromise({
        try: () =>
          runFleetUpdate({
            link: makeFleetLink({ fetch: globalThis.fetch, baseDir }),
            target,
            coordinatorEnvironmentId,
            action,
            legacySelfUpdate: legacySelfUpdateOverSocket,
          }),
        catch: (error) =>
          error instanceof FleetUpdateFailure
            ? error
            : new FleetUpdateFailure("unreachable", "The machine could not be reached."),
      }).pipe(Effect.result);
      if (outcome._tag === "Failure")
        return yield* fail(outcome.failure.reason, outcome.failure.message);
      yield* Console.log(
        flags.json
          ? encodeJsonLine(outcome.success)
          : describeFleetUpdate(target.label, outcome.success),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

/** Which skill install the `fleet skills` flags ask for, or why they do not make one. */
export function fleetSkillAskOfFlags(flags: {
  readonly skill: string;
  readonly version: string;
  readonly scope: "user" | "project";
  readonly project: Option.Option<string>;
  readonly noPin: boolean;
}): FleetSkillAsk | { readonly reason: "usage" | "invalid-skill"; readonly error: string } {
  const skill = flags.skill.trim();
  const version = flags.version.trim();
  if (!isFleetSkillName(skill))
    return {
      reason: "invalid-skill",
      error: `${skill} is not a published skill name; use owner/repo/name (no local: or other sources, paths or URLs).`,
    };
  if (!isFleetSkillVersion(version))
    return { reason: "invalid-skill", error: `${version} is not an exact version (X.Y.Z).` };
  const pin = !flags.noPin;
  if (flags.scope === "project") {
    const projectId = Option.getOrUndefined(flags.project)?.trim() ?? "";
    if (projectId === "")
      return {
        reason: "usage",
        error: "--scope project needs --project <id>, that machine's own project id.",
      };
    return { skill, version, pin, scope: "project", projectId };
  }
  if (Option.isSome(flags.project))
    return { reason: "usage", error: "--project is only for --scope project." };
  return { skill, version, pin, scope: "user" };
}

/** Which saved machines `fleet skills` asks: the one named, or every one with --all. */
export function fleetSkillTargetsOf(
  machines: ReadonlyArray<FleetTarget>,
  machine: Option.Option<string>,
  all: boolean,
): ReadonlyArray<FleetTarget> | { readonly reason: string; readonly error: string } {
  if (Option.isSome(machine) === all)
    return { reason: "usage", error: "Name one machine, or pass --all." };
  if (Option.isNone(machine))
    return machines.length === 0
      ? { reason: "unknown-machine", error: "No other machines are saved here." }
      : machines;
  const wanted = machine.value.trim().toLowerCase();
  const target = machines.find(
    (entry) => entry.id === wanted || entry.label.trim().toLowerCase() === wanted,
  );
  return target === undefined
    ? { reason: "unknown-machine", error: new FleetError("unknown-machine").message }
    : [target];
}

/** A human line for one `fleet skills` outcome. */
export function describeFleetSkill(outcome: Record<string, unknown>): string {
  const label = String(outcome.label ?? outcome.machine);
  if (typeof outcome.error === "string")
    return `${label}: ${String(outcome.reason)}: ${outcome.error}`;
  const via = outcome.transport === "connect" ? "over SpecWithCode Connect" : "over Tailscale";
  const pinned =
    typeof outcome.pinnedVersion === "string"
      ? `, pinned at ${outcome.pinnedVersion}`
      : ", unpinned";
  return `${label} has ${String(outcome.skill)} ${String(outcome.installedVersion)} (${String(outcome.scope)}${pinned}), installed ${via}.`;
}

const skillsCommand = Command.make("skills", {
  baseDir: baseDirFlag,
  machine: Argument.String("machine").pipe(
    Argument.withDescription("The machine's id or name, as `fleet list` shows it."),
    Argument.optional,
  ),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Ask every saved machine instead of one."),
    Flag.withDefault(false),
  ),
  skill: Flag.String("skill").pipe(
    Flag.withDescription("The published skill, as owner/repo/name."),
  ),
  version: Flag.String("version").pipe(
    Flag.withDescription("The exact skill version to install (X.Y.Z)."),
  ),
  scope: Flag.Literals("scope", ["user", "project"]).pipe(
    Flag.withDescription(
      "user installs for the machine's user (vskill --global); project installs into one project there.",
    ),
    Flag.withDefault("user" as const),
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("With --scope project: that machine's own project id."),
    Flag.optional,
  ),
  noPin: Flag.Boolean("no-pin").pipe(
    Flag.withDescription(
      "Drop the pin `vskill install @version` sets, so the machine keeps taking updates.",
    ),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print one JSON line per machine, and exit 1 when any machine did not install it.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "On the primary machine: install one skill version on another machine, or all of them, over SpecWithCode Connect or Tailscale, and read the version back from its lock.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fail = (reason: string, error: string): Effect.Effect<void, FleetCommandError> =>
        flags.json
          ? Console.log(encodeJsonLine({ error, reason })).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  process.exitCode = 1;
                }),
              ),
            )
          : Effect.fail(new FleetCommandError({ detail: error }));
      const ask = fleetSkillAskOfFlags(flags);
      if ("error" in ask) return yield* fail(ask.reason, ask.error);
      const baseDir = yield* resolveFleetBaseDir(flags.baseDir);
      const config = yield* Effect.tryPromise({
        try: () => readFleetConfig(baseDir),
        catch: fleetFailure,
      });
      const targets = fleetSkillTargetsOf(config?.machines ?? [], flags.machine, flags.all);
      if ("error" in targets) return yield* fail(targets.reason, targets.error);
      const coordinatorEnvironmentId = yield* primaryEnvironmentId(baseDir, flags.baseDir);
      if (coordinatorEnvironmentId === "")
        return yield* fail(
          "unauthorized",
          "This machine's environment ID could not be read; start its SpecWithCode service, or pass --base-dir.",
        );
      const outcomes = yield* Effect.promise(() =>
        runFleetSkillInstalls({
          link: makeFleetLink({ fetch: globalThis.fetch, baseDir }),
          targets,
          coordinatorEnvironmentId,
          ask,
        }),
      );
      for (const outcome of outcomes)
        yield* Console.log(flags.json ? encodeJsonLine(outcome) : describeFleetSkill(outcome));
      if (outcomes.some((outcome) => typeof outcome.error === "string")) {
        if (flags.json)
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        else
          return yield* new FleetCommandError({
            detail: "The skill was not installed on every machine asked.",
          });
      }
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

export const fleetCommand = Command.make("fleet").pipe(
  Command.withDescription(
    "Add your other machines over Tailscale or SpecWithCode Connect so coordinators here can start work on them.",
  ),
  Command.withSubcommands([
    inviteCommand,
    addCommand,
    listCommand,
    removeCommand,
    updateCommand,
    skillsCommand,
  ]),
);
