/**
 * Startup discovery for default-off providers. Once the server is up, every
 * discoverable driver the user never switched on or off gets one cheap probe
 * of its CLI: is it installed, and is it signed in. Drivers that are both are
 * turned on, and Settings says so with an Undo.
 *
 * A probe never logs in, opens a browser, reads a credential file or touches
 * the Keychain itself: it runs `--version` and one status command with stdin
 * closed and a hard timeout, and reads environment variables for presence only.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type DiscoverableProviderDriver, ServerSettingsService } from "../serverSettings.ts";
import { parseGrokModelsCliOutput } from "./GrokProvider.ts";
import { type CommandResult, isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";

export type ProviderDiscoveryState = "ready" | "signed-out" | "not-installed" | "unknown";

const VERSION_TIMEOUT_MS = 3_000;
// `opencode auth list` can take several seconds on its first run of the day.
const STATUS_TIMEOUT_MS = 10_000;

/** Keeps a status command from prompting, colouring its output or opening a browser. */
export function discoveryEnvironment(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: "1",
    NO_COLOR: "1",
    ...(platform === "win32" ? {} : { BROWSER: "/usr/bin/false" }),
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Provider variables that carry a secret, not a region or project id. */
const CREDENTIAL_VARIABLE = /(?:API_KEY|_KEY|_TOKEN|_SECRET|_PAT)$/;
// Present for git and the GitHub CLI on most machines; not an OpenCode sign-in.
const NON_SIGN_IN_VARIABLES = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);

/**
 * Parses `opencode auth list`. It prints stored credentials first, then every
 * provider variable it sees in the environment, each section ending in a count:
 *
 *     ●  OpenRouter api
 *     └  1 credentials
 *     ●  Google GEMINI_API_KEY
 *     └  1 environment variable
 *
 * OpenCode 2 prints one row per integration instead, or a single line when
 * there are none:
 *
 *     OpenRouter  API key                     stored
 *     OpenAI      OPENAI_API_KEY              environment
 *     No authenticated integrations
 *
 * A stored credential, or a provider key in the environment, counts as signed
 * in. Variables such as AWS_REGION are listed too but prove nothing.
 */
export function parseOpenCodeAuthList(output: string): boolean | null {
  const text = output.replace(ANSI_PATTERN, "");
  if (/^\s*No authenticated integrations\s*$/m.test(text)) return false;
  const rows = [...text.matchAll(/^\s*\S.*?\s{2,}(\S.*?)\s{2,}(stored|environment)\s*$/gm)];
  if (rows.some((row) => row[2] === "stored")) return true;
  if (rows.length > 0) {
    return rows.some(
      ([, name = ""]) => CREDENTIAL_VARIABLE.test(name) && !NON_SIGN_IN_VARIABLES.has(name),
    );
  }
  const credentials = text.match(/(\d+)\s+credentials?\b/i);
  const environment = text.match(/(\d+)\s+environment variables?\b/i);
  if (!credentials && !environment) return null;
  if (Number(credentials?.[1] ?? 0) > 0) return true;
  if (!environment) return false;
  const environmentSection = text.slice(Math.max(0, text.search(/Environment/)));
  const variables = [...environmentSection.matchAll(/^\s*●\s+.*?\s([A-Z][A-Z0-9_]+)\s*$/gm)].map(
    (match) => match[1] ?? "",
  );
  return variables.some(
    (name) => CREDENTIAL_VARIABLE.test(name) && !NON_SIGN_IN_VARIABLES.has(name),
  );
}

type Run = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Effect.Effect<
  Option.Option<CommandResult> | "missing",
  never,
  ChildProcessSpawner.ChildProcessSpawner
>;

const makeRun =
  (binary: string, environment: NodeJS.ProcessEnv): Run =>
  (args, timeoutMs) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
      return yield* spawnAndCollect(
        binary,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          stdin: "ignore",
          // A CLI that ignores SIGTERM must not keep a timed-out probe alive.
          forceKillAfter: "1 second",
        }),
      );
    }).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.result,
      Effect.map((result) =>
        Result.isSuccess(result)
          ? result.success
          : isCommandMissingCause(result.failure)
            ? ("missing" as const)
            : Option.none(),
      ),
    );

