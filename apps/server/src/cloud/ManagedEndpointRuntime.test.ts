import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { RelayManagedEndpointRuntimeConfig } from "@specweave-studio/contracts/relay";
import * as RelayClient from "@specweave-studio/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as RelayProcessOwnership from "./RelayProcessOwnership.ts";

const layerRelayClientAvailable = Layer.succeed(
  RelayClient.RelayClient,
  RelayClient.RelayClient.of({
    resolve: Effect.succeed({
      status: "available",
      executablePath: "cloudflared",
      source: "path",
      version: RelayClient.CLOUDFLARED_VERSION,
    }),
    install: Effect.die("unused"),
    installWithProgress: () => Effect.die("unused"),
  }),
);

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  ownership: RelayProcessOwnership.RelayProcessOwnership["Service"] = {
    publish: () => Effect.succeed(null),
    clear: () => Effect.void,
  },
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientLayer,
    Layer.succeed(RelayProcessOwnership.RelayProcessOwnership, ownership),
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeedNone,
    }),
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  ownership: RelayProcessOwnership.RelayProcessOwnership["Service"] = {
    publish: () => Effect.succeed(null),
    clear: () => Effect.void,
  },
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer, ownership)),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

function makeHandle(input: {
  readonly pid: number;
  readonly onKill: () => void;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly output?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: input.output ?? Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it("retries connector startup failures but stops for unsupported runtimes", () => {
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "not-installed",
        reason: "The relay client is not installed.",
      }),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "spawn-failed",
        reason: "spawn failed",
      }),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "unsupported-platform",
        reason: "Relay client is unsupported on linux-arm.",
      }),
    ).toBe(false);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({ status: "unsupported" }),
    ).toBe(false);
  });

  it.effect("records its actual spawn once and clears only that lifecycle generation", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeHandle({ pid: 700, onKill: () => {} })),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner, layerRelayClientAvailable, {
        publish: (pid, executable) =>
          Effect.sync(() => {
            calls.push(["publish", pid, executable]);
            return "generation-1";
          }),
        clear: (pid, generation) =>
          Effect.sync(() => {
            calls.push(["clear", pid, generation]);
          }),
      });
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "private-fixture-token",
      };
      expect((yield* runtime.applyConfig(config)).status).toBe("running");
      expect((yield* runtime.applyConfig(config)).status).toBe("running");
      expect(calls).toEqual([["publish", 700, "cloudflared"]]);
      yield* runtime.applyConfig(null);
      expect(calls).toEqual([
        ["publish", 700, "cloudflared"],
        ["clear", 700, "generation-1"],
      ]);
      expect(JSON.stringify(calls)).not.toContain(config.connectorToken);
    }),
  );

  it.effect("keeps the connector alive when ownership proof cannot be published", () =>
    Effect.gen(function* () {
      let stopped = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              stopped = true;
            }),
          );
          return makeHandle({
            pid: 701,
            onKill: () => {
              stopped = true;
            },
          });
        }),
      );
      const calls: unknown[] = [];
      // RelayProcessOwnership reports an unpublished proof as a null generation (helper
      // absent, failed or timed out); it never fails the effect.
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner, layerRelayClientAvailable, {
        publish: (pid, executable) =>
          Effect.sync(() => {
            calls.push(["publish", pid, executable]);
            return null;
          }),
        clear: (pid, generation) =>
          Effect.sync(() => {
            calls.push(["clear", pid, generation]);
          }),
      });
      expect(
        (yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "fixture",
        })).status,
      ).toBe("running");
      expect(stopped).toBe(false);
      expect(calls).toEqual([["publish", 701, "cloudflared"]]);
      yield* runtime.applyConfig(null);
      expect(stopped).toBe(true);
      // Nothing was published, so the stop clears no generation.
      expect(calls).toEqual([
        ["publish", 701, "cloudflared"],
        ["clear", 701, null],
      ]);
    }),
  );

  it.effect("serializes updates to persisted cloud link state", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() => Effect.die("unused")),
      );

      const first = yield* runtime
        .withLinkStateLock(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* runtime
        .withLinkStateLock(Deferred.succeed(secondEntered, undefined))
        .pipe(Effect.forkChild);
      expect(yield* Deferred.isDone(secondEntered)).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Deferred.isDone(secondEntered)).toBe(true);
    }),
  );

  it("classifies Cloudflare connection and warning output", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0",
      ),
    ).toBe("connected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z ERR Failed to serve tunnel connection",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Starting metrics server",
      ),
    ).toBe("debug");
    // FTL (fatal) and PNC (panic) are more severe than ERR and must surface.
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z FTL Cannot determine default origin certificate path",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput("2026-06-17T02:00:00Z PNC runtime panic"),
    ).toBe("warning");
  });

  it("recognizes tunnel authorization failures without matching ordinary transport errors", () => {
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-09-15T06:30:43Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=198.41.200.23',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="Unauthorized: Record for tunnel not found" connIndex=0',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="Unauthorized: Invalid tunnel secret" connIndex=0',
      ),
    ).toBe(true);
    // Seen in production on 2026-10-06 after the relay deleted an idle tunnel.
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-10-06T12:00:00Z ERR Register tunnel error from server side error="Unauthorized: Tunnel not found" connIndex=0 event=0 ip=198.41.200.23',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-10-06T12:00:00Z ERR Register tunnel error from server side error="Tunnel not found" connIndex=0',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="connection timed out" connIndex=0',
      ),
    ).toBe(false);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Failed to serve tunnel connection error="Unauthorized: Tunnel not found" connIndex=0',
      ),
    ).toBe(false);
  });

  it.effect("keeps recovery requests sent before the server starts consuming them", () =>
    Effect.gen(function* () {
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() => Effect.die("unused")),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      yield* runtime.requestRecovery(config);

      expect(Option.getOrNull(yield* Stream.runHead(runtime.recoveryRequests))).toEqual(config);
    }),
  );

  it.effect("signals each registered tunnel connection", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 700,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Queue.offer(
        output,
        new TextEncoder().encode(
          "2026-10-04T06:30:43Z INF Registered tunnel connection connIndex=0 event=0\n",
        ),
      );
      expect(Option.isSome(yield* Stream.runHead(runtime.tunnelConnected))).toBe(true);
    }),
  );

  it.effect("recovers a rejected tunnel without waiting for the connector to exit", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const firstBatchObserved = yield* Deferred.make<void>();
      const secondBatchObserved = yield* Deferred.make<void>();
      const recoveryRequested = yield* Deferred.make<RelayManagedEndpointRuntimeConfig>();
      const recoveryRetried = yield* Deferred.make<RelayManagedEndpointRuntimeConfig>();
      let recoveryRequestCount = 0;
      const spawned: Array<number> = [];
      const encoder = new TextEncoder();
      const connectorOutput = Stream.fromQueue(output).pipe(
        Stream.tap((chunk) => {
          const line = new TextDecoder().decode(chunk);
          if (line === "first checkpoint\n") {
            return Deferred.succeed(firstBatchObserved, undefined).pipe(Effect.asVoid);
          }
          if (line === "second checkpoint\n") {
            return Deferred.succeed(secondBatchObserved, undefined).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
      );
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 600;
          spawned.push(pid);
          const handle = makeHandle({ pid, onKill: () => {}, output: connectorOutput });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "deleted-tunnel",
      };
      const rejectedLine =
        '2026-09-15T06:30:43Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=198.41.200.23\n';

      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((requested) => {
          recoveryRequestCount += 1;
          return Deferred.succeed(
            recoveryRequestCount === 1 ? recoveryRequested : recoveryRetried,
            requested,
          ).pipe(Effect.asVoid);
        }),
        Effect.forkChild,
      );
      yield* runtime.applyConfig(config);

      yield* Queue.offer(output, encoder.encode(rejectedLine.repeat(3)));
      yield* Queue.offer(output, encoder.encode("first checkpoint\n"));
      yield* Deferred.await(firstBatchObserved);
      expect(yield* Deferred.isDone(recoveryRequested)).toBe(false);

      yield* Queue.offer(
        output,
        encoder.encode(
          "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0\n" +
            rejectedLine.repeat(3),
        ),
      );
      yield* Queue.offer(output, encoder.encode("second checkpoint\n"));
      yield* Deferred.await(secondBatchObserved);
      expect(yield* Deferred.isDone(recoveryRequested)).toBe(false);

      yield* Queue.offer(output, encoder.encode(rejectedLine));

      expect(yield* Deferred.await(recoveryRequested)).toEqual(config);

      yield* Queue.offer(output, encoder.encode(rejectedLine.repeat(4)));

      expect(yield* Deferred.await(recoveryRetried)).toEqual(config);
      expect(spawned).toEqual([600]);
    }),
  );

  it.effect("requests recovery while the connector never registers a connection", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 800,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const requests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((config) => Queue.offer(requests, config)),
        Effect.forkChild,
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "silently-deleted",
      };
      yield* runtime.applyConfig(config);

      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Queue.size(requests)).toBe(0);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* Queue.take(requests)).toEqual(config);
      // Still unconnected, so it asks again.
      yield* TestClock.adjust(Duration.minutes(3));
      expect(yield* Queue.take(requests)).toEqual(config);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not request recovery once the connector has connected", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 801,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const requests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((config) => Queue.offer(requests, config)),
        Effect.forkChild,
      );
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Queue.offer(
        output,
        new TextEncoder().encode(
          "2026-10-06T00:00:00Z INF Registered tunnel connection connIndex=0\n",
        ),
      );
      yield* Stream.runHead(runtime.tunnelConnected);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Queue.size(requests)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts, deduplicates, rotates, and stops the Cloudflare connector", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const killed: Array<number> = [];
      let nextPid = 100;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command);
          const pid = nextPid;
          nextPid += 1;
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "studio-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "studio-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
        tunnelId: "tunnel-1",
        tunnelName: "studio-code-env-1",
      });
      const stopped = yield* runtime.applyConfig(null);

      expect(spawned.map((command) => command.command)).toEqual(["cloudflared", "cloudflared"]);
      expect(spawned.map((command) => command.args)).toEqual([
        ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
        ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
      ]);
      expect(spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
        "token-1",
        "token-2",
      ]);
      expect(spawned.map((command) => command.options.stdout)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.stderr)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.detached)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.shell)).toEqual([false, false]);
      expect(killed).toEqual([100, 101]);
      expect(stopped).toEqual({ status: "disabled" });
    }),
  );

  it.effect("stops an active connector when a non-Cloudflare runtime config is applied", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 200,
            onKill: () => {
              killed.push(200);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const unsupported = yield* runtime.applyConfig({
        providerKind: "manual",
        connectorToken: "manual-token",
      });

      expect(started.status).toBe("running");
      expect(unsupported).toEqual({ status: "unsupported", providerKind: "manual" });
      expect(killed).toEqual([200]);
    }),
  );

  it.effect("restarts the connector when the active process has exited", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      let firstRunning = true;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 300 : 301;
          spawned.push(pid);
          const handle = makeHandle({
            pid,
            isRunning: () => (pid === 300 ? firstRunning : true),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      const first = yield* runtime.applyConfig(config);
      firstRunning = false;
      const second = yield* runtime.applyConfig(config);

      expect(first).toMatchObject({ status: "running", pid: 300 });
      expect(second).toMatchObject({ status: "running", pid: 301 });
      expect(spawned).toEqual([300, 301]);
      expect(killed).toEqual([300]);
    }),
  );

  it.effect("supervises the active connector and restarts it after process exit", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const secondSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 400 : 401;
          spawned.push(pid);
          if (pid === 401) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          const handle = makeHandle({
            pid,
            exitCode:
              pid === 400
                ? Deferred.await(firstExit)
                : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(secondSpawned);

      expect(started).toMatchObject({ status: "running", pid: 400 });
      expect(spawned).toEqual([400, 401]);
      expect(killed).toEqual([400]);
    }),
  );

  const makeCrashLoopSpawner = (basePid: number, slots: number) =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
      const spawnSignals: Array<Deferred.Deferred<void>> = [];
      for (let index = 0; index < slots; index += 1) {
        exits.push(yield* Deferred.make<ChildProcessSpawner.ExitCode>());
        spawnSignals.push(yield* Deferred.make<void>());
      }
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const index = spawned.length;
          spawned.push(basePid + index);
          yield* Deferred.succeed(spawnSignals[index]!, undefined);
          const handle = makeHandle({
            pid: basePid + index,
            exitCode: Deferred.await(exits[index]!),
            onKill: () => {},
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      return { spawner, spawned, exits, spawnSignals };
    });

  it.effect("backs off restarts while the connector crash-loops", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(600, 4);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      expect(spawned).toEqual([600]);

      // The first crash restarts immediately.
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);
      expect(spawned).toEqual([600, 601]);

      // The second rapid crash waits out the base delay before restarting.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([600, 601]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[2]!);
      expect(spawned).toEqual([600, 601, 602]);

      // The third rapid crash doubles the delay.
      yield* Deferred.succeed(exits[2]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(1999));
      expect(spawned).toEqual([600, 601, 602]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[3]!);
      expect(spawned).toEqual([600, 601, 602, 603]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets the backoff after the connector runs stably", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(700, 5);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      // One rapid crash arms the backoff.
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);

      // The replacement stays up past the stable-uptime window, so its exit
      // restarts immediately and the backoff starts over.
      yield* TestClock.adjust(Duration.millis(30_000));
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[2]!);
      yield* Deferred.succeed(exits[2]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[3]!);

      // The next rapid crash waits the base delay again, not a doubled one.
      yield* Deferred.succeed(exits[3]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([700, 701, 702, 703]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[4]!);
      expect(spawned).toEqual([700, 701, 702, 703, 704]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("a recovery that returns the same config keeps the crash backoff", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(900, 4);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "same-token",
        tunnelId: "same-tunnel",
      };
      // The startup consumer re-applies whatever the relay hands back. When the
      // relay confirms the current tunnel, that must not look like a config change.
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((requested) => runtime.applyConfig(requested).pipe(Effect.asVoid)),
        Effect.forkChild,
      );

      yield* runtime.applyConfig(config);
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);
      expect(spawned).toEqual([900, 901]);

      // Second rapid crash still waits out the base delay.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([900, 901]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[2]!);
      expect(spawned).toEqual([900, 901, 902]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an explicit config change clears the backoff and preempts a delayed restart", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(800, 3);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
      });
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);

      // Leave the supervisor sleeping on the base delay, then change config.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
      });
      expect(status).toMatchObject({ status: "running", pid: 802 });
      expect(spawned).toEqual([800, 801, 802]);

      // The preempted supervisor wakes later and must not spawn a duplicate.
      yield* TestClock.adjust(Duration.millis(60_000));
      expect(spawned).toEqual([800, 801, 802]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("serializes concurrent connector config changes", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstSpawnEntered = yield* Deferred.make<void>();
      const releaseFirstSpawn = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 500 + spawned.length;
          spawned.push(pid);
          if (pid === 500) {
            yield* Deferred.succeed(firstSpawnEntered, undefined);
            yield* Deferred.await(releaseFirstSpawn);
          }
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const first = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSpawnEntered);
      const second = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-2",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseFirstSpawn, undefined);

      yield* Fiber.join(first);
      const status = yield* Fiber.join(second);

      expect(status).toMatchObject({ status: "running", pid: 501 });
      expect(spawned).toEqual([500, 501]);
      expect(killed).toEqual([500]);
    }),
  );

  it.effect("reports connector spawn failures", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared missing",
          }),
        ),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        tunnelId: "tunnel-1",
      });
    }),
  );

  const layerRelayClientMissing = (input: {
    readonly installs: Array<string>;
    readonly install: () => Effect.Effect<
      RelayClient.AvailableRelayClient,
      RelayClient.RelayClientInstallError
    >;
  }) => {
    let installed: RelayClient.AvailableRelayClient | null = null;
    return Layer.succeed(
      RelayClient.RelayClient,
      RelayClient.RelayClient.of({
        resolve: Effect.sync(
          (): RelayClient.RelayClientStatus =>
            installed ?? { status: "missing", version: RelayClient.CLOUDFLARED_VERSION },
        ),
        install: Effect.die("unused"),
        installWithProgress: (report) =>
          Effect.gen(function* () {
            input.installs.push(RelayClient.CLOUDFLARED_VERSION);
            yield* report({ type: "progress", stage: "downloading" });
            installed = yield* input.install();
            return installed;
          }),
      }),
    );
  };

  const managedRelayClient: RelayClient.AvailableRelayClient = {
    status: "available",
    executablePath: `/base/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/darwin-arm64/cloudflared`,
    source: "managed",
    version: RelayClient.CLOUDFLARED_VERSION,
  };

  it.effect("installs a missing relay client and then starts the connector", () =>
    Effect.gen(function* () {
      const installs: Array<string> = [];
      const commands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped");
          return makeHandle({ pid: 1200, onKill: () => {} });
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        layerRelayClientMissing({ installs, install: () => Effect.succeed(managedRelayClient) }),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      expect(yield* runtime.applyConfig(config)).toEqual({
        status: "running",
        providerKind: "cloudflare_tunnel",
        pid: 1200,
        tunnelId: "tunnel-1",
      });
      expect(installs).toEqual([RelayClient.CLOUDFLARED_VERSION]);
      expect(commands).toEqual([managedRelayClient.executablePath]);

      // Once installed, the same config keeps running without another install.
      expect((yield* runtime.applyConfig(config)).status).toBe("running");
      expect(installs).toHaveLength(1);
    }),
  );

  it.effect("reports a failed relay client install and backs off before retrying", () =>
    Effect.gen(function* () {
      const installs: Array<string> = [];
      const spawn = vi.fn(() => Effect.succeed(makeHandle({ pid: 1300, onKill: () => {} })));
      let reachable = false;
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(spawn),
        layerRelayClientMissing({
          installs,
          install: () =>
            reachable
              ? Effect.succeed(managedRelayClient)
              : Effect.fail(
                  new RelayClient.RelayClientInstallError({
                    reason: "download_failed",
                    message: "Could not download the relay client.",
                  }),
                ),
        }),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
      };
      const notInstalled = {
        status: "failed",
        providerKind: "cloudflare_tunnel",
        failure: "not-installed",
        reason: "The relay client is not installed.",
      };

      expect(yield* runtime.applyConfig(config)).toEqual(notInstalled);
      expect(installs).toHaveLength(1);
      expect(spawn).not.toHaveBeenCalled();
      // The failure stays retryable, so the link keeps asking.
      expect(ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus(notInstalled)).toBe(
        true,
      );

      // Startup retries inside the backoff window do not download again.
      reachable = true;
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* runtime.applyConfig(config)).toEqual(notInstalled);
      yield* TestClock.adjust(Duration.millis(4 * 60_000 + 29_999));
      expect(yield* runtime.applyConfig(config)).toEqual(notInstalled);
      expect(installs).toHaveLength(1);

      // Once the window passes, the next retry installs and starts the connector.
      yield* TestClock.adjust(Duration.millis(1));
      expect(yield* runtime.applyConfig(config)).toMatchObject({
        status: "running",
        pid: 1300,
      });
      expect(installs).toHaveLength(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("doubles the relay client install backoff after each consecutive failure", () =>
    Effect.gen(function* () {
      const installs: Array<string> = [];
      let reason: RelayClient.RelayClientInstallError["reason"] = "download_failed";
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ pid: 1400, onKill: () => {} }))),
        layerRelayClientMissing({
          installs,
          install: () =>
            Effect.fail(
              new RelayClient.RelayClientInstallError({ reason, message: "Install failed." }),
            ),
        }),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
      };
      const minute = 60_000;

      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(1);

      // Second attempt after 5 minutes; the next one waits 10.
      yield* TestClock.adjust(Duration.minutes(5));
      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(2);
      yield* TestClock.adjust(Duration.millis(10 * minute - 1));
      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(2);

      // A failure a retry will not fix soon waits at least the longer floor.
      reason = "invalid_checksum";
      yield* TestClock.adjust(Duration.millis(1));
      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(3);
      yield* TestClock.adjust(Duration.millis(60 * minute - 1));
      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(3);
      yield* TestClock.adjust(Duration.millis(1));
      yield* runtime.applyConfig(config);
      expect(installs).toHaveLength(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("caps the relay client install backoff and floors persistent failures", () => {
    const minute = 60_000;
    const delay = ManagedEndpointRuntime.relayClientInstallRetryDelayMillis;
    expect(delay(1, "download_failed")).toBe(5 * minute);
    expect(delay(2, "timeout")).toBe(10 * minute);
    expect(delay(3, "install_locked")).toBe(20 * minute);
    expect(delay(1, "invalid_checksum")).toBe(60 * minute);
    expect(delay(1, "validation_failed")).toBe(60 * minute);
    expect(delay(1, "override_missing")).toBe(60 * minute);
    expect(delay(5, "validation_failed")).toBe(80 * minute);
    expect(delay(8, "write_failed")).toBe(6 * 60 * minute);
    expect(delay(40, "download_failed")).toBe(6 * 60 * minute);
  });

  it.effect("reports an unsupported platform without installing or spawning", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const installWithProgress = vi.fn(() => Effect.die("unused"));
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(spawn),
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "unsupported",
              platform: "linux",
              arch: "arm",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused"),
            installWithProgress,
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toEqual({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        failure: "unsupported-platform",
        reason: "Relay client is unsupported on linux-arm.",
      });
      expect(installWithProgress).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});
