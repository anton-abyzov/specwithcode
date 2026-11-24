/**
 * `specwithcode percy` - the owner's switch for the one personal assistant of
 * a SpecWithCode Connect account (1448 D-12), from this machine's terminal.
 *
 * `percy on` lets this machine use your Percy, `percy off` takes it out again
 * (its own memory and chats stay), `percy status` says where this machine and
 * the others stand, and `percy undo` puts this machine's Percy back to a saved
 * copy. Each command asks the service running from this home over its socket,
 * with the credential that service published for the local command line, so it
 * acts as this machine's owner and opens no database.
 */
import {
  EnvironmentId,
  type PersonalLinkSetSharedInput,
  type PersonalShareMachine,
  type PersonalShareMachineState,
  type PersonalShareStatus,
  WS_METHODS,
  WsPersonalShareRpcGroup,
} from "@specweave-studio/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcClient } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { PERSONAL_LINK_BACKUP_SEGMENTS } from "../project/personalRestorePoint.ts";
import { type FleetTarget, readFleetConfig } from "../studioFleet.ts";
import { invokedCliName } from "./cliName.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { type LiveServiceConfig, liveServiceAccess, liveWebSocketTicket } from "./liveService.ts";
import { serviceWebSocketUrl } from "./servicePrepareUpdate.ts";

/** Turning the switch on may make this machine's assistant, which creates a folder. */
const CALL_TIMEOUT = Duration.seconds(60);
const SOCKET_OPEN_TIMEOUT = Duration.seconds(10);

const cliName = () => invokedCliName({ env: process.env.STUDIO_CLI_NAME, argv1: process.argv[1] });

