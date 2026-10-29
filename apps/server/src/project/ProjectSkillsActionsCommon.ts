/**
 * Pieces the Skills control center's version actions, switches and fleet
 * push share: the folder and row an action is about, a fixed-argv process
 * run without a shell, and how a failed run becomes a named refusal.
 *
 * @module project/ProjectSkillsActionsCommon
 */
import type {
  ProjectId,
  ProjectSkillRow,
  ProjectSkillsActionErrorReason,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { ProjectSkillsActionError } from "@specweave-studio/contracts";
import type * as CodexClient from "@specweave-studio/effect-codex-app-server/client";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as FileSystem from "effect/FileSystem";

import { vskillSearchDirs } from "../fleet/fleetSkills.ts";
import type { ProviderSkillsControl } from "../provider/ProviderDriver.ts";
import * as ProcessRunner from "../processRunner.ts";

/** The project folder an action runs in and the Skills row it is about. */
export interface SkillsActionContext {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly row: ProjectSkillRow;
}

export interface SkillTarget {
  readonly projectId: ProjectId;
  readonly cwd?: string | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly skill: string;
}

/** One process run; a spawn failure is `exitCode: null`. */
export interface CliRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type RunCli = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeout: Duration.Input;
  /** Added to the server's own environment; its `PATH` is where a bare command is found. */
  readonly env?: NodeJS.ProcessEnv | undefined;
}) => Effect.Effect<CliRun>;

/** The app-server requests a Codex switch needs. */
export type CodexConfigClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

/** What the version actions, switches and push need from the running server. */
export interface ProjectSkillsActionsDeps {
  readonly home: string;
  /** The server's environment; `PATH` is where vskill is looked for. */
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Settings backups; absent, a write keeps none. */
  readonly backupDir: string | undefined;
  /** The row named `skill` in the folder, read as the Skills view reads it. */
  readonly resolveRow: (
    input: SkillTarget,
  ) => Effect.Effect<SkillsActionContext, ProjectSkillsActionError>;
  readonly agentControl: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderSkillsControl | undefined>;
  /** A connected Codex app server for `cwd`, closed with the scope. */
  readonly codexClient: (
    control: ProviderSkillsControl,
    cwd: string,
    projectId: ProjectId,
  ) => Effect.Effect<CodexConfigClient, ProjectSkillsActionError, Scope.Scope>;
  /** Drops the folder's cached read and asks the named agents to scan it again. */
  readonly afterWrite: (input: {
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  }) => Effect.Effect<void>;
  /** Tests move Claude's managed settings file; otherwise the platform's. */
  readonly managedSettingsPath?: string | undefined;
}

export const actionError = (
  projectId: ProjectId,
  reason: ProjectSkillsActionErrorReason,
  detail?: string,
) => new ProjectSkillsActionError({ projectId, reason, ...(detail ? { detail } : {}) });

/** The last words of a run, without colour codes. */
export function outputTail(run: CliRun, max = 400): string {
  // oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
  const plain = `${run.stderr}\n${run.stdout}`.replace(/\u001b\[[0-9;]*m/g, "").trim();
  return plain.length > max ? `…${plain.slice(-max)}` : plain;
}

/** A failed run as `cli_failed`, with its exit code and the end of its output. */
export function cliFailure(projectId: ProjectId, run: CliRun, what: string) {
  const tail = outputTail(run);
  const detail = run.timedOut
    ? `${what} did not finish in time.`
    : run.exitCode === null
      ? `${what} could not be started.`
      : `${what} exited with ${run.exitCode}${tail === "" ? "." : `: ${tail}`}`;
  return new ProjectSkillsActionError({
    projectId,
    reason: run.exitCode === null && !run.timedOut ? "agent_unavailable" : "cli_failed",
    detail,
    exitCode: run.exitCode,
    stderrTail: tail,
  });
}

/**
 * Runs `command args` in `cwd` with no shell. The binary's own folder leads
 * PATH, so a node script finds its `node`; colour is turned off.
 */
export const makeRunCli = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const run: RunCli = ({ command, args, cwd, timeout, env }) => {
    const basePath = env?.PATH ?? "";
    const pathEnv = path.isAbsolute(command)
      ? [path.dirname(command), basePath].filter((entry) => entry !== "").join(":")
      : basePath;
    return runner
      .run({
        command,
        args,
        cwd,
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
        env: { ...env, PATH: pathEnv, NO_COLOR: "1" },
      })
      .pipe(
        Effect.map((output): CliRun => ({
          exitCode: output.code === null ? null : Number(output.code),
          stdout: output.stdout,
          stderr: output.stderr,
          timedOut: output.timedOut,
        })),
        Effect.orElseSucceed((): CliRun => ({
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
        })),
      );
  };
  return run;
});

/**
 * The vskill binary, looked for as the fleet worker does: PATH, then
 * `~/.local/bin`, Homebrew and `/usr/local/bin`. Null when none is installed.
 */
export const findVskillBinary = Effect.fn("projectSkills.findVskillBinary")(function* (input: {
  readonly home: string;
  readonly pathEnv: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of vskillSearchDirs({ home: input.home, pathEnv: input.pathEnv })) {
    const candidate = path.join(dir, "vskill");
    const executable = yield* fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "File" && (Number(info.mode) & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    );
    if (executable) return candidate;
  }
  return null;
});

export const VSKILL_MISSING =
  "vskill is not installed (looked on PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin). Install it with npm i -g vskill.";
