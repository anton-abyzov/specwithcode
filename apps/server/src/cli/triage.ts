/**
 * `specweave-studio triage` - hand a misbehaving install to the user's own coding agent.
 *
 * The command is deliberately thin: it writes a `context.md` with machine facts
 * (versions, paths, server liveness, which source to clone), then launches claude or codex
 * interactively, seeded with the playbook from `triagePrompt.ts`. The agent
 * asks the user what went wrong, investigates, and files the issue; the
 * harness's own permission prompts gate anything it wants to run. With no
 * agent CLI installed, the prompt and context are written to disk for the user
 * to paste into whatever agent they do have.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeReadlinePromises from "node:readline/promises";

import { HostProcessArchitecture, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { stringifyJson } from "../json.ts";
import {
  claudeAgentSecretDenyForConfig,
  withClaudeAgentSecretDenySettings,
} from "../provider/AgentProtectedPaths.ts";
import { withHeadlessBrowserEnvironment } from "../provider/RuntimeInstructions.ts";
import {
  isProcessAlive,
  type PersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";
import { interactiveStdin } from "./consoleStdin.ts";
import { resolveCliCommand } from "./invocation.ts";
import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PUBLIC_REPO,
  TRIAGE_PUBLIC_REPO_URL,
} from "./triagePrompt.ts";

interface TriageAgent {
  readonly id: "claude" | "codex";
  readonly command: string;
  readonly label: string;
}

const TRIAGE_AGENTS: ReadonlyArray<TriageAgent> = [
  { id: "claude", command: "claude", label: "Claude Code" },
  { id: "codex", command: "codex", label: "Codex" },
];

/**
 * Extra launch arguments for the triage agent. Claude Code gets the same
 * credential-store deny settings as the app's own Claude threads, from a file
 * (cmd.exe shims cannot carry the JSON as an argument). They cover Claude's
 * file tools, not every shell command; Codex has no equivalent.
 */
export const triageAgentSettingsArgs = Effect.fn("triage.agentSettingsArgs")(function* (input: {
  readonly agentId: "claude" | "codex";
  readonly scratchDir: string;
  readonly config: {
    readonly baseDir: string;
    readonly stateDir: string;
    readonly secretsDir: string;
  };
  readonly homeDir: string;
}) {
  if (input.agentId !== "claude") return [];
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const deny = yield* claudeAgentSecretDenyForConfig({
    fileSystem,
    path,
    config: input.config,
    homeDir: input.homeDir,
  });
  const settingsPath = path.join(input.scratchDir, "claude-settings.json");
  yield* fileSystem.writeFileString(
    settingsPath,
    stringifyJson(withClaudeAgentSecretDenySettings({}, deny), null, 2),
  );
  return ["--settings", settingsPath];
});

export class TriageAgentUnavailableError extends Schema.TaggedError<TriageAgentUnavailableError>()(
  "TriageAgentUnavailableError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `\`${this.agent}\` is not installed or was not found on PATH.`;
  }
}

export class TriageAgentChoiceRequiredError extends Schema.TaggedError<TriageAgentChoiceRequiredError>()(
  "TriageAgentChoiceRequiredError",
  {},
) {
  override get message(): string {
    return "Both claude and codex are installed and there is no terminal to ask which to use. Re-run with --agent claude or --agent codex.";
  }
}

export class TriageAgentSpawnError extends Schema.TaggedError<TriageAgentSpawnError>()(
  "TriageAgentSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not start \`${this.command}\`.`;
  }
}

/**
 * One human-readable line about the local server, for `context.md`. Includes
 * the version the server recorded, which can differ from this CLI's version.
 */
export const formatServerProcess = (state: Option.Option<PersistedServerRuntimeState>) => {
  if (Option.isNone(state)) {
    return "not running (no server-runtime.json; the server may never have started here)";
  }
  const version =
    state.value.serverVersion === undefined
      ? "version not recorded"
      : `version ${state.value.serverVersion}`;
  if (!isProcessAlive(state.value.pid)) {
    return `not running (state file is stale: pid ${String(state.value.pid)} is dead; last origin ${state.value.origin}, ${version})`;
  }
  return `running (pid ${String(state.value.pid)}, ${state.value.origin}, ${version})`;
};

export const describeServerProcess = Effect.fn("triage.describeServerProcess")(function* (
  serverRuntimeStatePath: string,
) {
  // readPersistedServerRuntimeState swallows read/decode failures itself and
  // returns none, so a corrupt state file reads as "not running" here.
  return formatServerProcess(yield* readPersistedServerRuntimeState(serverRuntimeStatePath));
});

/** Whether a release tag exists on the public repo; "unknown" when it could not be checked. */
export type PublicTagStatus = "published" | "missing" | "unknown";