/** A refusal or failure, in the sentence the person reads. The command exits non-zero. */
export class PercyCommandError extends Schema.TaggedError<PercyCommandError>()(
  "PercyCommandError",
  {
    reason: Schema.String,
    /** The service's refusal code, when it refused. */
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

type FleetMachine = Pick<FleetTarget, "id" | "label" | "environmentId">;

const ENVIRONMENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The machines `--with` names, as environment ids. A value is an environment
 * id, or a name that matches exactly one machine in this machine's fleet list
 * (its label or its short id, in any case). A name that matches none or
 * several is refused with the ids to use instead: confirming the wrong
 * machine would share Percy's memory with it.
 */
export const resolveWithMachines = (
  values: ReadonlyArray<string>,
  fleet: ReadonlyArray<FleetMachine>,
  name: string = cliName(),
): Effect.Effect<ReadonlyArray<EnvironmentId>, PercyCommandError> => {
  const resolved: EnvironmentId[] = [];
  for (const value of values.flatMap((entry) => entry.split(",")).map((entry) => entry.trim())) {
    if (value === "") continue;
    const byId = fleet.find((machine) => machine.environmentId === value);
    if (byId !== undefined) {
      resolved.push(byId.environmentId);
      continue;
    }
    const wanted = value.toLowerCase();
    const named = fleet.filter(
      (machine) => machine.label.toLowerCase() === wanted || machine.id.toLowerCase() === wanted,
    );
    if (named.length === 1) {
      resolved.push(named[0]!.environmentId);
      continue;
    }
    if (named.length > 1)
      return Effect.fail(
        new PercyCommandError({
          reason: `"${value}" names ${named.length} machines in this machine's list. Give the environment id instead: ${named
            .map((machine) => `${machine.environmentId} (${machine.label})`)
            .join(", ")}.`,
        }),
      );
    if (ENVIRONMENT_ID_SHAPE.test(value)) {
      resolved.push(EnvironmentId.make(value));
      continue;
    }
    return Effect.fail(
      new PercyCommandError({
        reason: `No machine named "${value}" is in this machine's list (\`${name} fleet list\`). Give its environment id instead; \`${name} percy status\` on that machine shows it.`,
      }),
    );
  }
  return Effect.succeed([...new Set(resolved)]);
};

const STATE_WORDS: Readonly<Record<PersonalShareMachineState, string>> = {
  joined: "joined",
  waiting: "waiting to link",
  switch_off: "its Percy switch is off",
  not_confirmed: "it has not confirmed this machine",
  no_grant: "the two machines have no access to each other",
  legacy_grant: "its access is an older kind; pair the two machines again",
  other_account: "it is linked to another SpecWithCode Connect account",
  older_version: "it runs a version without the shared Percy; update it",
  offline: "offline",
};

const whenText = (iso: string, timeZone: string | undefined) => {
  const at = DateTime.make(iso);
  if (Option.isNone(at)) return iso;
  const style = { locale: "en-US", dateStyle: "long", timeStyle: "short" } as const;
  return timeZone === undefined
    ? DateTime.formatLocal(at.value, style)
    : DateTime.format(at.value, { ...style, timeZone });
};

const machineLine = (machine: PersonalShareMachine, timeZone: string | undefined) => {
  const who =
    machine.label === null ? machine.environmentId : `${machine.label} (${machine.environmentId})`;
  const detail = machine.detail === undefined ? "" : ` ${machine.detail}`;
  const synced =
    machine.lastSyncedAt === undefined
      ? ""
      : ` Last in step ${whenText(machine.lastSyncedAt, timeZone)}.`;
  return `- ${who}: ${STATE_WORDS[machine.state]}.${detail}${synced}`;
};

const REFUSAL_WORDS = {
  not_connected: "this machine is not linked to SpecWithCode Connect",
  assistant_off: "the personal assistant is turned off in Settings > General",
} as const;

/** What `percy status` prints: plain sentences, or the service's answer as one JSON line. */
export function formatPercyStatus(
  status: PersonalShareStatus,
  options: {
    readonly json: boolean;
    readonly cliName?: string;
    /** Left out, times are in this machine's zone. */
    readonly timeZone?: string;
  },
): string {
  if (options.json) return JSON.stringify(status);
  const name = options.cliName ?? cliName();
  const lines = [
    `Your Percy is ${status.enabled ? "on" : "off"} for ${status.machineLabel}.`,
    `This machine's id: ${status.environmentId}`,
    status.linkId === null
      ? "This machine is not linked to SpecWithCode Connect, so it has no link to join."
      : `Link: ...${status.linkId.slice(-8)}, the same on every machine of your SpecWithCode Connect account.`,
    status.projectId === null
      ? "This machine has no personal assistant yet; turning Percy on makes one."
      : `Assistant here: ${status.assistantName ?? "Percy"}, ${
          status.linked
            ? `linked with ${status.members.length - 1} other ${status.members.length === 2 ? "machine" : "machines"}`
            : "not linked yet"
        }.`,
  ];
  if (status.start) lines.push("The link starts from this machine.");
  if (status.refusal !== null)
    lines.push(
      `${status.enabled ? "It cannot link right now" : "It cannot be turned on yet"}: ${REFUSAL_WORDS[status.refusal]}.`,
    );
  if (status.machines.length === 0) {
    lines.push(
      `No other machine is confirmed here. Confirm one with \`${name} percy on --with <machine>\`.`,
    );
  } else {
    lines.push("Other machines:");
    for (const machine of status.machines) lines.push(machineLine(machine, options.timeZone));
  }
  if (status.restorePoints.length === 0) {
    lines.push("No copy of this machine's Percy has been saved yet.");
  } else {
    lines.push(`Saved copies (\`${name} percy undo --restore-point <id>\` goes back to one):`);
    for (const point of status.restorePoints)
      lines.push(
        `- ${point.id}: saved ${whenText(point.savedAt, options.timeZone)}, ${
          point.reason === "before-link" ? "before the link" : "before an undo"
        }, ${point.memoryFileCount} memory ${point.memoryFileCount === 1 ? "file" : "files"}.`,
      );
  }
  return lines.join("\n");
}

type ShareClient = RpcClient.FromGroup<typeof WsPersonalShareRpcGroup, RpcClientError>;

/** One call to the running service's socket as the local command line, closed when it returns. */
const callService = <A, E extends { readonly message: string }>(
  url: string,
  call: (client: ShareClient) => Effect.Effect<A, E>,
) =>
  Effect.scoped(Effect.flatMap(RpcClient.make(WsPersonalShareRpcGroup), call)).pipe(
    Effect.provide(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    ),
    // The service's own sentence: a refusal names what to do, and is all the person needs.
    Effect.mapError((cause) => {
      const code = (cause as { readonly code?: unknown }).code;
      return new PercyCommandError({
        reason: cause.message,
        ...(typeof code === "string" ? { code } : {}),
        cause,
      });
    }),
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new PercyCommandError({
            reason: `SpecWithCode did not answer within ${Duration.format(CALL_TIMEOUT)}.`,
          }),
        ),
    }),
  );

/** The socket of the service running from this home, or why there is none to ask. */
const serviceSocket = Effect.fn("cli.percy.serviceSocket")(function* (
  config: LiveServiceConfig & { readonly baseDir: string },
) {
  const access = yield* liveServiceAccess(config).pipe(Effect.provide(FetchHttpClient.layer));
  if (Option.isNone(access))
    return yield* new PercyCommandError({
      reason: `SpecWithCode is not running for ${config.baseDir}. Start it, then run this again: the switch is kept by the running service.`,
    });
  const ticket = yield* liveWebSocketTicket(access.value).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  return serviceWebSocketUrl(access.value.state.origin, ticket);
});

const withService = <A>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (input: {
    readonly url: string;
    readonly baseDir: string;
    /** Where the running service keeps this machine's copies of its Percy. */
    readonly copies: string;
  }) => Effect.Effect<A, PercyCommandError>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    const url = yield* serviceSocket(config);
    const path = yield* Path.Path;
    const copies = path.join(config.stateDir, ...PERSONAL_LINK_BACKUP_SEGMENTS);
    return yield* run({ url, baseDir: config.baseDir, copies });
  });

