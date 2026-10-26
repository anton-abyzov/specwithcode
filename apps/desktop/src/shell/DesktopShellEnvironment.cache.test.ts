// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and inspects the cache file on a real temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

const textEncoder = new TextEncoder();
const CACHE_FILE = "shell-environment.json";

function envOutput(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => [
      `__STUDIO_ENV_${name}_START__`,
      value,
      `__STUDIO_ENV_${name}_END__`,
    ])
    .join("\n");
}

function makeProcess(output: string): ChildProcessSpawner.ChildProcessHandle {
  const stdout = output.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

const commandName = (command: ChildProcess.Command) =>
  command._tag === "StandardCommand" ? command.command : "";

function makeStateDir(cache?: unknown): string {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shell-env-cache-"));
  if (cache !== undefined) {
    NodeFS.writeFileSync(NodePath.join(stateDir, CACHE_FILE), JSON.stringify(cache));
  }
  return stateDir;
}

/** Runs `effect` and returns the `cached` attribute of its installIntoProcess span. */
const cachedAttribute = <A>(effect: Effect.Effect<A>) => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return effect.pipe(
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.map(() =>
      spans
        .find((span) => span.name === "desktop.shellEnvironment.installIntoProcess")
        ?.attributes.get("cached"),
    ),
  );
};

const readCache = (stateDir: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, CACHE_FILE), "utf8")) as {
    readonly version: number;
    readonly shell: string;
    readonly environment: Record<string, string>;
  };

/**
 * Runs `body` with the service built over `env` as process.env. Every probe
 * waits for `gate` (open by default), so a test can hold the background
 * refresh while it inspects the values applied from the cache.
 */
function withShellEnvironment<A>(
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly stateDir: string;
    readonly handler: (command: ChildProcess.Command) => string;
    readonly gate?: Deferred.Deferred<void>;
  },
  body: (service: DesktopShellEnvironment.DesktopShellEnvironment["Service"]) => Effect.Effect<A>,
) {
  const layerEnvironment = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      platform: input.platform,
      stateDir: input.stateDir,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      (input.gate === undefined ? Effect.void : Deferred.await(input.gate)).pipe(
        Effect.map(() => makeProcess(input.handler(command))),
      ),
    ),
  );
  const program = Effect.gen(function* () {
    return yield* body(yield* DesktopShellEnvironment.DesktopShellEnvironment);
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer, layerSpawner)),
      ),
    ),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env;
      process.env = input.env;
      return previous;
    }),
    () => program,
    (previous) =>
      Effect.sync(() => {
        process.env = previous;
      }),
  );
}

