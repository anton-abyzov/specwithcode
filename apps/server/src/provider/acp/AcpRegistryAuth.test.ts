import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AcpRegistrySettings,
  ProviderInstanceId,
  type ProviderAuthState,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as AcpSchema from "@specweave-studio/effect-acp/compat";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { makeAcpRegistryAuth, type AcpRegistryCredential } from "./AcpRegistryAuth.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const instanceId = ProviderInstanceId.make("acp-auth-test");
const browserMethod = { id: "browser", name: "Browser", type: "agent" as const };
const terminalMethod = {
  id: "terminal",
  name: "Terminal",
  type: "terminal" as const,
  args: ["login"],
  env: { LOGIN: "yes", OVERRIDE: "method" },
};
const resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent = {
  agent: {
    id: "test-agent",
    name: "Test",
    version: "1.0.0",
    description: "Test",
    distribution: {},
  },
  distribution: "binary",
  spawn: {
    command: "/managed/agent",
    args: ["--acp"],
    env: { OVERRIDE: "spawn", AGENT_HOME: "/custom/home" },
  },
};
const catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"] = {
  inspect: () =>
    Effect.succeed({
      status: "ready",
      agentId: "test-agent",
      version: "1.0.0",
      distribution: "binary",
    }),
  resolve: () => Effect.succeed(resolved),
  search: () => Effect.die("unused"),
  prepare: () => Effect.die("unused"),
  uninstallManagedBinary: () => Effect.die("unused"),
};

