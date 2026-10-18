/**
 * `specweave-studio service prepare-update`: the desktop's Update now drain and
 * hold, for a script on the same machine (scripts/studio-fleet/fleet_rollout.py).
 *
 * It makes the very call Update now makes, `server.prepareServiceUpdate` over the
 * running service's WebSocket, so the service's own ServiceUpdatePreparation
 * stops the work and holds itself; nothing here drains or holds by other means.
 * The credential is minted the way `project` does it against a live server: a
 * session issued in this home's auth store, here with only `environment:maintain`
 * (the scope the RPC needs) and five minutes to live, a WebSocket ticket signed
 * for it, and the session revoked as soon as the call returns. Run it with the
 * service's own CLI (`cliWrapper` in its installation.json), so the build that
 * writes the auth store is the one that owns it.
 *
 * @module servicePrepareUpdate
 */
import {
  AuthEnvironmentMaintainScope,
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
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** Longer than the drain's own 70 s deadline plus its settle look (ServiceUpdatePreparation). */
export const STOP_WORK_TIMEOUT = Duration.seconds(150);
/** A report or a release changes no work; the desktop allows 5 s. */
export const QUICK_CALL_TIMEOUT = Duration.seconds(20);
const SOCKET_OPEN_TIMEOUT = Duration.seconds(10);
const SESSION_TTL = Duration.minutes(5);
export const SESSION_LABEL = "specweave-studio service prepare-update";

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
      : `Still running: ${result.blockers
          .map(
            (blocker) =>
              `${blocker.count} ${blocker.kind}${blocker.threadTitle === null ? "" : ` (${blocker.threadTitle})`}`,
          )
          .join(", ")}.`,
  ];
  return lines.join("\n");
}

const runPrepareUpdate = Effect.fn("cli.service.prepareUpdate")(function* (
  flags: ServicePrepareUpdateFlags & {
    readonly baseDir: Option.Option<string>;
    readonly json: boolean;
  },
) {
  const result = yield* Effect.gen(function* () {
    const payload = yield* prepareInputFromFlags(flags);
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    // Read before the auth store opens, so a home no service runs from is left as it is.
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtime)) {
      return yield* new ServicePrepareUpdateNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtime.value.origin;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({
          scopes: [AuthEnvironmentMaintainScope],
          ttl: SESSION_TTL,
          label: SESSION_LABEL,
        }),
        (issued) =>
          Effect.gen(function* () {
            const ticket = yield* environmentAuth.issueWebSocketTicket({
              sessionId: issued.sessionId,
            });
            return yield* callPrepareServiceUpdate({
              url: serviceWebSocketUrl(origin, ticket.ticket),
              payload,
              timeout: payload.stopWork ? STOP_WORK_TIMEOUT : QUICK_CALL_TIMEOUT,
            });
          }),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(
            Layer.succeed(References.MinimumLogLevel, flags.json ? "Error" : config.logLevel),
          ),
        ),
      ),
    );
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