/**
 * Ask the public repo whether `tag` exists, with `git ls-remote`. Dev and
 * branch builds carry versions whose tags exist only on the private dev repo,
 * which users cannot clone. Offline, no git, or a slow network all read as
 * "unknown" and never fail triage.
 */
export const checkPublicReleaseTag = (input: {
  readonly tag: string;
  readonly repoUrl?: string;
  readonly timeoutMs?: number;
}) =>
  Effect.callback<PublicTagStatus>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.execFile(
        "git",
        [
          "ls-remote",
          "--exit-code",
          "--tags",
          input.repoUrl ?? TRIAGE_PUBLIC_REPO_URL,
          `refs/tags/${input.tag}`,
        ],
        {
          timeout: input.timeoutMs ?? 10_000,
          // Never stop to ask for credentials: the public repo needs none.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          windowsHide: true,
        },
        (error, stdout) => {
          if (error === null) {
            resume(
              Effect.succeed(stdout.includes(`refs/tags/${input.tag}`) ? "published" : "missing"),
            );
            return;
          }
          // --exit-code: 2 means the remote answered and has no such ref.
          resume(Effect.succeed(error.code === 2 && !error.killed ? "missing" : "unknown"));
        },
      );
    } catch {
      resume(Effect.succeed("unknown"));
      return;
    }
    return Effect.sync(() => {
      child.kill();
    });
  });

/** The context line telling the agent which source to clone, and why. */
export const describeSourceToClone = (input: {
  readonly version: string;
  readonly versionSource: "server" | "cli";
  readonly status: PublicTagStatus;
}) => {
  const tag = `v${input.version}`;
  const whose =
    input.versionSource === "server" ? "the local server's version" : "this CLI's version";
  switch (input.status) {
    case "published":
      return `tag ${tag} (${whose}; published on ${TRIAGE_PUBLIC_REPO})`;
    case "missing":
      return `main. Tag ${tag} (${whose}) is not published on ${TRIAGE_PUBLIC_REPO}: this is a development, branch or not-yet-mirrored build, and its tag exists only in the private development repo, which users cannot clone. Clone main and treat file and line references as approximate.`;
    case "unknown":
      return `tag ${tag} (${whose}) if it exists. Triage could not reach ${TRIAGE_PUBLIC_REPO} to check (offline, no git, or GitHub unreachable); if the tag clone fails, clone main and treat file and line references as approximate.`;
  }
};

const pickAgent = (agents: ReadonlyArray<TriageAgent>) =>
  Effect.promise(async () => {
    const readline = NodeReadlinePromises.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const menu = agents
        .map((agent, index) => `  [${String(index + 1)}] ${agent.label}`)
        .join("\n");
      for (;;) {
        const answer = (await readline.question(`Run triage with:\n${menu}\n> `)).trim();
        const byNumber = agents[Number.parseInt(answer, 10) - 1];
        if (byNumber !== undefined) {
          return byNumber;
        }
        const byId = agents.find((agent) => agent.id === answer.toLowerCase());
        if (byId !== undefined) {
          return byId;
        }
      }
    } finally {
      readline.close();
    }
  });

/**
 * Run the agent CLI as a normal interactive session: the user's terminal is
 * the UI, and the harness's own permission prompts gate every action. Resolves
 * with the child's exit code.
 */
export const runInteractiveSession = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
  readonly cwd: string;
}) =>
  Effect.callback<number, TriageAgentSpawnError>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      // The agent may run browser checks, so the headless variables win.
      env: withHeadlessBrowserEnvironment(process.env),
      // The agent reads the user's terminal; under a desktop CLI launcher on
      // Windows that is the reopened console, not the (missing) inherited stdin.
      stdio: [interactiveStdin(), "inherit", "inherit"],
      shell: input.shell,
    });
    child.once("error", (cause) =>
      resume(Effect.fail(new TriageAgentSpawnError({ command: input.command, cause }))),
    );
    // Signal death has no exit code; report failure rather than success.
    child.once("exit", (code, signal) => resume(Effect.succeed(code ?? (signal === null ? 0 : 1))));
  });

const agentFlag = Flag.Literals("agent", ["claude", "codex"]).pipe(
  Flag.withDescription("Agent CLI to use. Default: ask when both are installed."),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
  Flag.withDescription("Model passed through to the agent CLI. Default: the agent's default."),
  Flag.optional,
);