describe("DesktopShellEnvironment cache", () => {
  it.effect("probes before returning and saves the result when macOS has no cache", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          handler: (command) => {
            commands.push(command);
            return envOutput({
              PATH: "/opt/homebrew/bin:/usr/bin",
              HOMEBREW_PREFIX: "/opt/homebrew",
            });
          },
        },
        (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            // No cache: the values are in place as soon as the install returns.
            assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
            assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
            yield* service.awaitInstalled;
          }),
      );

      assert.deepEqual(commands.map(commandName), ["/bin/zsh"]);
      assert.deepEqual(readCache(stateDir), {
        version: 1,
        shell: "/bin/zsh",
        environment: { PATH: "/opt/homebrew/bin:/usr/bin", HOMEBREW_PREFIX: "/opt/homebrew" },
      });
      // Windows has no POSIX mode bits; the profile ACL keeps the file private there.
      if (process.platform !== "win32") {
        const mode = NodeFS.statSync(NodePath.join(stateDir, CACHE_FILE)).mode & 0o777;
        assert.equal(mode, 0o600);
      }
    }),
  );

  it.effect("does not save a cache when the login shell returns no PATH", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          handler: (command) => {
            commands.push(command);
            return commandName(command) === "/bin/launchctl" ? "/usr/local/bin:/usr/bin" : "";
          },
        },
        (service) => service.installIntoProcess,
      );

      // Same as before the cache existed: the launchctl fallback still runs.
      assert.deepEqual(commands.map(commandName), ["/bin/zsh", "/bin/launchctl"]);
      assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
      assert.isFalse(NodeFS.existsSync(NodePath.join(stateDir, CACHE_FILE)));
    }),
  );

  it.effect("probes the refresh from the launch environment, not the cached values", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir({
        version: 1,
        shell: "/bin/zsh",
        environment: {
          PATH: "/opt/old/bin:/usr/bin",
          SSH_AUTH_SOCK: "/tmp/old-login.sock",
          HOMEBREW_PREFIX: "/opt/old",
        },
      });
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
      const probedWith: Array<Record<string, string | undefined> | undefined> = [];

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          // Like a login shell: it keeps what it inherits and prepends its own PATH.
          handler: (command) => {
            const inherited =
              command._tag === "StandardCommand" && command.options.extendEnv === false
                ? command.options.env
                : env;
            probedWith.push(inherited);
            const values: Record<string, string> = {
              PATH: `/opt/new/bin:${inherited?.PATH ?? ""}`,
            };
            if (inherited?.SSH_AUTH_SOCK) values.SSH_AUTH_SOCK = inherited.SSH_AUTH_SOCK;
            if (inherited?.HOMEBREW_PREFIX) values.HOMEBREW_PREFIX = inherited.HOMEBREW_PREFIX;
            return envOutput(values);
          },
        },
        (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            assert.equal(env.SSH_AUTH_SOCK, "/tmp/old-login.sock");
            yield* service.awaitInstalled;
          }),
      );

      assert.equal(probedWith.length, 1);
      assert.isUndefined(probedWith[0]?.SSH_AUTH_SOCK);
      assert.equal(probedWith[0]?.PATH, "/usr/bin:/bin");
      assert.isUndefined(env.SSH_AUTH_SOCK);
      assert.isUndefined(env.HOMEBREW_PREFIX);
      assert.notInclude(env.PATH ?? "", "/opt/old/bin");
      assert.deepEqual(readCache(stateDir).environment, { PATH: "/opt/new/bin:/usr/bin:/bin" });
    }),
  );

  it.effect("applies cached values at once and replaces them once the refresh finishes", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir({
        version: 1,
        shell: "/bin/zsh",
        environment: { PATH: "/opt/old/bin:/usr/bin", HOMEBREW_PREFIX: "/opt/old" },
      });
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
      const gate = yield* Deferred.make<void>();

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          gate,
          handler: () =>
            envOutput({ PATH: "/opt/new/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock" }),
        },
        (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            // The probe is still held at the gate: these came from the cache.
            assert.equal(env.PATH, "/opt/old/bin:/usr/bin:/bin");
            assert.equal(env.HOMEBREW_PREFIX, "/opt/old");
            assert.isUndefined(env.SSH_AUTH_SOCK);

            const awaited = yield* Ref.make(false);
            const waiter = yield* Effect.forkChild(
              service.awaitInstalled.pipe(Effect.andThen(Ref.set(awaited, true))),
            );
            yield* Effect.yieldNow;
            assert.isFalse(yield* Ref.get(awaited));

            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(waiter);
            assert.isTrue(yield* Ref.get(awaited));
          }),
      );

      // Recomputed from the launch environment: the stale entry and the
      // variable the shell no longer sets are gone.
      assert.equal(env.PATH, "/opt/new/bin:/usr/bin:/bin");
      assert.isUndefined(env.HOMEBREW_PREFIX);
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock");
      assert.deepEqual(readCache(stateDir).environment, {
        PATH: "/opt/new/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
      });
    }),
  );

  it.effect("keeps the cached values when the background refresh fails", () =>
    Effect.gen(function* () {
      const cache = {
        version: 1,
        shell: "/bin/zsh",
        environment: { PATH: "/opt/homebrew/bin:/usr/bin" },
      };
      const stateDir = makeStateDir(cache);
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          handler: (command) => {
            commands.push(command);
            return "";
          },
        },
        (service) => service.installIntoProcess.pipe(Effect.andThen(service.awaitInstalled)),
      );

      assert.deepEqual(commands.map(commandName), ["/bin/zsh"]);
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.deepEqual(readCache(stateDir), cache);
    }),
  );

  it.effect("keeps a variable that changed after the cached values went in", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir({
        version: 1,
        shell: "/bin/zsh",
        environment: { PATH: "/opt/old/bin:/usr/bin", HOMEBREW_PREFIX: "/opt/old" },
      });
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const gate = yield* Deferred.make<void>();

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          gate,
          handler: () => envOutput({ PATH: "/opt/new/bin:/usr/bin", HOMEBREW_PREFIX: "/opt/new" }),
        },
        (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            env.PATH = "/custom/bin:/usr/bin";
            yield* Deferred.succeed(gate, undefined);
            yield* service.awaitInstalled;
          }),
      );

      assert.equal(env.PATH, "/custom/bin:/usr/bin");
      assert.equal(env.HOMEBREW_PREFIX, "/opt/new");
    }),
  );

  it.effect("ignores a cache saved for a shell this launch would not probe", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir({
        version: 1,
        shell: "/opt/homebrew/bin/fish",
        environment: { PATH: "/opt/fish/bin:/usr/bin" },
      });
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const gate = yield* Deferred.make<void>();

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          gate,
          handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
        },
        (service) =>
          Effect.gen(function* () {
            // The probe blocks the install, so open the gate from another fiber.
            const install = yield* Effect.forkChild(service.installIntoProcess);
            yield* Effect.yieldNow;
            assert.equal(env.PATH, "/usr/bin");
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(install);
            assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
          }),
      );

      assert.equal(readCache(stateDir).shell, "/bin/zsh");
    }),
  );

  it.effect("ignores an unreadable cache and probes as on a first run", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      NodeFS.writeFileSync(NodePath.join(stateDir, CACHE_FILE), "{not json");
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
        },
        (service) => service.installIntoProcess,
      );

      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.equal(readCache(stateDir).environment.PATH, "/opt/homebrew/bin:/usr/bin");
    }),
  );

  it.effect("keeps the blocking probe on Linux and neither reads nor writes a cache", () =>
    Effect.gen(function* () {
      const cache = { version: 1, shell: "/bin/bash", environment: { PATH: "/opt/old/bin" } };
      const stateDir = makeStateDir(cache);
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };

      yield* withShellEnvironment(
        {
          env,
          platform: "linux",
          stateDir,
          handler: () => envOutput({ PATH: "/home/test/.local/bin:/usr/bin" }),
        },
        (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            assert.equal(env.PATH, "/home/test/.local/bin:/usr/bin");
            yield* service.awaitInstalled;
          }),
      );

      assert.deepEqual(readCache(stateDir), cache);
    }),
  );

  it.effect("marks the installIntoProcess span with whether the cache was used", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      const run = () =>
        withShellEnvironment(
          {
            env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
            platform: "darwin",
            stateDir,
            handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
          },
          (service) =>
            cachedAttribute(service.installIntoProcess).pipe(
              Effect.tap(() => service.awaitInstalled),
            ),
        );

      // The first launch probes and saves; the second applies the cache.
      assert.isFalse(yield* run());
      assert.isTrue(yield* run());
    }),
  );

  it.effect("removes its temp file when the cache cannot be renamed into place", () =>
    Effect.gen(function* () {
      const stateDir = makeStateDir();
      // A directory where the cache file belongs: reading and renaming both fail.
      NodeFS.mkdirSync(NodePath.join(stateDir, CACHE_FILE));
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

      yield* withShellEnvironment(
        {
          env,
          platform: "darwin",
          stateDir,
          handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
        },
        (service) => service.installIntoProcess,
      );

      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.deepEqual(NodeFS.readdirSync(stateDir), [CACHE_FILE]);
    }),
  );

  it.effect("returns from awaitInstalled at once when nothing was installed", () =>
    withShellEnvironment(
      {
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        platform: "darwin",
        stateDir: makeStateDir(),
        handler: () => "",
      },
      (service) => service.awaitInstalled,
    ),
  );
});
