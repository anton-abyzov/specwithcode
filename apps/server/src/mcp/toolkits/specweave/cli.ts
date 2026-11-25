/**
 * Runs the installed `specweave` CLI for the SpecWeave tools (1483).
 *
 * The command is found where an agent's own shell finds it: the app's command
 * folder (`<home>/commands`, the managed SpecWeave and its Node.js), then the
 * server's PATH and the usual install folders. It runs with an argument
 * array, never a shell, in the workspace the caller resolved. Interrupting
 * the call stops it: Effect's spawner kills the whole process group, so test
 * runners a verify started stop with it.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { CommandResolutionCache, resolveCommandPath } from "@specweave-studio/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../../../config.ts";
import { vskillSearchDirs } from "../../../fleet/fleetSkills.ts";
import { terminalCommandsDir } from "../../../machineTools/terminalPath.ts";
import { expandHomePath } from "../../../pathExpansion.ts";
import * as ProcessRunner from "../../../processRunner.ts";

/** Tests point this at a stand-in CLI; unset, the command is looked up. */
export const SpecweaveCommandOverride = Context.Reference<string | undefined>(
  "specweave-studio/mcp/toolkits/specweave/SpecweaveCommandOverride",
  { defaultValue: () => undefined },
);

/** The most of the CLI's output a result carries back to the agent. */
export const MAX_RESULT_TEXT_CHARS = 6_000;
/** The most of one string inside the parsed JSON (task evidence can run to KBs). */
export const MAX_DATA_STRING_CHARS = 1_500;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface SpecweaveRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly command: string;
  readonly workspace: string;
  readonly data: unknown;
  readonly text: string;
}

export interface SpecweaveRunInput {
  readonly specweaveRoot: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout: Duration.Input;
  /** Called with each stdout chunk, for progress. */
  readonly onOutput?: ((chunk: string) => void) | undefined;
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters cut)` : text;

/** Cuts long strings anywhere in the CLI's JSON, so one evidence log cannot flood the agent. */
export function boundStrings(value: unknown, max = MAX_DATA_STRING_CHARS, depth = 0): unknown {
  if (typeof value === "string") return cut(value, max);
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => boundStrings(item, max, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, boundStrings(item, max, depth + 1)]),
  );
}

/** The CLI's JSON: the whole stdout, else its last line that parses as an object. */
export function parseCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // fall through
      }
    }
    return null;
  }
}

// oxlint-disable-next-line no-control-regex -- strips terminal colour codes.
const stripColour = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** Finds `specweave` and the PATH it runs with, or null when it is not installed. */
export const locateSpecweave = Effect.fn("specweaveTools.locate")(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const delimiter = platform === "win32" ? ";" : ":";
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const dirs = [
    ...new Set([
      ...Option.match(config, {
        onNone: () => [],
        onSome: (value) => [terminalCommandsDir(value.baseDir)],
      }),
      ...vskillSearchDirs({
        home: expandHomePath("~"),
        pathEnv: environment.PATH,
        platform,
        appData: environment.APPDATA,
      }),
    ]),
  ].filter((dir) => dir !== "");
  const searchPath = dirs.join(delimiter);
  const override = yield* SpecweaveCommandOverride;
  const command =
    override ??
    (yield* resolveCommandPath("specweave", {
      env: { PATH: searchPath, PATHEXT: environment.PATHEXT },
    }).pipe(
      // Looked up per call: SpecWeave can be installed while the app runs.
      Effect.provideService(CommandResolutionCache, new Map()),
      Effect.orElseSucceed(() => null),
    ));
  return command === null ? null : { command, searchPath };
});

export const runSpecweave = Effect.fn("specweaveTools.run")(function* (input: SpecweaveRunInput) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const located = yield* locateSpecweave();
  // `--workspace` names the folder outright, so the CLI never walks up from
  // a worktree to the repository's main checkout.
  const args = ["--workspace", input.specweaveRoot, ...input.args];
  const shown = `specweave ${args.join(" ")}`;
  if (located === null) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      command: shown,
      workspace: input.specweaveRoot,
      data: null,
      text: "The specweave command is not installed on this machine. Install it with npm i -g specweave, or set SpecWeave up from the project's Board.",
    } satisfies SpecweaveRunResult;
  }
  const decoder = new TextDecoder();
  const onOutput = input.onOutput;
  const output = yield* runner
    .run({
      command: located.command,
      args,
      cwd: input.specweaveRoot,
      timeout: input.timeout,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      env: {
        PATH: located.searchPath,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "1",
      },
      ...(onOutput === undefined
        ? {}
        : {
            onStdoutChunk: (chunk: Uint8Array) => onOutput(decoder.decode(chunk, { stream: true })),
          }),
    })
    .pipe(
      Effect.map((run) => ({ _tag: "ran" as const, run })),
      Effect.catch((error) => Effect.succeed({ _tag: "failed" as const, error })),
    );
  if (output._tag === "failed") {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      command: shown,
      workspace: input.specweaveRoot,
      data: null,
      text: cut(
        `specweave could not be started: ${String(output.error.message)}`,
        MAX_RESULT_TEXT_CHARS,
      ),
    } satisfies SpecweaveRunResult;
  }
  const { run } = output;
  const stdout = stripColour(run.stdout);
  const stderr = stripColour(run.stderr).trim();
  const data = parseCliJson(stdout);
  const words = data === null ? [stdout.trim(), stderr].filter(Boolean).join("\n") : stderr;
  return {
    ok: run.code === 0 && !run.timedOut,
    exitCode: run.code,
    timedOut: run.timedOut,
    command: shown,
    workspace: input.specweaveRoot,
    data: boundStrings(data),
    text: cut(
      run.timedOut ? `Stopped: the run took longer than its time limit.\n${words}`.trim() : words,
      MAX_RESULT_TEXT_CHARS,
    ),
  } satisfies SpecweaveRunResult;
});