export const triageCommand = Command.make("triage", {
  baseDir: baseDirFlag,
  agent: agentFlag,
  model: modelFlag,
}).pipe(
  Command.withDescription(
    "Investigate a SpecWithCode problem on this machine with claude or codex, and help file a good issue.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      // Triage is a user-facing feature: always the userdata state, never dev.
      // --base-dir wins; STUDIO_HOME is its documented env equivalent (same
      // precedence as `specweave-studio pair`).
      const explicitBaseDir = Option.getOrUndefined(flags.baseDir);
      const envHome = yield* Config.String("STUDIO_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(explicitBaseDir ?? Option.getOrUndefined(envHome));
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {});

      const now = yield* DateTime.now;
      const scratchDir = path.join(
        paths.stateDir,
        "triage",
        // ISO instant, made safe for Windows paths.
        DateTime.formatIso(now).replaceAll(":", "-").replace(".", "-"),
      );
      yield* fs.makeDirectory(scratchDir, { recursive: true });

      const serverState = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath);
      // The bug most likely happened on the running server's build; the CLI
      // running triage can be a different one.
      const serverVersion = Option.getOrUndefined(serverState)?.serverVersion;
      const sourceVersion = serverVersion ?? packageJson.version;
      const sourceToClone = describeSourceToClone({
        version: sourceVersion,
        versionSource: serverVersion === undefined ? "cli" : "server",
        status: yield* checkPublicReleaseTag({ tag: `v${sourceVersion}` }),
      });
      const contextFilePath = path.join(scratchDir, "context.md");
      yield* fs.writeFileString(
        contextFilePath,
        buildTriageContext({
          generatedAt: DateTime.formatIso(now),
          cliVersion: packageJson.version,
          sourceToClone,
          os: `${yield* HostProcessPlatform} ${yield* HostProcessArchitecture} (${NodeOS.release()})`,
          nodeVersion: process.version,
          launchedAs: yield* resolveCliCommand("triage"),
          server: formatServerProcess(serverState),
          paths: {
            stateDir: paths.stateDir,
            dbPath: paths.dbPath,
            settingsPath: paths.settingsPath,
            logsDir: paths.logsDir,
            // The server writes no log file of its own. Service installs and the
            // desktop app capture its output. The glob covers every desktop backend
            // (such as WSL) and rotated copies; names come from DesktopObservability.ts.
            serviceLogPath: path.join(paths.logsDir, BootService.BOOT_SERVICE_LOG_FILE),
            desktopBackendLogGlob: path.join(paths.logsDir, "server-child*.log*"),
            serverTracePath: paths.serverTracePath,
            providerEventLogPath: paths.providerEventLogPath,
            terminalLogsDir: paths.terminalLogsDir,
            providerStatusCacheDir: paths.providerStatusCacheDir,
            secretsDir: paths.secretsDir,
            sourceCacheDir: path.join(baseDir, "source"),
          },
        }),
      );

      const installed: Array<TriageAgent> = [];
      for (const agent of TRIAGE_AGENTS) {
        if (yield* isCommandAvailable(agent.command)) {
          installed.push(agent);
        }
      }

      const requested = Option.getOrUndefined(flags.agent);
      let selected: TriageAgent | undefined;
      if (requested !== undefined) {
        selected = installed.find((agent) => agent.id === requested);
        if (selected === undefined) {
          return yield* new TriageAgentUnavailableError({ agent: requested });
        }
      } else if (installed.length === 1) {
        selected = installed[0];
      } else if (installed.length > 1) {
        // Both streams must be terminals: with stdout redirected the picker
        // prompt is invisible and the command would hang waiting on it.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return yield* new TriageAgentChoiceRequiredError();
        }
        selected = yield* pickAgent(installed);
      }

      // The full seed prompt always goes to disk. The agent is launched with a
      // one-line pointer at it: Windows `.cmd` shims run through cmd.exe,
      // which cannot carry the multiline playbook as an argv string, and with
      // no agent installed the same file is the paste-anywhere fallback.
      const promptFilePath = path.join(scratchDir, "prompt.md");
      yield* fs.writeFileString(promptFilePath, buildTriageSeedPrompt(contextFilePath));

      if (selected === undefined) {
        yield* Console.log(
          [
            "No supported agent CLI (claude, codex) was found on this machine.",
            "",
            "The triage prompt and machine context were written to:",
            `  ${promptFilePath}`,
            `  ${contextFilePath}`,
            "",
            "Paste the prompt file into any coding agent to run triage by hand.",
          ].join("\n"),
        );
        return;
      }

      const model = Option.getOrUndefined(flags.model);
      const settingsArgs = yield* triageAgentSettingsArgs({
        agentId: selected.id,
        scratchDir,
        config: { baseDir, stateDir: paths.stateDir, secretsDir: paths.secretsDir },
        homeDir: NodeOS.homedir(),
      });
      const spawnSpec = yield* resolveSpawnCommand(selected.command, [
        ...(model === undefined ? [] : ["--model", model]),
        ...settingsArgs,
        buildTriageLaunchPrompt(promptFilePath),
      ]);
      yield* Console.log(`Starting ${selected.label}. It will ask what went wrong.\n`);
      const exitCode = yield* runInteractiveSession({ ...spawnSpec, cwd: scratchDir });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }),
  ),
);
