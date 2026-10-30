/**
 * `specweave-studio service prepare-update`: the desktop's Update now drain and
 * hold, for a script on the same machine (scripts/studio-fleet/fleet_rollout.py).
 *
 * It makes the very call Update now makes, `server.prepareServiceUpdate` over the
 * running service's WebSocket, so the service's own ServiceUpdatePreparation
 * stops the work and holds itself; nothing here drains or holds by other means.
 * It authenticates with the credential the running service published for this
 * machine's CLI (auth/LocalCliCredential.ts): a WebSocket ticket from
 * `/api/auth/websocket-ticket`, then the socket. It never opens the live
 * database. Until 1085 it inserted a five-minute session row through a
 * read-write connection of its own, and such a connection deletes `-wal` and
 * `-shm` when it closes under a service that has lost its SQLite locks
 * (docs/operations/live-database.md).
 *
 * The update helper (scripts/studio-fleet/update.py) hashes the auth_sessions
 * rows when its agent takes the prestate snapshot and again right before it
 * applies; its auth invariant leaves out only `last_connected_at`, the heartbeat
 * a connect writes. This command now writes no row at all: the local CLI
 * session is issued when the service starts, and the URL carries neither
 * `clientSurface` nor `clientAppVersion`, the only parameters that make a
 * connect write other cells. Run it with the service's own CLI (`cliWrapper` in
 * its installation.json), so the build that reads the credential is the one
 * that published it.
 *
 * @module servicePrepareUpdate
 */
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
  ServiceUpdatePrepareReason,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { FetchHttpClient } from "effect/http";

import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  liveServiceEndpoint,
  liveWebSocketTicket,
  runningService,
  type LiveServiceConfig,
} from "./liveService.ts";

/** Longer than the drain's own 70 s deadline plus its settle look (ServiceUpdatePreparation). */
export const STOP_WORK_TIMEOUT = Duration.seconds(150);
/** A report or a release changes no work; the desktop allows 5 s. */
export const QUICK_CALL_TIMEOUT = Duration.seconds(20);
const SOCKET_OPEN_TIMEOUT = Duration.seconds(10);

export class ServicePrepareUpdateUsageError extends Schema.TaggedError<ServicePrepareUpdateUsageError>()(
  "ServicePrepareUpdateUsageError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ServicePrepareUpdateNotRunningError extends Schema.TaggedError<ServicePrepareUpdateNotRunningError>()(
  "ServicePrepareUpdateNotRunningError",
  { baseDir: Schema.String },
) {
  override get message(): string {
    return `No running SpecWithCode service owns ${this.baseDir}.`;
  }
}

export class ServicePrepareUpdateCallError extends Schema.TaggedError<ServicePrepareUpdateCallError>()(
  "ServicePrepareUpdateCallError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The service did not prepare the update: ${this.reason}`;
  }
}

export interface ServicePrepareUpdateFlags {
  readonly stopWork: boolean;
  readonly hold: boolean;
  readonly ifIdle: boolean;
  readonly releaseHold: boolean;
  readonly reason: Option.Option<ServiceUpdatePrepareReason>;
}

/** The RPC input for the flags, as Update now and Cancel update send it. */
export const prepareInputFromFlags = (
  flags: ServicePrepareUpdateFlags,
): Effect.Effect<ServerPrepareServiceUpdateInput, ServicePrepareUpdateUsageError> => {
  const reason = Option.getOrUndefined(flags.reason);
  if (flags.releaseHold) {
    return flags.stopWork || flags.hold
      ? Effect.fail(
          new ServicePrepareUpdateUsageError({
            reason: "--release-hold cannot be combined with --stop-work or --hold.",
          }),
        )
      : Effect.succeed({
          stopWork: false,
          releaseHold: true,
          ...(reason === undefined ? {} : { reason }),
        });
  }
  if (flags.ifIdle) {
    return flags.hold && !flags.stopWork
      ? Effect.succeed({
          stopWork: false,
          hold: true,
          ifIdle: true,
          ...(reason === undefined ? {} : { reason }),
        })
      : Effect.fail(
          new ServicePrepareUpdateUsageError({
            reason: "--if-idle goes with --hold and without --stop-work: it stops nothing.",
          }),
        );
  }
  if (flags.hold && !flags.stopWork) {
    return Effect.fail(
      new ServicePrepareUpdateUsageError({
        reason: "--hold needs --stop-work: the service holds only a drained service.",
      }),
    );
  }
  return Effect.succeed({
    stopWork: flags.stopWork,
    ...(flags.hold ? { hold: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  });
};

/** The service's `/ws` URL for a ticket, as the clients connect. */
export function serviceWebSocketUrl(origin: string, ticket: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

/** One `server.prepareServiceUpdate` call over a fresh socket, closed when it returns. */
export const callPrepareServiceUpdate = (input: {
  readonly url: string;
  readonly payload: ServerPrepareServiceUpdateInput;
  readonly timeout: Duration.Duration;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* client[WS_METHODS.serverPrepareServiceUpdate](input.payload);
    }),
  ).pipe(
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
            Socket.layerWebSocket(input.url, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new ServicePrepareUpdateCallError({
          reason: cause.message,
          cause,
        }),
    ),
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(
          new ServicePrepareUpdateCallError({
            reason: `no answer within ${Duration.format(input.timeout)}`,
          }),
        ),
    }),
  );