/** Where the copies are, in the words `percy on` and `percy undo` print. */
export const copiesLine = (copies: string, after: "on" | "undo", name = cliName()) =>
  after === "on"
    ? `Before this machine first links, it saves a copy of its Percy in ${copies}. \`${name} percy undo\` goes back to it.`
    : `The copy it went back to, and the state from just before this undo, are in ${copies}.`;

const fleetMachines = (baseDir: string) =>
  Effect.tryPromise({
    try: () => readFleetConfig(baseDir),
    catch: () =>
      new PercyCommandError({
        reason:
          "This machine's list of other machines could not be read. Give environment ids to --with instead of names.",
      }),
  }).pipe(Effect.map((config) => config?.machines ?? []));

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the service's answer as one JSON object."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Say whether this machine uses your Percy, the link it joins and where the other machines stand.",
  ),
  Command.withHandler((flags) =>
    withService(flags, ({ url }) =>
      callService(url, (client) => client[WS_METHODS.personalLinkShareStatus]({})),
    ).pipe(
      Effect.flatMap((status) => Console.log(formatPercyStatus(status, { json: flags.json }))),
    ),
  ),
);

const onCommand = Command.make("on", {
  ...projectLocationFlags,
  with: Flag.String("with").pipe(
    Flag.withDescription(
      "Another machine of yours to share Percy with: its environment id, or its name when exactly one machine in `fleet list` has it. Repeat it or separate with commas. Given, it replaces the machines confirmed here; left out, they stay.",
    ),
    Flag.atLeast(0),
  ),
  start: Flag.Boolean("start").pipe(
    Flag.withDescription(
      "Start the link from this machine: its name, icon, instructions and repositories become the link's.",
    ),
    Flag.withDefault(false),
  ),
  name: Flag.String("name").pipe(
    Flag.withDescription("The link's name, with --start. Left out, it stays as it is."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Use your Percy on this machine. Needs SpecWithCode Connect; makes this machine's assistant when it has none.",
  ),
  Command.withHandler((flags) =>
    withService(flags, ({ url, baseDir, copies }) =>
      Effect.gen(function* () {
        const machines =
          flags.with.length === 0
            ? undefined
            : yield* resolveWithMachines(flags.with, yield* fleetMachines(baseDir));
        const name = Option.getOrUndefined(flags.name)?.trim();
        const payload: PersonalLinkSetSharedInput = {
          enabled: true,
          ...(machines === undefined ? {} : { machines }),
          ...(flags.start ? { start: true } : {}),
          ...(name === undefined || name === "" ? {} : { name }),
        };
        const status = yield* callService(url, (client) =>
          client[WS_METHODS.personalLinkSetShared](payload),
        );
        return { status, copies };
      }),
    ).pipe(
      Effect.flatMap(({ status, copies }) =>
        Console.log(
          `${formatPercyStatus(status, { json: false })}\nMachines link by themselves once each one's switch is on and names the other.\n${copiesLine(copies, "on")}`,
        ),
      ),
    ),
  ),
);

const offCommand = Command.make("off", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Stop using your Percy on this machine and leave the link. This machine keeps its own memory and chats.",
  ),
  Command.withHandler((flags) =>
    withService(flags, ({ url }) =>
      callService(url, (client) => client[WS_METHODS.personalLinkSetShared]({ enabled: false })),
    ).pipe(
      Effect.flatMap((status) =>
        Console.log(
          `${formatPercyStatus(status, { json: false })}\nThis machine keeps its own memory and chats; the other machines keep theirs.`,
        ),
      ),
    ),
  ),
);

const undoCommand = Command.make("undo", {
  ...projectLocationFlags,
  restorePoint: Flag.String("restore-point").pipe(
    Flag.withDescription(
      "The saved copy to go back to, as `percy status` lists it. Left out, the one saved before the current link; an older copy must be named.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Put this machine's Percy back to a saved copy: memory and settings only, never chats. The current state is saved first.",
  ),
  Command.withHandler((flags) =>
    withService(flags, ({ url, copies }) => {
      const restorePointId = Option.getOrUndefined(flags.restorePoint)?.trim();
      return callService(url, (client) =>
        client[WS_METHODS.personalLinkUndo](
          restorePointId === undefined || restorePointId === "" ? {} : { restorePointId },
        ),
      ).pipe(Effect.map((status) => ({ status, copies })));
    }).pipe(
      Effect.flatMap(({ status, copies }) =>
        Console.log(
          `This machine's Percy is back to the saved copy.\n${formatPercyStatus(status, { json: false })}\n${copiesLine(copies, "undo")}`,
        ),
      ),
    ),
  ),
);

export const percyCommand = Command.make("percy").pipe(
  Command.withDescription(
    "Use the one personal assistant of your SpecWithCode Connect account on this machine.",
  ),
  Command.withSubcommands([statusCommand, onCommand, offCommand, undoCommand]),
);