const makeHarness = (
  method: AcpSchema.AuthMethod,
  failVerification = false,
  settings = decodeSettings({ agentId: "test-agent" }),
  providerInstanceId = instanceId,
  preflight: { help?: string; version?: string; hang?: boolean; noopExit?: number } = {},
  credentials = false,
  extra: { environment?: NodeJS.ProcessEnv; canSave?: boolean } = {},
) =>
  Effect.gen(function* () {
    const verify = yield* Deferred.make<void>();
    const changed: boolean[] = [];
    const closed: number[] = [];
    const authenticated: string[] = [];
    const authenticatedMeta: unknown[] = [];
    const saved: AcpRegistryCredential[] = [];
    const started: number[] = [];
    let runtimes = 0;
    let version = "1.0.0";
    let terminalSpawn: PtyAdapter.PtySpawnInput | undefined;
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let killed = false;
    let closedBeforeTerminal = false;
    const written: string[] = [];
    const sizes: number[][] = [];
    const preflightStarted = yield* Deferred.make<void>();
    const preflightCommands: ReadonlyArray<string>[] = [];
    let preflightCleanups = 0;
    const copilot = settings.source !== "local" && settings.agentId === "github-copilot-cli";
    const preflightSpawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        assert.isTrue(ChildProcess.isStandardCommand(command));
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("invalid fixture command");
        assert.strictEqual(command.options.forceKillAfter, "1 second");
        preflightCommands.push(command.args);
        yield* Deferred.succeed(preflightStarted, undefined);
        const help = command.args.includes("--help");
        const version = command.args.includes("--version");
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_001),
          exitCode: preflight.hang
            ? Effect.never
            : Effect.succeed(
                ChildProcessSpawner.ExitCode(help || version ? 0 : (preflight.noopExit ?? 0)),
              ),
          isRunning: Effect.succeed(preflight.hang === true),
          kill: (options) =>
            Effect.sync(() => {
              assert.strictEqual(options?.forceKillAfter, "1 second");
              preflightCleanups++;
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(
            new TextEncoder().encode(
              help
                ? (preflight.help ?? "  --device-code  Use device authorization\n")
                : version
                  ? (preflight.version ?? "1.0.95")
                  : "",
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const controller = yield* makeAcpRegistryAuth({
      instanceId: providerInstanceId,
      settings,
      cwd: "/workspace",
      environment: { PATH: "/tools", OVERRIDE: "base", ...extra.environment },
      ...(extra.canSave === undefined ? {} : { canSaveCredential: Effect.succeed(extra.canSave) }),
      onChanged: (value) =>
        Effect.sync(() => {
          changed.push(value);
        }),
      ...(credentials
        ? {
            saveCredential: (credential: AcpRegistryCredential) =>
              Effect.sync(() => {
                saved.push(credential);
              }),
          }
        : {}),
      makeRuntime: () =>
        Effect.gen(function* () {
          const id = ++runtimes;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(id);
            }),
          );
          const initialized: AcpSchema.InitializeResponse = {
            protocolVersion: 2,
            agentCapabilities: {},
            authMethods: [{ ...method, name: `${method.name} ${version}` }],
          };
          let elicitation:
            | Parameters<AcpSessionRuntime["Service"]["handleElicitation"]>[0]
            | undefined;
          return {
            initialize: () => Effect.succeed(initialized),
            handleElicitation: (handler) =>
              Effect.sync(() => {
                elicitation = handler;
              }),
            authenticate: (methodId, meta) =>
              Effect.gen(function* () {
                authenticated.push(methodId);
                authenticatedMeta.push(meta);
                // An API-key method reads its key from the environment, not a browser.
                if (elicitation && !meta && methodId !== "gemini-api-key")
                  yield* elicitation(
                    {
                      mode: "url",
                      url: "https://example.com/login",
                      elicitationId: "consent",
                      requestId: "login",
                      message: "Sign in",
                    },
                    { requestId: "login", method: "elicitation/create" },
                  );
              }),
            start: () =>
              Effect.gen(function* () {
                started.push(id);
                yield* Deferred.await(verify);
                if (failVerification)
                  return yield* new AcpRequestError({
                    method: "session/new",
                    code: -32000,
                    errorMessage: "Authentication required",
                  });
                return {
                  sessionId: "verified",
                  initializeResult: initialized,
                  sessionSetupResult: { sessionId: "verified" },
                  modelConfigId: undefined,
                };
              }),
            logout: Effect.succeed({}),
          };
        }),
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
        ...catalog,
        resolve: () =>
          Effect.succeed(
            copilot
              ? {
                  ...resolved,
                  agent: {
                    id: "github-copilot-cli",
                    name: "GitHub Copilot",
                    description: "Fixture",
                    distribution: {},
                    version: "1.0.95",
                  },
                  spawn: { ...resolved.spawn, args: ["--no-auto-update", "--acp"] },
                }
              : resolved,
          ),
        inspect: () =>
          Effect.sync(() => ({
            status: "ready" as const,
            agentId: "test-agent",
            version,
            distribution: "binary" as const,
          })),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, preflightSpawner),
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            terminalSpawn = input;
            closedBeforeTerminal = closed.includes(runtimes);
            return {
              pid: 123,
              write: (input) => {
                written.push(input);
              },
              resize: (cols, rows) => {
                sizes.push([cols, rows]);
              },
              kill: () => {
                killed = true;
              },
              onData: (callback) => {
                data = callback;
                return () => {
                  data = undefined;
                };
              },
              onExit: (callback) => {
                exit = callback;
                return () => {
                  exit = undefined;
                };
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    const phase = (phase: ProviderAuthState["phase"]) => state((value) => value.phase === phase);
    yield* state((value) => (value.methods?.length ?? 0) > 0);
    return {
      controller,
      verify,
      changed,
      closed,
      authenticated,
      authenticatedMeta,
      saved,
      started,
      phase,
      state,
      terminalSpawn: () => terminalSpawn,
      closedBeforeTerminal: () => closedBeforeTerminal,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      killed: () => killed,
      written,
      sizes,
      preflightCommands,
      preflightStarted,
      preflightCleanups: () => preflightCleanups,
      runtimes: () => runtimes,
      setVersion: (value: string) => {
        version = value;
      },
    };
  }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));

it.effect(
  "runs Copilot legacy login only after explicit start and verifies the fresh session",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        id: "copilot-login",
        name: "Log in with Copilot CLI",
        _meta: { "terminal-auth": { command: "/managed/copilot-native", args: ["login"] } },
      });
      assert.isUndefined(h.terminalSpawn());
      assert.deepEqual(h.authenticated, []);
      yield* h.controller.start("owner", Effect.void, "copilot-login");
      yield* h.phase("waiting");
      assert.isTrue(h.closedBeforeTerminal());
      assert.deepEqual(h.terminalSpawn()?.args, ["login"]);
      assert.strictEqual(h.terminalSpawn()?.shell, "/managed/copilot-native");
      assert.deepEqual(h.terminalSpawn()?.env, {
        PATH: "/tools",
        OVERRIDE: "spawn",
        AGENT_HOME: "/custom/home",
      });
      h.exit(0);
      yield* h.phase("verifying");
      assert.deepEqual(h.changed, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.authenticated, []);
      assert.deepEqual(h.started, [3]);
      assert.deepEqual(h.changed, [true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps local credentials separate from a matching registry agent ID", () =>
  Effect.gen(function* () {
    const registry = yield* makeHarness(browserMethod);
    const local = yield* makeHarness(
      browserMethod,
      false,
      decodeSettings({ source: "local", commandPath: "/different/agent" }),
      ProviderInstanceId.make("test-agent"),
    );
    assert.deepEqual(registry.controller.credentialBinding, {
      owner: "provider",
      key: "acp:test-agent",
    });
    assert.deepEqual(local.controller.credentialBinding, {
      owner: "provider",
      key: "acp:local:test-agent",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "discovers methods without signing in, then waits for browser consent and session verification",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(browserMethod);
      assert.deepEqual(h.authenticated, []);
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.closed, [1]);
      const flow = yield* h.controller.start("owner", Effect.void, "browser");
      const waiting = yield* h.phase("waiting");
      assert.deepEqual(waiting.interaction, {
        type: "browser",
        id: "consent",
        url: "https://example.com/login",
        requiresConsent: true,
      });
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "consent",
        response: { type: "browser", action: "accept" },
      });
      yield* h.phase("verifying");
      assert.deepEqual(h.changed, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.authenticated, ["browser"]);
      assert.deepEqual(h.changed, [true]);
      assert.deepEqual(h.closed, [1, 2]);
      yield* h.controller.logout(Effect.void);
      assert.deepEqual(h.changed, [true, false]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "runs terminal auth directly with the resolved environment and reconnects to verify",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(terminalMethod);
      const flow = yield* h.controller.start("owner", Effect.void, "terminal");
      yield* h.phase("waiting");
      assert.isTrue(h.closedBeforeTerminal());
      assert.deepEqual(h.terminalSpawn(), {
        shell: "/managed/agent",
        args: ["--acp", "login"],
        cwd: "/workspace",
        cols: 80,
        rows: 24,
        env: { PATH: "/tools", OVERRIDE: "method", AGENT_HOME: "/custom/home", LOGIN: "yes" },
      });
      h.data("Enter code: ");
      const output = yield* h.state(
        (value) =>
          value.interaction?.type === "terminal" && value.interaction.output === "Enter code: ",
      );
      assert.strictEqual(
        output.interaction?.type === "terminal" && output.interaction.outputOffset,
        12,
      );
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "123\r", size: { cols: 100, rows: 30 } },
      });
      assert.deepEqual(h.written, ["123\r"]);
      assert.deepEqual(h.sizes, [[100, 30]]);
      h.exit(0);
      yield* h.phase("verifying");
      assert.isTrue(h.killed());
      assert.deepEqual(h.authenticated, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.started, [3]);
      assert.deepEqual(h.changed, [true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels the login PTY and rejects further terminal input", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(terminalMethod);
    const flow = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.controller.cancel("owner", flow.flowId!);
    assert.isTrue(h.killed());
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.changed, []);
    assert.strictEqual(
      (yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "late\r" },
      }).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not report authentication when post-login verification fails", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(terminalMethod, true);
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.exit(0);
    yield* h.phase("verifying");
    yield* Deferred.succeed(h.verify, undefined);
    yield* h.phase("failed");
    assert.deepEqual(h.changed, []);
    assert.isTrue(h.killed());
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes advertised methods after a registry version change without logging in", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(browserMethod);
    const count = h.runtimes();
    yield* h.controller.refreshMethods!;
    assert.strictEqual(h.runtimes(), count);
    h.setVersion("2.0.0");
    yield* h.controller.refreshMethods!;
    const state = yield* h.state((value) => value.methods?.[0]?.name === "Browser 2.0.0");
    assert.strictEqual(state.phase, "idle");
    assert.strictEqual(h.runtimes(), count + 1);
    assert.deepEqual(h.authenticated, []);
    assert.deepEqual(h.started, []);
    assert.deepEqual(h.closed, [1, 2]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const copilotMethod: AcpSchema.AuthMethod = {
  id: "copilot-login",
  name: "Log in with Copilot CLI",
  _meta: { "terminal-auth": { command: "/managed/copilot-native", args: ["login"] } },
};
const copilotSettings = decodeSettings({ agentId: "github-copilot-cli" });
const devicePrompt = (code: string) =>
  `To authenticate, visit https://github.com/login/device and enter code ${code}\nWaiting for authorization...\n`;

it.effect(
  "runs remote Copilot device login with a scoped browser override and keeps native consent prompts",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(copilotMethod, false, copilotSettings);
      assert.deepEqual(h.preflightCommands, []);
      const start = yield* h.controller.start("owner");
      yield* h.phase("waiting");
      assert.deepEqual(h.preflightCommands[0], ["--no-auto-update", "login", "--help"]);
      assert.deepEqual(h.terminalSpawn()?.args, ["--no-auto-update", "login", "--device-code"]);
      assert.strictEqual(h.terminalSpawn()?.env?.AGENT_HOME, "/custom/home");
      const override = JSON.parse(h.terminalSpawn()?.env?.COPILOT_DEBUG_BROWSER ?? "null");
      assert.deepEqual(override.slice(1), ["--eval", "process.exit(0)", "--"]);
      assert.strictEqual(h.terminalSpawn()?.env?.ELECTRON_RUN_AS_NODE, "1");
      h.data(devicePrompt("AAAA-1111").slice(0, 31));
      h.data(devicePrompt("AAAA-1111").slice(31));
      const codeState = yield* h.state(
        (s) => s.interaction?.type === "terminal" && !!s.interaction.deviceCode,
      );
      assert.strictEqual(codeState.authorizationUrl, null);
      assert.strictEqual(codeState.interaction?.type, "terminal");
      if (codeState.interaction?.type !== "terminal") return;
      assert.deepEqual(codeState.interaction.deviceCode, {
        url: "https://github.com/login/device",
        userCode: "AAAA-1111",
      });
      h.data("System keychain unavailable. Store token in plaintext config file? (y/N) ");
      yield* h.state(
        (s) =>
          s.interaction?.type === "terminal" &&
          s.interaction.output.includes("keychain unavailable"),
      );
      assert.deepEqual(h.written, []); // Never consent to storing credentials automatically.
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: start.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "n\r" },
      });
      assert.deepEqual(h.written, ["n\r"]);
      h.exit(0);
      yield* h.phase("verifying");
      assert.deepEqual(h.changed, []);
      yield* Deferred.succeed(h.verify, undefined);
      yield* h.phase("succeeded");
      assert.deepEqual(h.changed, [true]);
      assert.isTrue(h.killed());
      assert.strictEqual(h.preflightCleanups(), 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps concurrent environment codes private and resumes the owning flow after resubscription",
  () =>
    Effect.gen(function* () {
      const m1 = yield* makeHarness(
        copilotMethod,
        false,
        copilotSettings,
        ProviderInstanceId.make("m1-copilot"),
      );
      const m3 = yield* makeHarness(
        copilotMethod,
        false,
        copilotSettings,
        ProviderInstanceId.make("m3-copilot"),
      );
      const a = yield* m1.controller.start("owner");
      const b = yield* m3.controller.start("owner");
      yield* m1.phase("waiting");
      yield* m3.phase("waiting");
      m1.data(devicePrompt("AAAA-1111"));
      m3.data(devicePrompt("BBBB-2222"));
      yield* m1.state((s) => s.interaction?.type === "terminal" && !!s.interaction.deviceCode);
      yield* m3.state((s) => s.interaction?.type === "terminal" && !!s.interaction.deviceCode);
      const resumed = yield* m1.controller.start("owner");
      assert.strictEqual(resumed.flowId, a.flowId);
      assert.strictEqual(
        resumed.interaction?.type === "terminal" ? resumed.interaction.deviceCode?.userCode : null,
        "AAAA-1111",
      );
      const replay = yield* m3.controller
        .subscribe("owner")
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.strictEqual(
        replay.interaction?.type === "terminal" ? replay.interaction.deviceCode?.userCode : null,
        "BBBB-2222",
      );
      const other = yield* m1.controller
        .subscribe("different-client")
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.isNull(other.flowId);
      assert.isNull(other.interaction);
      assert.strictEqual(
        (yield* m1.controller.start("different-client").pipe(Effect.result))._tag,
        "Failure",
      );
      yield* m1.controller.cancel("owner", a.flowId!);
      assert.isTrue(m1.killed());
      assert.isFalse(m3.killed());
      assert.strictEqual((yield* m3.controller.start("owner")).flowId, b.flowId);
      const retry = yield* m1.controller.start("owner");
      yield* m1.phase("waiting");
      assert.notStrictEqual(retry.flowId, a.flowId);
      const retried = yield* m1.phase("waiting");
      assert.isUndefined(
        retried.interaction?.type === "terminal" ? retried.interaction.deviceCode : undefined,
      );
      assert.deepEqual(m1.changed, []);
      assert.deepEqual(m3.changed, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("expires the owned Copilot PTY and clears the code without authenticating", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(copilotMethod, false, copilotSettings);
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.data(devicePrompt("AAAA-1111"));
    yield* h.state((s) => s.interaction?.type === "terminal" && !!s.interaction.deviceCode);
    yield* TestClock.adjust("5 minutes");
    const expired = yield* h.phase("failed");
    assert.include(expired.message ?? "", "expired");
    assert.isNull(expired.interaction);
    assert.isTrue(h.killed());
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const unsupported of [
  { version: "1.0.94" },
  { version: "2.0.0" },
  { help: " --web-flow  Web login" },
  { noopExit: 1 },
]) {
  it.effect(
    `fails closed before login when device authorization cannot be safely prepared ${JSON.stringify(unsupported)}`,
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(
          copilotMethod,
          false,
          copilotSettings,
          instanceId,
          unsupported,
        );
        yield* h.controller.start("owner");
        const failed = yield* h.phase("failed");
        assert.include(failed.message ?? "", "retry device sign-in");
        assert.isUndefined(h.terminalSpawn());
        assert.deepEqual(h.changed, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("times out and cleans up a stuck capability check without starting login", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(copilotMethod, false, copilotSettings, instanceId, { hang: true });
    yield* h.controller.start("owner");
    yield* Deferred.await(h.preflightStarted);
    yield* TestClock.adjust("10 seconds");
    yield* h.phase("failed");
    assert.strictEqual(h.preflightCleanups(), 1);
    assert.isUndefined(h.terminalSpawn());
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps unrecognized device output in the terminal and never infers authentication", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(copilotMethod, false, copilotSettings);
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    h.data("Device login changed. Follow the native CLI instructions.\r\n");
    const state = yield* h.state(
      (s) => s.interaction?.type === "terminal" && s.interaction.output.includes("login changed"),
    );
    assert.isUndefined(
      state.interaction?.type === "terminal" ? state.interaction.deviceCode : undefined,
    );
    assert.strictEqual(state.phase, "waiting");
    assert.deepEqual(h.changed, []);
    h.exit(1);
    const failed = yield* h.phase("failed");
    assert.isNull(failed.interaction);
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("disposes only the owned Copilot PTY on service restart and starts a fresh flow", () =>
  Effect.gen(function* () {
    const serviceScope = yield* Scope.make();
    const before = yield* makeHarness(copilotMethod, false, copilotSettings).pipe(
      Effect.provideService(Scope.Scope, serviceScope),
    );
    const old = yield* before.controller.start("owner");
    yield* before.phase("waiting");
    before.data(devicePrompt("AAAA-1111"));
    yield* before.state((s) => s.interaction?.type === "terminal" && !!s.interaction.deviceCode);
    yield* Scope.close(serviceScope, Exit.void);
    assert.isTrue(before.killed());
    assert.deepEqual(before.changed, []);
    const after = yield* makeHarness(copilotMethod, false, copilotSettings);
    const fresh = yield* after.controller.start("owner");
    const waiting = yield* after.phase("waiting");
    assert.notStrictEqual(fresh.flowId, old.flowId);
    assert.isUndefined(
      waiting.interaction?.type === "terminal" ? waiting.interaction.deviceCode : undefined,
    );
    assert.deepEqual(after.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rechecks changed CLI capabilities after cancellation and allows a supported retry", () =>
  Effect.gen(function* () {
    const capabilities = { version: "1.0.97", help: " --device-code Device authorization" };
    const h = yield* makeHarness(copilotMethod, false, copilotSettings, instanceId, capabilities);
    const original = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.controller.cancel("owner", original.flowId!);
    capabilities.help = " --web-flow Web authorization";
    yield* h.controller.start("owner");
    const unsupported = yield* h.phase("failed");
    assert.include(unsupported.message ?? "", "retry device sign-in");
    assert.isNull(unsupported.interaction);
    capabilities.help = " --device-code Device authorization";
    capabilities.version = "1.0.98";
    const retry = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    assert.notStrictEqual(retry.flowId, original.flowId);
    assert.strictEqual(h.preflightCommands.filter((args) => args.includes("--help")).length, 3);
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const geminiApiKeyMethod = {
  id: "gemini-api-key",
  name: "Gemini API key",
  _meta: { "api-key": { provider: "google" } },
};

it.effect(
  "asks for a Gemini API key, verifies it with the agent and saves it on this machine",
  () =>
    Effect.gen(function* () {
      const key = "AIza-test-not-a-real-key";
      const h = yield* makeHarness(
        geminiApiKeyMethod,
        false,
        decodeSettings({ agentId: "gemini" }),
        instanceId,
        {},
        true,
      );
      const methods = yield* h.state((value) => (value.methods?.length ?? 0) > 0);
      assert.strictEqual(methods.methods?.[0]?.type, "credentials");
      const flow = yield* h.controller.start("owner", Effect.void, "gemini-api-key");
      const waiting = yield* h.phase("waiting");
      assert.deepEqual(waiting.interaction, {
        type: "credentials",
        id: "api-key",
        fields: [{ name: "api_key", label: "Gemini API key", secret: true }],
      });
      yield* h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "api-key",
        response: { type: "credentials", values: { api_key: `  ${key}  ` } },
      });
      const verifying = yield* h.phase("verifying");
      assert.notInclude(JSON.stringify(verifying), key);
      assert.deepEqual(h.saved, []);
      yield* Deferred.succeed(h.verify, undefined);
      const succeeded = yield* h.phase("succeeded");
      assert.notInclude(JSON.stringify(succeeded), key);
      assert.deepEqual(h.authenticated, ["gemini-api-key"]);
      assert.deepEqual(h.authenticatedMeta, [{ "api-key": key }]);
      assert.deepEqual(h.saved, [
        { envName: "GEMINI_API_KEY", value: key, authMethodId: "gemini-api-key" },
      ]);
      assert.deepEqual(h.changed, [true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not save a Gemini API key the agent rejects", () =>
  Effect.gen(function* () {
    const key = "AIza-rejected-test-key";
    const h = yield* makeHarness(
      geminiApiKeyMethod,
      true,
      decodeSettings({ agentId: "gemini" }),
      instanceId,
      {},
      true,
    );
    const flow = yield* h.controller.start("owner", Effect.void, "gemini-api-key");
    yield* h.phase("waiting");
    yield* h.controller.respond!("owner", {
      instanceId,
      flowId: flow.flowId!,
      interactionId: "api-key",
      response: { type: "credentials", values: { api_key: key } },
    });
    yield* Deferred.succeed(h.verify, undefined);
    const failed = yield* h.phase("failed");
    assert.notInclude(JSON.stringify(failed), key);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.changed, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an API-key method on the agent's own sign-in without a credential store", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(geminiApiKeyMethod, false, decodeSettings({ agentId: "gemini" }));
    const methods = yield* h.state((value) => (value.methods?.length ?? 0) > 0);
    assert.strictEqual(methods.methods?.[0]?.type, "agent");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses a GEMINI_API_KEY already set on this machine without asking for one", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      geminiApiKeyMethod,
      false,
      decodeSettings({ agentId: "gemini" }),
      instanceId,
      {},
      true,
      { environment: { GEMINI_API_KEY: "AIza-existing-test-key" } },
    );
    yield* h.controller.start("owner", Effect.void, "gemini-api-key");
    yield* h.phase("verifying");
    yield* Deferred.succeed(h.verify, undefined);
    yield* h.phase("succeeded");
    assert.deepEqual(h.authenticated, ["gemini-api-key"]);
    assert.deepEqual(h.authenticatedMeta, [undefined]);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.changed, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("sends no API key to the agent when it could not be saved afterwards", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      geminiApiKeyMethod,
      false,
      decodeSettings({ agentId: "gemini" }),
      instanceId,
      {},
      true,
      { canSave: false },
    );
    yield* h.controller.start("owner", Effect.void, "gemini-api-key");
    const failed = yield* h.phase("failed");
    assert.include(failed.message ?? "", "no longer set up");
    assert.deepEqual(h.authenticated, []);
    assert.deepEqual(h.saved, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
