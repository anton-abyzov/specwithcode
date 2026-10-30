import type { RelayManagedEndpointRuntimeConfig } from "@specweave-studio/contracts/relay";
import * as RelayClient from "@specweave-studio/shared/relayClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RelayProcessOwnership from "./RelayProcessOwnership.ts";

export type CloudManagedEndpointRuntimeStatus =
  | {
      readonly status: "disabled";
    }
  | {
      readonly status: "failed";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
      readonly failure: "unsupported-platform" | "not-installed" | "spawn-failed";
      readonly reason: string;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "running";
      readonly providerKind: "cloudflare_tunnel";
      readonly pid: number;
      readonly tunnelId?: string;
      readonly tunnelName?: string;
    }
  | {
      readonly status: "unsupported";
      readonly providerKind: RelayManagedEndpointRuntimeConfig["providerKind"];
    };

export class CloudManagedEndpointRuntime extends Context.Service<
  CloudManagedEndpointRuntime,
  {
    readonly applyConfig: (
      config: RelayManagedEndpointRuntimeConfig | null,
    ) => Effect.Effect<CloudManagedEndpointRuntimeStatus>;
    readonly recoveryRequests: Stream.Stream<RelayManagedEndpointRuntimeConfig>;
    readonly requestRecovery: (config: RelayManagedEndpointRuntimeConfig) => Effect.Effect<void>;
    /** Emits when the connector registers a tunnel connection, i.e. the relay can reach us again. */
    readonly tunnelConnected: Stream.Stream<void>;
    readonly withLinkStateLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("specweave-studio/cloud/ManagedEndpointRuntime/CloudManagedEndpointRuntime") {}

interface ActiveConnector {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly configKey: string;
  readonly config: RelayManagedEndpointRuntimeConfig;
  readonly startedAtMillis: number;
  readonly connected: Ref.Ref<boolean>;
  readonly ownershipGeneration: string | null;
}

// A connector that exits before running this long is treated as part of a
// crash loop; one that stays up at least this long earns an immediate restart
// again. Without the backoff below, a relay client that fails instantly (a
// stale version-manager shim, a bad binary) respawns ~100 times per second
// until the accumulated tracing exhausts the V8 heap.
const RELAY_RESTART_STABLE_UPTIME_MS = 30_000;
const RELAY_RESTART_BACKOFF_BASE_MS = 1_000;
const RELAY_RESTART_BACKOFF_MAX_MS = 60_000;
// Newly created tunnels can fail authorization briefly while Cloudflare propagates their token.
const TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY = 4;
// A connector that never registers a connection may hold a token for a tunnel
// that no longer exists, rejected in wording the output check does not know.
// Ask for recovery after this long, and again at this interval while it stays
// unconnected; the relay hands back the same tunnel when it is still live.
const CONNECTOR_REGISTRATION_TIMEOUT = Duration.minutes(3);
// An app update can pin a relay client version this machine never installed.
// The runtime installs it on demand, but a failed install must not download
// again on every startup retry: after a failure it reports "not-installed"
// without trying again for a delay that doubles with each consecutive failure
// up to the cap, and resets once an install succeeds. A failure that a retry
// is unlikely to fix soon (a checksum a proxy rewrites, a binary that will not
// run, a missing override) waits at least the longer floor, so a full download
// does not repeat every few minutes.
const RELAY_CLIENT_INSTALL_RETRY_BASE = Duration.minutes(5);
const RELAY_CLIENT_INSTALL_RETRY_PERSISTENT_FLOOR = Duration.hours(1);
const RELAY_CLIENT_INSTALL_RETRY_MAX = Duration.hours(6);
const RELAY_CLIENT_INSTALL_TIMEOUT = Duration.minutes(5);
const PERSISTENT_RELAY_CLIENT_INSTALL_FAILURES: ReadonlySet<
  RelayClient.RelayClientInstallError["reason"]
> = new Set(["invalid_checksum", "validation_failed", "override_missing", "unsupported_platform"]);

export function relayClientInstallRetryDelayMillis(
  consecutiveFailures: number,
  reason: RelayClient.RelayClientInstallError["reason"] | "timeout",
): number {
  const baseMillis = Duration.toMillis(RELAY_CLIENT_INSTALL_RETRY_BASE);
  const maxMillis = Duration.toMillis(RELAY_CLIENT_INSTALL_RETRY_MAX);
  const exponentialMillis = baseMillis * 2 ** Math.max(0, consecutiveFailures - 1);
  const floorMillis =
    reason !== "timeout" && PERSISTENT_RELAY_CLIENT_INSTALL_FAILURES.has(reason)
      ? Duration.toMillis(RELAY_CLIENT_INSTALL_RETRY_PERSISTENT_FLOOR)
      : baseMillis;
  return Math.min(maxMillis, Math.max(floorMillis, exponentialMillis));
}

export function classifyRelayClientOutput(line: string): "connected" | "warning" | "debug" {
  if (/\bRegistered tunnel connection\b/iu.test(line)) {
    return "connected";
  }
  // cloudflared uses zerolog level tokens. FTL (fatal) and PNC (panic) are more
  // severe than ERR, so they must surface at least as loudly — without them a
  // fatal connector failure would be logged at debug and hidden.
  return /\b(?:ERR|WRN|FTL|PNC)\b/u.test(line) ? "warning" : "debug";
}

/**
 * Cloudflare's edge rejects a connector whose tunnel was deleted or whose
 * token no longer matches. The edge words this differently over time
 * (`Failed to get tunnel`, `Tunnel not found`, ...), sometimes prefixed with
 * `Unauthorized:`. Treat any `Unauthorized:` registration error as a rejection,
 * plus the unprefixed messages seen so far. Transient rejections while a new
 * tunnel's token propagates are absorbed by requiring several in a row.
 */
export function isRejectedRelayClientTunnelOutput(line: string): boolean {
  return (
    /\bRegister tunnel error from server side\b/iu.test(line) &&
    /error="(?:Unauthorized:[^"]*|Failed to get tunnel|Tunnel not found|Record for tunnel not found|Invalid tunnel secret)"/iu.test(
      line,
    )
  );
}

