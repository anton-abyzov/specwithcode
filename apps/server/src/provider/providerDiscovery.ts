/**
 * The search for installed agents. Once the server is up, and again whenever
 * a client asks, every known agent gets one cheap probe of its CLI: is it
 * installed, and is it signed in. Drivers that are both, and that the user
 * never switched on or off, are turned on, and Settings says so with an Undo.
 *
 * A probe never logs in, opens a browser, reads a credential file or touches
 * the Keychain itself: it runs `--version` and one status command with stdin
 * closed and a hard timeout, and reads environment variables for presence only.
 */
import {
  type AgentSearch as AgentSearchSnapshot,
  ProviderInstanceId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  DISCOVERABLE_PROVIDER_DRIVERS,
  type DiscoverableProviderDriver,
  ServerSettingsService,
} from "../serverSettings.ts";
import { AgentSearch } from "./agentSearch.ts";
import { parseGrokModelsCliOutput } from "./GrokProvider.ts";
import { type CommandResult, isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";

/**
 * `installed` is an agent that runs but whose sign-in this check does not
 * read: it is shown as found, and never turned on by discovery.
 */
export type ProviderDiscoveryState =
  | "ready"
  | "signed-out"
  | "installed"
  | "not-installed"
  | "unknown";

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
    Effect.map((result): "installed" | "not-installed" | "unknown" =>
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

/**
 * Parses `pi --list-models`. With no provider key or login Pi prints
 * "No models available. Set API keys in environment variables."; otherwise it
 * prints a table with one row per model.
 */
export function parsePiListModels(output: string): boolean | null {
  const text = output.replace(ANSI_PATTERN, "");
  if (/No models available/i.test(text)) return false;
  return text.split("\n").filter((line) => line.trim() !== "").length >= 2 ? true : null;
}

export const probePi = (binary: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const run = makeRun(binary, environment);
    const installed = yield* probeInstalled(run);
    if (installed !== "installed") return installed;
    const models = yield* run(["--list-models"], STATUS_TIMEOUT_MS);
    if (models === "missing" || Option.isNone(models) || models.value.code !== 0) {
      return "unknown" as const;
    }
    const { stdout, stderr } = models.value;
    return verdict(parsePiListModels(`${stdout}\n${stderr}`));
  });

/**
 * Cursor runs through its SDK, so a key in the environment is a sign-in with
 * or without the CLI. Without a key the CLI only shows that Cursor is here:
 * its browser login is kept per instance and is not read.
 */
export const probeCursor = (binary: string, environment: NodeJS.ProcessEnv) =>
  environment.CURSOR_API_KEY?.trim()
    ? Effect.succeed("ready" as const)
    : probeInstalled(makeRun(binary, environment));

/** `muse usage --json` exits 0 only for a signed-in account. */
export const probeMuse = (binary: string, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const run = makeRun(binary, environment);
    const installed = yield* probeInstalled(run);
    if (installed !== "installed") return installed;
    const usage = yield* run(["usage", "--json"], STATUS_TIMEOUT_MS);
    return usage !== "missing" && Option.isSome(usage) && usage.value.code === 0
      ? ("ready" as const)
      : ("installed" as const);
  });

/** For agents whose sign-in the app checks elsewhere, or only offers. */
export const probeCommand = (binary: string, environment: NodeJS.ProcessEnv) =>
  probeInstalled(makeRun(binary, environment));

export type GitDiscoveryState = "present" | "missing";

/**
 * Whether the machine has Git. On a Mac `/usr/bin/git` is always there, and
 * without Apple's developer tools running it opens an install prompt, so the
 * question goes to `xcode-select -p`, which never does. Undefined when the
 * check gave no answer.
 */
export const probeGit = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  Effect.gen(function* () {
    if (platform === "darwin") {
      const tools = yield* makeRun("xcode-select", environment)(["-p"], VERSION_TIMEOUT_MS);
      if (tools === "missing" || Option.isNone(tools)) return undefined;
      if (tools.value.code === 0) {
        // The answer can outlive the tools: a macOS upgrade removes them and keeps the path.
        const folder = tools.value.stdout.trim();
        const git = folder
          ? yield* makeRun("/bin/test", environment)(
              ["-x", `${folder}/usr/bin/git`],
              VERSION_TIMEOUT_MS,
            )
          : ("missing" as const);
        if (git !== "missing" && Option.isSome(git) && git.value.code === 0) {
          return "present" as const;
        }
      }
      // A Git from Homebrew or Nix works without the developer tools.
      const withoutShim = {
        ...environment,
        PATH: searchedFolders(environment, platform)
          .filter((folder) => folder !== "/usr/bin")
          .join(":"),
      };
      const other = yield* makeRun("git", withoutShim)(["--version"], VERSION_TIMEOUT_MS);
      return other !== "missing" && Option.isSome(other) && other.value.code === 0
        ? ("present" as const)
        : ("missing" as const);
    }
    const version = yield* makeRun("git", environment)(["--version"], VERSION_TIMEOUT_MS);
    if (version === "missing") return "missing" as const;
    return Option.isSome(version) && version.value.code === 0 ? ("present" as const) : undefined;
  });