/** Installed means `--version` exits 0; a missing binary is the only "not installed". */
const probeInstalled = (run: Run) =>
  run(["--version"], VERSION_TIMEOUT_MS).pipe(
    Effect.map((result): ProviderDiscoveryState | "installed" =>
      result === "missing"
        ? "not-installed"
        : Option.isSome(result) && result.value.code === 0
          ? "installed"
          : "unknown",
    ),
  );

const verdict = (signedIn: boolean | null): ProviderDiscoveryState =>
  signedIn === true ? "ready" : signedIn === false ? "signed-out" : "unknown";

export const probeGrok = (binary: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const run = makeRun(binary, environment);
    const installed = yield* probeInstalled(run);
    if (installed !== "installed") return installed;
    if (environment.XAI_API_KEY?.trim()) return "ready" as const;
    // Exits 0 whether or not the user is logged in; the text is the verdict.
    const models = yield* run(["models"], STATUS_TIMEOUT_MS);
    if (models === "missing" || Option.isNone(models) || models.value.code !== 0) {
      return "unknown" as const;
    }
    const { stdout, stderr } = models.value;
    return verdict(parseGrokModelsCliOutput(`${stdout}\n${stderr}`).authenticated);
  });

/** `opencode --version` prints `1.14.33` or `opencode v2.2.0`. */
export function isOpenCodeTwoOrLater(versionOutput: string): boolean {
  const major = versionOutput.match(/(\d+)\.\d+\.\d+/)?.[1];
  return major !== undefined && Number(major) >= 2;
}

export const probeOpenCode = (binary: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const run = makeRun(binary, environment);
    const version = yield* run(["--version"], VERSION_TIMEOUT_MS);
    if (version === "missing") return "not-installed" as const;
    if (Option.isNone(version) || version.value.code !== 0) return "unknown" as const;
    // OpenCode 2 answers `auth list` through a shared background service on a
    // fixed port; --standalone uses a private one that exits with the command.
    const list = yield* run(
      isOpenCodeTwoOrLater(`${version.value.stdout}\n${version.value.stderr}`)
        ? ["auth", "list", "--standalone"]
        : ["auth", "list"],
      STATUS_TIMEOUT_MS,
    );
    if (list === "missing" || Option.isNone(list) || list.value.code !== 0) {
      return "unknown" as const;
    }
    const { stdout, stderr } = list.value;
    return verdict(parseOpenCodeAuthList(`${stdout}\n${stderr}`));
  });

/** Probes every candidate in parallel and turns on the ready ones. */
export const runProviderDiscovery = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const { providerDiscoveryCandidates, autoEnableDiscoveredProviders } = settingsService;
  if (!providerDiscoveryCandidates || !autoEnableDiscoveredProviders) return [];
  yield* settingsService.ready;
  const candidates = yield* providerDiscoveryCandidates;
  if (candidates.size === 0) return [];

  const settings = yield* settingsService.getSettings;
  const environment = discoveryEnvironment(
    yield* HostProcessEnvironment,
    yield* HostProcessPlatform,
  );
  const probes: Record<
    DiscoverableProviderDriver,
    Effect.Effect<ProviderDiscoveryState, never, ChildProcessSpawner.ChildProcessSpawner>
  > = {
    grok: probeGrok(settings.providers.grok.binaryPath || "grok", environment),
    opencode: probeOpenCode(settings.providers.opencode.binaryPath || "opencode", environment),
  };
  const results = yield* Effect.forEach(
    [...candidates],
    (driver) => probes[driver].pipe(Effect.map((state) => ({ driver, state }))),
    { concurrency: "unbounded" },
  );
  yield* Effect.logInfo("Provider discovery finished", {
    results: Object.fromEntries(results.map(({ driver, state }) => [driver, state])),
  });
  const ready = results.filter(({ state }) => state === "ready").map(({ driver }) => driver);
  if (ready.length === 0) return [];
  const at = DateTime.formatIso(yield* DateTime.now);
  const enabled = yield* autoEnableDiscoveredProviders(ready, at);
  if (enabled.length > 0) {
    yield* Effect.logInfo("Turned on signed-in providers", { drivers: enabled });
  }
  return enabled;
});

/** Runs discovery once, in the background, after settings are ready. */
export const layer = Layer.effectDiscard(
  runProviderDiscovery.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Provider discovery failed", { cause })),
    Effect.forkScoped,
  ),
);