/** Connector startup failures can clear after installation or a later spawn attempt. */
export function isRetryableManagedEndpointRuntimeStatus(status: unknown): boolean {
  if (typeof status !== "object" || status === null || !("status" in status)) {
    return false;
  }
  if (status.status !== "failed" || !("failure" in status)) {
    return false;
  }
  return status.failure === "not-installed" || status.failure === "spawn-failed";
}

function runtimeConfigKey(config: RelayManagedEndpointRuntimeConfig): string {
  return JSON.stringify({
    providerKind: config.providerKind,
    connectorToken: config.connectorToken,
    tunnelId: config.tunnelId ?? null,
    tunnelName: config.tunnelName ?? null,
  });
}

const stopConnector = (connector: ActiveConnector | null) =>
  connector
    ? Scope.close(connector.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.logInfo("Relay client stopped", {
            pid: Number(connector.child.pid),
          }),
        ),
        Effect.ignore,
      )
    : Effect.void;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const ownership = yield* RelayProcessOwnership.RelayProcessOwnership;
  const activeRef = yield* Ref.make<ActiveConnector | null>(null);
  const desiredConfigRef = yield* Ref.make<RelayManagedEndpointRuntimeConfig | null>(null);
  const recoveryRequests = yield* Queue.sliding<RelayManagedEndpointRuntimeConfig>(1);
  const tunnelConnections = yield* Queue.sliding<void>(1);
  const reconcileSemaphore = yield* Semaphore.make(1);
  const restartDelayRef = yield* Ref.make(0);
  const linkStateSemaphore = yield* Semaphore.make(1);
  const installBackoffRef = yield* Ref.make<{
    readonly consecutiveFailures: number;
    readonly retryAtMillis: number;
  } | null>(null);
  let reconcileConfig: CloudManagedEndpointRuntime["Service"]["applyConfig"];

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.getAndSet(activeRef, null);
    yield* stopConnector(active);
    if (active) yield* ownership.clear(Number(active.child.pid), active.ownershipGeneration);
  });

  const superviseConnector = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(connector.child.exitCode);
      const activeAtExit = yield* Ref.get(activeRef);
      if (
        activeAtExit?.child.pid !== connector.child.pid ||
        activeAtExit.configKey !== connector.configKey
      ) {
        return;
      }
      const uptimeMillis = (yield* Clock.currentTimeMillis) - connector.startedAtMillis;
      // The first crash restarts immediately; every further crash inside the
      // stable-uptime window doubles the wait, up to the cap. The delay runs
      // before the semaphore so a user config change is never blocked behind
      // it, and reconcileConfig re-checks the desired config afterwards.
      const restartDelayMillis = yield* Ref.modify(restartDelayRef, (current) => {
        if (uptimeMillis >= RELAY_RESTART_STABLE_UPTIME_MS) {
          return [0, 0];
        }
        return [
          current,
          current === 0
            ? RELAY_RESTART_BACKOFF_BASE_MS
            : Math.min(current * 2, RELAY_RESTART_BACKOFF_MAX_MS),
        ];
      });
      if (restartDelayMillis > 0) {
        yield* Effect.logWarning("Relay client is crash-looping; delaying restart", {
          pid: Number(connector.child.pid),
          uptimeMillis,
          restartDelayMillis,
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        });
        yield* Effect.sleep(Duration.millis(restartDelayMillis));
      }
      yield* reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* Ref.get(activeRef);
          if (
            active?.child.pid !== connector.child.pid ||
            active.configKey !== connector.configKey
          ) {
            return;
          }
          yield* Ref.set(activeRef, null);
          yield* stopConnector(connector);
          yield* ownership.clear(Number(connector.child.pid), connector.ownershipGeneration);

          const desiredConfig = yield* Ref.get(desiredConfigRef);
          if (
            !desiredConfig ||
            desiredConfig.providerKind !== "cloudflare_tunnel" ||
            runtimeConfigKey(desiredConfig) !== connector.configKey
          ) {
            return;
          }

          yield* Effect.logWarning("Relay client exited; restarting", {
            pid: Number(connector.child.pid),
            ...(Result.isSuccess(result)
              ? { exitCode: Number(result.success) }
              : { cause: result.failure }),
            tunnelId: connector.config.tunnelId,
            tunnelName: connector.config.tunnelName,
          });
          yield* Queue.offer(recoveryRequests, connector.config);
          yield* reconcileConfig(desiredConfig);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Relay client supervisor failed", { cause })),
    );

  // Requests recovery while the connector has not registered a connection,
  // once per timeout, until it connects or is replaced.
  const watchConnectorRegistration = (connector: ActiveConnector) =>
    Effect.gen(function* () {
      yield* Effect.sleep(CONNECTOR_REGISTRATION_TIMEOUT);
      if (yield* Ref.get(connector.connected)) return true;
      yield* Effect.logWarning(
        "Relay client has not registered a tunnel connection; requesting recovery",
        {
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        },
      );
      yield* Queue.offer(recoveryRequests, connector.config);
      return false;
    }).pipe(Effect.repeat({ until: (connected) => connected }));

  const observeConnectorOutput = (connector: ActiveConnector) => {
    let rejectedRegistrations = 0;

    return connector.child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => line.trim()),
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => {
        const output = line.replaceAll(connector.config.connectorToken, "<redacted>");
        const attributes = {
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
          output,
        };
        switch (classifyRelayClientOutput(line)) {
          case "connected":
            rejectedRegistrations = 0;
            return Ref.set(connector.connected, true).pipe(
              Effect.andThen(
                Effect.logInfo("Relay client tunnel connection registered", attributes),
              ),
              Effect.andThen(Queue.offer(tunnelConnections, undefined)),
              Effect.asVoid,
            );
          case "warning":
            if (isRejectedRelayClientTunnelOutput(line)) {
              rejectedRegistrations += 1;
              if (rejectedRegistrations >= TUNNEL_AUTHORIZATION_FAILURES_BEFORE_RECOVERY) {
                rejectedRegistrations = 0;
                return Effect.logWarning(
                  "Relay client tunnel was rejected; requesting recovery",
                  attributes,
                ).pipe(
                  Effect.andThen(Queue.offer(recoveryRequests, connector.config)),
                  Effect.asVoid,
                );
              }
            }
            return Effect.logWarning("Relay client reported a transport warning", attributes);
          case "debug":
            return Effect.logDebug("Relay client output", attributes);
        }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Relay client output observer failed", {
          cause,
          pid: Number(connector.child.pid),
          tunnelId: connector.config.tunnelId,
          tunnelName: connector.config.tunnelName,
        }),
      ),
    );
  };

  const installRelayClient = Effect.fn("CloudManagedEndpointRuntime.installRelayClient")(function* (
    missing: Extract<RelayClient.RelayClientStatus, { readonly status: "missing" }>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const backoff = yield* Ref.get(installBackoffRef);
    if (backoff !== null && now < backoff.retryAtMillis) {
      yield* Effect.logDebug("Relay client install is backing off after a failure", {
        version: missing.version,
        consecutiveFailures: backoff.consecutiveFailures,
        retryInMillis: backoff.retryAtMillis - now,
      });
      return missing;
    }
    yield* Effect.annotateCurrentSpan({ "relay_client.version": missing.version });
    yield* Effect.logInfo("Relay client is not installed; installing it", {
      version: missing.version,
    });
    const installed = yield* relayClient
      .installWithProgress((event) =>
        event.type === "progress"
          ? Effect.logDebug("Relay client install progress", {
              version: missing.version,
              stage: event.stage,
            })
          : Effect.void,
      )
      .pipe(Effect.timeout(RELAY_CLIENT_INSTALL_TIMEOUT), Effect.result);
    if (Result.isFailure(installed)) {
      const failure = installed.failure;
      const reason = failure._tag === "RelayClientInstallError" ? failure.reason : "timeout";
      const consecutiveFailures = (backoff?.consecutiveFailures ?? 0) + 1;
      const retryInMillis = relayClientInstallRetryDelayMillis(consecutiveFailures, reason);
      yield* Ref.set(installBackoffRef, {
        consecutiveFailures,
        retryAtMillis: (yield* Clock.currentTimeMillis) + retryInMillis,
      });
      yield* Effect.logWarning("Could not install the relay client; will retry later", {
        version: missing.version,
        consecutiveFailures,
        retryInMillis,
        reason,
        ...(failure._tag === "RelayClientInstallError"
          ? { message: failure.message, cause: failure.cause }
          : {}),
      });
      return missing;
    }
    yield* Ref.set(installBackoffRef, null);
    yield* Effect.logInfo("Relay client installed", {
      version: installed.success.version,
      source: installed.success.source,
      executablePath: installed.success.executablePath,
    });
    return installed.success;
  });

  reconcileConfig = Effect.fn("CloudManagedEndpointRuntime.reconcileConfig")(function* (config) {
    if (!config || config.providerKind !== "cloudflare_tunnel") {
      yield* stopActive;
      return config
        ? { status: "unsupported", providerKind: config.providerKind }
        : { status: "disabled" };
    }

    const nextConfigKey = runtimeConfigKey(config);
    const active = yield* Ref.get(activeRef);
    if (active?.configKey === nextConfigKey) {
      const isRunning = yield* active.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (isRunning) {
        return {
          status: "running",
          providerKind: "cloudflare_tunnel",
          pid: Number(active.child.pid),
          ...(active.config.tunnelId ? { tunnelId: active.config.tunnelId } : {}),
          ...(active.config.tunnelName ? { tunnelName: active.config.tunnelName } : {}),
        } satisfies CloudManagedEndpointRuntimeStatus;
      }
    }

    yield* stopActive;

    const resolved = yield* relayClient.resolve;
    const executable =
      resolved.status === "missing" ? yield* installRelayClient(resolved) : resolved;
    if (executable.status !== "available") {
      return {
        status: "failed",
        providerKind: "cloudflare_tunnel",
        failure: executable.status === "unsupported" ? "unsupported-platform" : "not-installed",
        reason:
          executable.status === "unsupported"
            ? `Relay client is unsupported on ${executable.platform}-${executable.arch}.`
            : "The relay client is not installed.",
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    const connectorScope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          executable.executablePath,
          ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
          {
            detached: false,
            env: {
              ...process.env,
              TUNNEL_TOKEN: config.connectorToken,
            },
            shell: false,
            stderr: "pipe",
            stdout: "pipe",
          },
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, connectorScope),
        Effect.tap((child) =>
          Effect.logInfo("Relay client process started; waiting for tunnel connection", {
            pid: Number(child.pid),
            tunnelId: config.tunnelId,
            tunnelName: config.tunnelName,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to start relay client", {
            cause,
            tunnelId: config.tunnelId,
            tunnelName: config.tunnelName,
          }).pipe(
            Effect.andThen(Scope.close(connectorScope, Exit.void).pipe(Effect.ignore)),
            Effect.as({
              status: "failed",
              providerKind: "cloudflare_tunnel",
              failure: "spawn-failed",
              reason: String(cause),
              ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
              ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
            } satisfies CloudManagedEndpointRuntimeStatus),
          ),
        ),
      );

    if ("status" in child && child.status === "failed") {
      return child;
    }

    if (!("status" in child)) {
      const connector = {
        child,
        scope: connectorScope,
        configKey: nextConfigKey,
        config,
        startedAtMillis: yield* Clock.currentTimeMillis,
        connected: yield* Ref.make(false),
        ownershipGeneration: yield* ownership.publish(Number(child.pid), executable.executablePath),
      } satisfies ActiveConnector;
      yield* Ref.set(activeRef, connector);
      yield* Effect.forkIn(observeConnectorOutput(connector), connectorScope);
      yield* Effect.forkIn(superviseConnector(connector), connectorScope);
      yield* Effect.forkIn(watchConnectorRegistration(connector), connectorScope);
      return {
        status: "running",
        providerKind: "cloudflare_tunnel",
        pid: Number(child.pid),
        ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
        ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
      } satisfies CloudManagedEndpointRuntimeStatus;
    }

    return {
      status: "failed",
      providerKind: "cloudflare_tunnel",
      failure: "spawn-failed",
      reason: "Relay client did not start.",
      ...(config.tunnelId ? { tunnelId: config.tunnelId } : {}),
      ...(config.tunnelName ? { tunnelName: config.tunnelName } : {}),
    } satisfies CloudManagedEndpointRuntimeStatus;
  });

  const applyConfig = Effect.fn("CloudManagedEndpointRuntime.applyConfig")(
    (config: RelayManagedEndpointRuntimeConfig | null) =>
      reconcileSemaphore.withPermits(1)(
        Effect.gen(function* () {
          // A real config change starts over with a fresh backoff. Recovery
          // that hands back the same tunnel and token must keep the delay, or
          // a crash-looping connector respawns on every recovery round trip.
          const desired = yield* Ref.get(desiredConfigRef);
          const unchanged =
            desired !== null &&
            config !== null &&
            runtimeConfigKey(desired) === runtimeConfigKey(config);
          if (!unchanged) {
            yield* Ref.set(restartDelayRef, 0);
          }
          yield* Ref.set(desiredConfigRef, config);
          return yield* reconcileConfig(config);
        }),
      ),
  );

  const runtime = CloudManagedEndpointRuntime.of({
    applyConfig,
    recoveryRequests: Stream.fromQueue(recoveryRequests),
    requestRecovery: (config) => Queue.offer(recoveryRequests, config).pipe(Effect.asVoid),
    tunnelConnected: Stream.fromQueue(tunnelConnections),
    withLinkStateLock: linkStateSemaphore.withPermits(1),
  });

  yield* Effect.addFinalizer(() => runtime.applyConfig(null));
  return runtime;
});

export const layer = Layer.effect(CloudManagedEndpointRuntime, make);
