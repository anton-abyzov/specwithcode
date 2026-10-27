import {
  ProviderSetupError,
  type AcpRegistrySettings,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveNodeExecutable } from "@specweave-studio/shared/nodeRuntime";
import type * as AcpSchema from "@specweave-studio/effect-acp/compat";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import * as ProviderAuthFlow from "../ProviderAuthFlow.ts";
import {
  acpApiKeyCredential,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryWebUrl,
} from "./AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  acpTerminalAuthInvocation,
  normalizeAcpTerminalAuthMethod,
} from "./AcpTerminalAuthentication.ts";
import {
  COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE,
  copilotBrowserNoopArgs,
  copilotBrowserOverride,
  copilotDeviceLoginArgs,
  isCopilotDeviceLogin,
  readCopilotDeviceCode,
  supportsCopilotDeviceLogin,
} from "./CopilotDeviceAuthentication.ts";

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "initialize" | "authenticate" | "start" | "handleElicitation" | "logout"
>;

/** An API key accepted at sign-in, stored as a secret environment variable on this instance. */
export interface AcpRegistryCredential {
  readonly envName: string;
  readonly value: string;
  readonly authMethodId: string;
}

/** ACP credentials stay in the agent's own store, using the same launch environment as chat. */
export const makeAcpRegistryAuth = Effect.fn("makeAcpRegistryAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void>;
  /** Persists an API-key sign-in on this machine only. Without it, API-key methods are not offered. */
  readonly saveCredential?: (
    credential: AcpRegistryCredential,
  ) => Effect.Effect<void, ProviderSetupError>;
  /** False when a key accepted now could not be saved, so none is sent. */
  readonly canSaveCredential?: Effect.Effect<boolean>;
  readonly makeRuntime?: (
    spawn: AcpSessionRuntime.AcpSpawnInput,
  ) => Effect.Effect<Runtime, ProviderSetupError, Scope.Scope>;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const coordinator = yield* Effect.serviceOption(
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
  );
  const agentKey =
    options.settings.source === "local" ? `local:${options.instanceId}` : options.settings.agentId;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const resolve = catalog
    .resolve(options.settings, options.cwd, options.environment)
    .pipe(
      Effect.mapError((cause) =>
        failure("start", "Could not prepare the selected ACP agent.", cause),
      ),
    );
  const makeRuntime =
    options.makeRuntime ??
    ((spawn) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn,
            cwd: options.cwd,
            authenticateOnAuthRequired: false,
            clientCapabilities: {
              auth: { terminal: Option.isSome(pty) },
              elicitation: { url: {} },
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "studio-code-provider-auth", version: "0.0.0" },
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      }).pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not start the selected ACP agent.", cause),
        ),
      ));

  let knownMethods:
    | { readonly version: string | null; readonly methods: ReadonlyArray<ProviderAuthMethod> }
    | undefined;
  const discoverMethods = Effect.scoped(
    Effect.gen(function* () {
      const inspected = yield* catalog
        .inspect(options.settings, options.environment)
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not inspect the selected ACP agent.", cause),
          ),
        );
      if (inspected.status !== "ready")
        return yield* failure("methods", "Prepare this ACP agent before signing in.");
      // An unversioned command (a path override) can change in place, so only
      // registry versions reuse earlier discovery.
      if (inspected.version !== null && knownMethods?.version === inspected.version)
        return knownMethods.methods;
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      const initialized = yield* runtime
        .initialize()
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not discover this agent's sign-in methods.", cause),
          ),
        );
      const apiKeyMethods = new Set(
        options.saveCredential
          ? (initialized.authMethods ?? []).flatMap((method) =>
              acpApiKeyCredential(method) ? [method.id] : [],
            )
          : [],
      );
      const advertised = normalizeAcpRegistryAuthMethods(initialized.authMethods)
        .filter(
          (method) => method.id.length <= 128 && (method.type !== "terminal" || Option.isSome(pty)),
        )
        .slice(0, 32)
        .map((method) => ({
          id: method.id,
          name: method.name,
          description: method.description,
          type:
            method.type === "env_var" || apiKeyMethods.has(method.id)
              ? ("credentials" as const)
              : method.type,
        }));
      knownMethods = { version: inspected.version, methods: advertised };
      return advertised;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(failure("methods", "The ACP agent did not advertise sign-in methods in time.")),
    }),
  );

  const methods = Option.isSome(coordinator)
    ? coordinator.value
        .runBackgroundProbe(agentKey, discoverMethods)
        .pipe(
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  failure(
                    "methods",
                    "Sign-in discovery was interrupted by an active provider session. Try again.",
                  ),
                ),
          ),
        )
    : discoverMethods;

  const runTerminal = Effect.fnUntraced(function* (
    resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent,
    method: AcpSchema.AuthMethod,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure(
        "start",
        "Interactive provider login is unavailable on this environment.",
      );
    let invocation = acpTerminalAuthInvocation(method, resolved.spawn);
    if (invocation === undefined)
      return yield* failure("start", "The agent advertised an invalid terminal sign-in command.");
    const deviceLogin = isCopilotDeviceLogin(options.settings, method.id);
    const environment = {
      ...options.environment,
      ...resolved.spawn.env,
      ...(method.type === "terminal" ? method.env : {}),
    };
    if (deviceLogin) {
      const args = copilotDeviceLoginArgs(invocation.args);
      if (!args) return yield* failure("start", COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE);
      const runPreflight = (command: string, args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              env: environment,
              stdin: "ignore",
              shell: false,
              forceKillAfter: "1 second",
            }),
          );
          yield* Effect.addFinalizer(() =>
            child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: 32_768 }),
              collectUint8StreamText({ stream: child.stderr, maxBytes: 32_768 }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (Number(exitCode) !== 0 || stdout.truncated || stderr.truncated)
            return yield* failure("start", COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE);
          return stdout.text + stderr.text;
        }).pipe(
          Effect.scoped,
          Effect.timeout("10 seconds"),
          Effect.mapError(() => failure("start", COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE)),
        );
      const help = yield* runPreflight(invocation.command, [
        ...args.filter((arg) => arg !== "--device-code"),
        "--help",
      ]);
      // Inspect the actual selected executable; a command override may differ
      // from the version in registry metadata.
      const versionOutput = yield* runPreflight(invocation.command, [
        ...args.slice(0, args.indexOf("login")),
        "--version",
      ]);
      const version = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(versionOutput)?.[1];
      if (!version || !supportsCopilotDeviceLogin(version, help))
        return yield* failure("start", COPILOT_DEVICE_LOGIN_UPDATE_MESSAGE);
      const node = yield* resolveNodeExecutable("Copilot sign-in", environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() =>
          failure(
            "start",
            "Copilot sign-in requires Node.js on this environment. Install Node.js and retry.",
          ),
        ),
      );
      // Copilot device login still opens a browser by default. Its argv override
      // is scoped to this login; the controlling client owns the browser action.
      environment.ELECTRON_RUN_AS_NODE = "1";
      environment.COPILOT_DEBUG_BROWSER = copilotBrowserOverride(node);
      yield* runPreflight(node, [
        ...copilotBrowserNoopArgs,
        "https://example.invalid/device-preflight",
      ]);
      invocation = { ...invocation, args };
    }
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: invocation.command,
        args: [...invocation.args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: environment,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the provider sign-in terminal.", cause),
        ),
      );
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* The login process may already have exited. */
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    let deviceCode: ReturnType<typeof readCopilotDeviceCode>;
    const update = () =>
      context.setInteraction(
        {
          type: "terminal",
          id: "terminal",
          output: transcript,
          outputOffset,
          ...(deviceCode ? { deviceCode } : {}),
        },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure("respond", "The provider sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        if (deviceLogin)
          deviceCode = readCopilotDeviceCode(transcript, invocation.args) ?? deviceCode;
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0)
      return yield* failure("start", "The provider login command did not finish successfully.");
  });

  const authenticate = (methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (!options.settings.enabled)
        return yield* failure("start", "Enable this provider before signing in.");
      let savedCredential: AcpRegistryCredential | undefined;
      const login = Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolve;
          const runtimeScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
          const runtime = yield* makeRuntime(resolved.spawn).pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
          );
          yield* runtime.handleElicitation((request) =>
            Effect.gen(function* () {
              if (
                request.mode !== "url" ||
                !("url" in request) ||
                !("elicitationId" in request) ||
                typeof request.url !== "string" ||
                typeof request.elicitationId !== "string"
              )
                return { action: "decline" } as const;
              const url = normalizeAcpRegistryWebUrl(request.url);
              const id = request.elicitationId.trim();
              if (!url || !id || id.length > 128) return { action: "decline" } as const;
              const consent = yield* Deferred.make<boolean>();
              yield* context.setInteraction(
                { type: "browser", id, url, requiresConsent: true },
                (response) =>
                  response.type === "browser"
                    ? Deferred.succeed(consent, response.action === "accept").pipe(Effect.asVoid)
                    : Effect.void,
              );
              return (yield* Deferred.await(consent))
                ? ({ action: "accept" } as const)
                : ({ action: "decline" } as const);
            }),
          );
          const initialized = yield* runtime
            .initialize()
            .pipe(
              Effect.mapError((cause) =>
                failure("start", "Could not initialize the selected ACP agent.", cause),
              ),
            );
          const method = initialized.authMethods?.find((method) => method.id === methodId);
          if (!method)
            return yield* failure("start", "The agent no longer advertises this sign-in method.");
          if (normalizeAcpTerminalAuthMethod(method).type === "terminal") {
            yield* Scope.close(runtimeScope, Exit.void);
            yield* runTerminal(resolved, method, context).pipe(Effect.scoped);
            // Terminal login is a separate invocation. Reconnect after it exits so
            // the ACP process reads the credentials its login command persisted.
            const verifiedRuntime = yield* makeRuntime(resolved.spawn);
            yield* context.verifying;
            yield* verifiedRuntime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after terminal sign-in.",
                    cause,
                  ),
                ),
              );
          } else if (options.saveCredential && acpApiKeyCredential(method)) {
            const credential = acpApiKeyCredential(method)!;
            if (!runtime.authenticate)
              return yield* failure("start", "This runtime does not support explicit ACP sign-in.");
            // A key already set for this instance or machine is used as is.
            if ((options.environment[credential.env]?.trim() ?? "").length > 0) {
              yield* context.verifying;
              yield* runtime
                .authenticate(methodId)
                .pipe(
                  Effect.mapError(() =>
                    failure(
                      "verify",
                      `${credential.label} did not accept the ${credential.env} already set on this machine.`,
                    ),
                  ),
                );
              yield* runtime
                .start()
                .pipe(
                  Effect.mapError(() =>
                    failure("verify", "The provider could not create a session with this API key."),
                  ),
                );
              return;
            }
            // Accepting a key switches the agent's sign-in mode on this machine,
            // so nothing is sent unless the key can be saved afterwards.
            if (options.canSaveCredential && !(yield* options.canSaveCredential))
              return yield* failure(
                "start",
                "This provider is no longer set up on this machine. Refresh and try again.",
              );
            const submitted = yield* Deferred.make<string>();
            yield* context.setInteraction(
              {
                type: "credentials",
                id: "api-key",
                fields: [{ name: "api_key", label: `${credential.label} API key`, secret: true }],
              },
              (response) => {
                if (response.type !== "credentials") return Effect.void;
                const value = response.values.api_key?.trim() ?? "";
                return value.length === 0
                  ? Effect.fail(failure("respond", "Enter an API key."))
                  : Deferred.succeed(submitted, value).pipe(Effect.asVoid);
              },
            );
            const apiKey = yield* Deferred.await(submitted);
            yield* context.verifying;
            // The agent keeps the key in memory for this connection only. The
            // error cause is dropped so an agent echo of the key is never logged.
            yield* runtime
              .authenticate(methodId, { "api-key": apiKey })
              .pipe(
                Effect.mapError(() =>
                  failure("verify", `${credential.label} did not accept this API key.`),
                ),
              );
            yield* runtime
              .start()
              .pipe(
                Effect.mapError(() =>
                  failure("verify", "The provider could not create a session with this API key."),
                ),
              );
            savedCredential = { envName: credential.env, value: apiKey, authMethodId: methodId };
          } else {
            if (method.type === undefined || method.type === "agent") {
              if (!runtime.authenticate)
                return yield* failure(
                  "start",
                  "This runtime does not support explicit ACP sign-in.",
                );
              yield* runtime
                .authenticate(methodId)
                .pipe(
                  Effect.mapError((cause) =>
                    failure("start", "The ACP agent could not complete sign-in.", cause),
                  ),
                );
            }
            // Legacy env_var methods use the secret-backed environment fields in
            // provider settings. Never send their ID to authenticate.
            yield* context.verifying;
            yield* runtime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after sign-in.",
                    cause,
                  ),
                ),
              );
          }
        }),
      );
      yield* Option.isSome(coordinator)
        ? coordinator.value.withForegroundStartup(agentKey, login)
        : login;
      // Saving changes provider settings, which rebuilds this instance, so it
      // runs only after the key is verified.
      if (savedCredential && options.saveCredential) yield* options.saveCredential(savedCredential);
      yield* options.onChanged(true);
    });
  const logout = Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      yield* runtime.logout.pipe(
        Effect.mapError((cause) =>
          failure(
            "logout",
            "This ACP agent could not sign out. It may not advertise logout support.",
            cause,
          ),
        ),
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(failure("logout", "The ACP agent did not finish signing out in time.")),
    }),
  );
  const signOut = (
    Option.isSome(coordinator) ? coordinator.value.withForegroundStartup(agentKey, logout) : logout
  ).pipe(Effect.andThen(options.onChanged(false)));
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // ACP doesn't advertise its credential scope. Conservatively treat all
    // instances of the same agent on this environment as sharing credentials.
    credentialBinding: { owner: "provider", key: `acp:${agentKey}` },
    methods,
    ...(options.settings.authMethodId ? { defaultMethodId: options.settings.authMethodId } : {}),
    authenticate,
    logout: signOut,
  });
});