const count = (value: number | undefined, one: string, many: string) =>
  `${value ?? 0} ${(value ?? 0) === 1 ? one : many}`;

export function formatPrepareResult(
  result: ServerPrepareServiceUpdateResult,
  options: { readonly json: boolean },
): string {
  if (options.json) return JSON.stringify(result);
  const lines = [
    result.held === true
      ? `SpecWithCode is held for the update${result.holdUntil === undefined ? "" : ` until ${result.holdUntil}`}.`
      : "SpecWithCode is not held for an update.",
    `Stopped ${count(result.stoppedThreads, "thread", "threads")}, interrupted ${count(result.interruptedRuns, "turn", "turns")}, ${count(result.openTerminals, "terminal", "terminals")} open or closed.`,
    result.idle
      ? "Nothing the update waits for is left."
      : `Still running: ${[
          ...result.blockers.map(
            (blocker) =>
              `${blocker.count} ${blocker.kind}${blocker.threadTitle === null ? "" : ` (${blocker.threadTitle})`}`,
          ),
          ...(result.leftoverProcesses === undefined
            ? []
            : [count(result.leftoverProcesses, "process", "processes")]),
        ].join(", ")}.`,
  ];
  return lines.join("\n");
}

/**
 * One `server.prepareServiceUpdate` call to the service running from this home; none when no
 * service runs from it. Reads files and asks the service over HTTP and its socket only.
 */
export const prepareRunningService = Effect.fn("cli.service.prepareRunningService")(function* (
  config: LiveServiceConfig,
  payload: ServerPrepareServiceUpdateInput,
) {
  const running = yield* runningService(config);
  if (Option.isNone(running)) return Option.none<ServerPrepareServiceUpdateResult>();
  const { origin, token } = yield* liveServiceEndpoint(config, running.value).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  const ticket = yield* liveWebSocketTicket({ state: { ...running.value, origin }, token }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  return Option.some(
    yield* callPrepareServiceUpdate({
      url: serviceWebSocketUrl(origin, ticket),
      payload,
      timeout: payload.stopWork ? STOP_WORK_TIMEOUT : QUICK_CALL_TIMEOUT,
    }),
  );
});

const runPrepareUpdate = Effect.fn("cli.service.prepareUpdate")(function* (
  flags: ServicePrepareUpdateFlags & {
    readonly baseDir: Option.Option<string>;
    readonly json: boolean;
  },
) {
  const result = yield* Effect.gen(function* () {
    const payload = yield* prepareInputFromFlags(flags);
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    // Files only: a home no service runs from is left as it is.
    const result = yield* prepareRunningService(config, payload);
    if (Option.isNone(result)) {
      return yield* new ServicePrepareUpdateNotRunningError({ baseDir: config.baseDir });
    }
    return result.value;
  }).pipe(
    // A script reads the last stdout line; the failure still sets the exit code.
    Effect.tapError((error) =>
      flags.json ? Console.log(JSON.stringify({ error: error.message })) : Effect.void,
    ),
  );
  yield* Console.log(formatPrepareResult(result, { json: flags.json }));
});

export const servicePrepareUpdateCommand = Command.make("prepare-update", {
  ...projectLocationFlags,
  stopWork: Flag.Boolean("stop-work").pipe(
    Flag.withDescription(
      "Stop every running task, cancel queued messages and close terminals, as Update now does. Without it, only report what is still running.",
    ),
    Flag.withDefault(false),
  ),
  hold: Flag.Boolean("hold").pipe(
    Flag.withDescription(
      "With --stop-work, hold the service for the update: new work is refused until the update installs, fails or is cancelled, or the hold runs out. Write the install request right after.",
    ),
    Flag.withDefault(false),
  ),
  ifIdle: Flag.Boolean("if-idle").pipe(
    Flag.withDescription(
      "With --hold and without --stop-work: hold the service only when nothing runs in it, stopping nothing. Busy, it is left unheld.",
    ),
    Flag.withDefault(false),
  ),
  releaseHold: Flag.Boolean("release-hold").pipe(
    Flag.withDescription("Release the update hold so work can start again, as Cancel update does."),
    Flag.withDefault(false),
  ),
  reason: Flag.Literals("reason", ServiceUpdatePrepareReason.literals).pipe(
    Flag.withDescription("Why: `install` (default) precedes an install request."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the service's answer as one JSON object."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Drain and hold the running service for an install, the way the desktop's Update now does.",
  ),
  Command.withHandler(runPrepareUpdate),
);
