import type { AcpRegistrySettings } from "@specweave-studio/contracts";
import { AcpRequestError, AcpSpawnError } from "@specweave-studio/effect-acp/errors";
import * as Effect from "effect/Effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import type { ResolvedAcpRegistryAgent } from "./AcpRegistrySupport.ts";
import type {
  AcpSpawnInput,
  AcpSessionRuntime,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntime.ts";

/** Exact packaged CLI audited: cli-main.js buildBootOptions forwards options.model to ACP. */
export const COPILOT_STARTUP_MODEL_VERSION = "1.0.97";
const isExplicitModel = (model: string | undefined): model is string =>
  model !== undefined && model !== "" && model !== "default" && model !== "auto";
const seededRuntimes = new WeakSet<AcpSessionRuntime["Service"]>();

/** Explicit user default selection, never an error fallback. */
export const resetCopilotStartupModel = Effect.fn("resetCopilotStartupModel")(function* (
  runtime: AcpSessionRuntime["Service"],
) {
  if (!seededRuntimes.has(runtime)) return false;
  yield* runtime.setSessionModel("auto");
  return true;
});

export function isCopilotStartupModelCandidate(
  settings: AcpRegistrySettings,
  resolved: ResolvedAcpRegistryAgent,
  model: string | undefined,
): model is string {
  return (
    settings.source !== "local" &&
    settings.commandPath.trim() === "" &&
    settings.agentId === "github-copilot-cli" &&
    resolved.agent?.id === "github-copilot-cli" &&
    resolved.distribution === "npx" &&
    resolved.agent.distribution.npx?.package.startsWith("@github/copilot@") === true &&
    isExplicitModel(model)
  );
}

export function isAuditedCopilotVersion(output: string): boolean {
  return /^(?:GitHub Copilot CLI\s+)?1\.0\.97\.?$/u.test(output.trim().split(/\r?\n/u)[0] ?? "");
}

export function supportsCopilotStartupModel(version: string, help: string): boolean {
  return isAuditedCopilotVersion(version) && /(?:^|\s)--model(?:[=\s]|$)/u.test(help);
}

const modelFailure = (message: string) =>
  new AcpRequestError({ method: "session/new", code: -32602, errorMessage: message });

/** Return confirmation only from native setup; never synthesize a model or catalog. */
export function confirmCopilotStartupModel(
  started: AcpSessionRuntimeStartResult,
  requested: string,
): Effect.Effect<boolean, AcpRequestError> {
  return Effect.gen(function* () {
    const agent = started.initializeResult.agentInfo;
    if (agent?.name !== "Copilot" || agent.version !== COPILOT_STARTUP_MODEL_VERSION) {
      return yield* modelFailure(
        "Copilot changed after model capability verification. Refresh the provider before retrying.",
      );
    }
    const setup = started.sessionSetupResult;
    const observed = [
      ...(setup.models == null ? [] : [setup.models.currentModelId]),
      ...(setup.configOptions ?? [])
        .filter((option) => option.category === "model")
        .map((option) => option.currentValue),
    ];
    if (observed.some((current) => current !== requested)) {
      return yield* modelFailure(
        `Copilot did not start with the requested model '${requested}'. Native model selection was '${observed.join(", ")}'. No fallback was used.`,
      );
    }
    return observed.length > 0;
  });
}

/**
 * Consume a confirmed startup selection once. Later setters and activations
 * remain native operations, including rejection and switching back to this model.
 */
export function acknowledgeCopilotStartupModel(
  runtime: AcpSessionRuntime["Service"],
  model: string,
): AcpSessionRuntime["Service"] {
  let inspected = false;
  let pending = false;
  const invalidate = Effect.sync(() => {
    pending = false;
  });
  const consume = (requested: string) =>
    Effect.sync(() => {
      const confirmed = pending && requested === model;
      pending = false;
      return confirmed;
    });
  const wrapped: AcpSessionRuntime["Service"] = {
    ...runtime,
    start: () =>
      runtime.start().pipe(
        Effect.tap((started) =>
          Effect.gen(function* () {
            if (inspected) return;
            pending = yield* confirmCopilotStartupModel(started, model);
            inspected = true;
          }),
        ),
      ),
    setModel: (requested) =>
      consume(requested).pipe(
        Effect.flatMap((confirmed) => (confirmed ? Effect.void : runtime.setModel(requested))),
      ),
    setSessionModel: (requested) =>
      consume(requested).pipe(
        Effect.flatMap((confirmed) =>
          confirmed ? Effect.succeed({}) : runtime.setSessionModel(requested),
        ),
      ),
    setConfigOption: (...args) => invalidate.pipe(Effect.andThen(runtime.setConfigOption(...args))),
    loadSession: (...args) => invalidate.pipe(Effect.andThen(runtime.loadSession(...args))),
    resumeSession: (...args) => invalidate.pipe(Effect.andThen(runtime.resumeSession(...args))),
    forkSession: (...args) => invalidate.pipe(Effect.andThen(runtime.forkSession(...args))),
  };
  seededRuntimes.add(wrapped);
  return wrapped;
}

export const prepareCopilotStartupModel = Effect.fn("prepareCopilotStartupModel")(
  function* (input: {
    readonly settings: AcpRegistrySettings;
    readonly resolved: ResolvedAcpRegistryAgent;
    readonly model: string | undefined;
    readonly resumeSessionId?: string;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  }) {
    const { settings, resolved, model } = input;
    // Existing sessions keep their native model/switching contract. This option
    // seeds new sessions; it is not a way to rewrite a resumed session's model.
    if (
      input.resumeSessionId !== undefined ||
      !isCopilotStartupModelCandidate(settings, resolved, model)
    ) {
      return undefined;
    }
    const spawn = resolved.spawn;
    const fail = (detail: string) =>
      new AcpSpawnError({ command: spawn.command, cause: new Error(detail) });
    if (spawn.args.some((arg) => arg === "--" || arg === "--model" || arg.startsWith("--model="))) {
      return yield* fail(
        "Copilot launch arguments already override model parsing. Remove the override before selecting a Studio model.",
      );
    }
    const args = spawn.args.filter((arg) => arg !== "--acp" && arg !== "--stdio");
    if (!args.includes("--no-auto-update")) args.unshift("--no-auto-update");
    const probe = (flag: "--version" | "--help") =>
      Effect.gen(function* () {
        const child = yield* input.spawner.spawn(
          ChildProcess.make(spawn.command, [...args, flag], {
            cwd: spawn.cwd,
            env: spawn.env,
            extendEnv: spawn.extendEnv ?? true,
            shell: false,
            stdin: "ignore",
            forceKillAfter: "1 second",
          }),
        );
        yield* Effect.addFinalizer(() =>
          child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore),
        );
        const [stdout, stderr, exit] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 32_768 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 32_768 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(exit) !== 0 || stdout.truncated || stderr.truncated) {
          return yield* fail(
            "Copilot model capability verification failed. No ACP session was started.",
          );
        }
        return stdout.text + stderr.text;
      }).pipe(
        Effect.scoped,
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new AcpSpawnError({ command: spawn.command, cause })),
      );
    const version = yield* probe("--version");
    // Unverified versions retain their existing native selection path.
    if (!isAuditedCopilotVersion(version)) return undefined;
    const help = yield* probe("--help");
    if (!supportsCopilotStartupModel(version, help)) {
      return yield* fail(
        "This Copilot executable does not advertise --model. No ACP session was started.",
      );
    }
    return {
      spawn: {
        ...spawn,
        shell: false,
        args: [...args, `--model=${model}`, "--acp", "--stdio"],
      } satisfies AcpSpawnInput,
      acknowledge: (runtime: AcpSessionRuntime["Service"]) =>
        acknowledgeCopilotStartupModel(runtime, model),
    };
  },
);