type Probe = (
  binary: string,
  environment: NodeJS.ProcessEnv,
) => Effect.Effect<ProviderDiscoveryState, never, ChildProcessSpawner.ChildProcessSpawner>;

/**
 * Every agent discovery looks for. `builtIn` agents have a row in Settings
 * whether or not they are found; `registry` agents are offered when found and
 * never added by themselves.
 */
export const DISCOVERED_AGENTS = [
  { agent: "codex", kind: "builtIn", command: "codex", probe: probeCommand },
  { agent: "claudeAgent", kind: "builtIn", command: "claude", probe: probeCommand },
  { agent: "cursor", kind: "builtIn", command: "cursor-agent", probe: probeCursor },
  { agent: "grok", kind: "builtIn", command: "grok", probe: probeGrok },
  { agent: "muse", kind: "builtIn", command: "muse", probe: probeMuse },
  { agent: "opencode", kind: "builtIn", command: "opencode", probe: probeOpenCode },
  { agent: "pi", kind: "builtIn", command: "pi", probe: probePi },
  { agent: "antigravity", kind: "builtIn", command: "antigravity-acp", probe: probeCommand },
  { agent: "gemini", kind: "registry", command: "gemini", probe: probeCommand },
  { agent: "github-copilot-cli", kind: "registry", command: "copilot", probe: probeCommand },
] as const satisfies ReadonlyArray<{
  readonly agent: string;
  readonly kind: "builtIn" | "registry";
  readonly command: string;
  readonly probe: Probe;
}>;
export type DiscoveredAgent = (typeof DISCOVERED_AGENTS)[number]["agent"];

export interface AgentDiscoveryResult {
  readonly agent: DiscoveredAgent;
  readonly kind: "builtIn" | "registry";
  /** The command or path that was run. */
  readonly command: string;
  readonly state: ProviderDiscoveryState;
}

export interface AgentDiscoveryReport {
  readonly results: ReadonlyArray<AgentDiscoveryResult>;
  /** The folders a command name was looked up in, for a "not found" row. */
  readonly searched: ReadonlyArray<string>;
  /** Undefined when the check for Git gave no answer. */
  readonly git: GitDiscoveryState | undefined;
}

const configuredBinaryPath = (value: unknown): string | undefined => {
  const path =
    value !== null && typeof value === "object" && "binaryPath" in value
      ? value.binaryPath
      : undefined;
  return typeof path === "string" && path.trim() !== "" ? path.trim() : undefined;
};

/** The path the user set for an agent, from its legacy entry or its default instance. */
function commandFor(settings: ServerSettings, agent: string, fallback: string): string {
  return (
    configuredBinaryPath((settings.providers as Record<string, unknown>)[agent]) ??
    configuredBinaryPath(settings.providerInstances[ProviderInstanceId.make(agent)]?.config) ??
    fallback
  );
}

export function searchedFolders(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const path = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  return [
    ...new Set(
      path
        .split(platform === "win32" ? ";" : ":")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
}

// Most of these CLIs are Node programs; starting ten at once stalls a small machine.
const PROBE_CONCURRENCY = 4;

/**
 * Looks for every known agent. Reads only; settings are not changed.
 * `onResult` hears each agent as it answers, before the others are done.
 */
export const discoverAgents = Effect.fn("providerDiscovery.discoverAgents")(function* (
  settings: ServerSettings,
  onResult: (result: AgentDiscoveryResult) => Effect.Effect<void> = () => Effect.void,
) {
  const platform = yield* HostProcessPlatform;
  const environment = discoveryEnvironment(yield* HostProcessEnvironment, platform);
  const results = yield* Effect.forEach(
    DISCOVERED_AGENTS,
    ({ agent, kind, command: fallback, probe }) => {
      const command = commandFor(settings, agent, fallback);
      return probe(command, environment).pipe(
        Effect.map((state): AgentDiscoveryResult => ({ agent, kind, command, state })),
        Effect.tap(onResult),
      );
    },
    { concurrency: PROBE_CONCURRENCY },
  );
  return {
    results,
    searched: searchedFolders(environment, platform),
    git: yield* probeGit(environment, platform),
  } satisfies AgentDiscoveryReport;
});

const isDiscoverableDriver = (agent: string): agent is DiscoverableProviderDriver =>
  (DISCOVERABLE_PROVIDER_DRIVERS as ReadonlyArray<string>).includes(agent);

/**
 * Looks for every agent, then turns on the signed-in ones nobody has switched
 * on or off. Muse Code and registry agents are found and never turned on here.
 */
const searchAndTurnOn = Effect.fn("providerDiscovery.searchAndTurnOn")(function* (
  onResult?: (result: AgentDiscoveryResult) => Effect.Effect<void>,
) {
  const settingsService = yield* ServerSettingsService;
  yield* settingsService.ready;
  const report = yield* discoverAgents(yield* settingsService.getSettings, onResult);
  yield* Effect.logInfo("Provider discovery finished", {
    results: Object.fromEntries(report.results.map(({ agent, state }) => [agent, state])),
  });
  const { providerDiscoveryCandidates, autoEnableDiscoveredProviders } = settingsService;
  if (!providerDiscoveryCandidates || !autoEnableDiscoveredProviders) {
    return { report, enabled: [] };
  }
  const candidates = yield* providerDiscoveryCandidates;
  const ready = report.results
    .filter(({ state }) => state === "ready")
    .map(({ agent }) => agent)
    .filter(isDiscoverableDriver)
    .filter((driver) => candidates.has(driver));
  if (ready.length === 0) return { report, enabled: [] };
  const at = DateTime.formatIso(yield* DateTime.now);
  const enabled = yield* autoEnableDiscoveredProviders(ready, at);
  if (enabled.length > 0) {
    yield* Effect.logInfo("Turned on signed-in providers", { drivers: enabled });
  }
  return { report, enabled };
});

/** One search, start to finish. Returns the drivers it turned on. */
export const runProviderDiscovery = searchAndTurnOn().pipe(Effect.map(({ enabled }) => enabled));

/** A search this recent answers a client that did not ask for a fresh one. */
export const AGENT_SEARCH_MAX_AGE_MS = 60_000;

interface AgentSearchRun {
  readonly snapshot: AgentSearchSnapshot;
  readonly running: boolean;
  /** Epoch milliseconds of the last finished search. */
  readonly finishedAt: number | undefined;
}

const ALL_AGENTS: ReadonlyArray<string> = DISCOVERED_AGENTS.map(({ agent }) => agent);

/** Every agent, with "no answer" for one a search that died never reached. */
const withNoAnswer = (answered: AgentSearchSnapshot["agents"]): AgentSearchSnapshot["agents"] =>
  DISCOVERED_AGENTS.map(
    ({ agent, kind, command }) =>
      answered.find((result) => result.agent === agent) ?? {
        agent,
        kind,
        command,
        state: "unknown" as const,
      },
  );

/**
 * Keeps what the search has found, and runs one search at a time. A search
 * outlives the request that started it; later requests read its progress.
 */
export const makeAgentSearch = Effect.gen(function* () {
  const services = yield* Effect.context<
    ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
  >();
  const scope = yield* Effect.scope;
  // Read once here: a search runs on its own fiber, not on the caller's.
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;
  const run = yield* Ref.make<AgentSearchRun>({
    snapshot: {
      agents: [],
      pending: [],
      searched: searchedFolders(discoveryEnvironment(hostEnvironment, platform), platform),
    },
    running: false,
    finishedAt: undefined,
  });

  const answered = (result: AgentDiscoveryResult) =>
    Ref.update(run, (current) => {
      const pending = current.snapshot.pending.filter((agent) => agent !== result.agent);
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          agents: [
            ...current.snapshot.agents.filter(({ agent }) => agent !== result.agent),
            result,
          ],
          // Nothing pending means finished, so the last agent stays until `finished` runs.
          pending: pending.length === 0 ? current.snapshot.pending : pending,
        },
      };
    });

  const finished = (report: AgentDiscoveryReport | undefined) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* Ref.update(run, (current) => ({
        running: false,
        finishedAt: DateTime.toEpochMillis(now),
        snapshot: {
          // In the order agents are listed, not the order they answered.
          agents: report?.results ?? withNoAnswer(current.snapshot.agents),
          pending: [],
          searched: report?.searched ?? current.snapshot.searched,
          checkedAt: DateTime.formatIso(now),
          // A check with no answer keeps what the one before it said.
          ...((report?.git ?? current.snapshot.git) !== undefined
            ? { git: report?.git ?? current.snapshot.git }
            : {}),
        },
      }));
    });

  const search = searchAndTurnOn(answered).pipe(
    Effect.matchCauseEffect({
      onSuccess: ({ report }) => finished(report),
      // A search that died still ends, so the next request can start another.
      onFailure: (cause) =>
        Effect.logWarning("Provider discovery failed", { cause }).pipe(
          Effect.andThen(finished(undefined)),
        ),
    }),
    Effect.provideService(HostProcessEnvironment, hostEnvironment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideContext(services),
  );

  return AgentSearch.of({
    search: ({ fresh }) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const start = yield* Ref.modify(run, (current) => {
          const stale =
            current.finishedAt === undefined || now - current.finishedAt > AGENT_SEARCH_MAX_AGE_MS;
          if (current.running || !(fresh || stale)) return [false, current] as const;
          const next: AgentSearchRun = {
            ...current,
            running: true,
            snapshot: { ...current.snapshot, pending: ALL_AGENTS },
          };
          return [true, next] as const;
        });
        if (start) yield* Effect.forkIn(search, scope);
        return (yield* Ref.get(run)).snapshot;
      }),
  });
});

/** The search service. The registry offers it to clients through the refresh call. */
export const layerSearch = Layer.effect(AgentSearch, makeAgentSearch);

/** Runs one search in the background as the server starts. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { search } = yield* AgentSearch;
    yield* search({ fresh: true });
  }),
);
