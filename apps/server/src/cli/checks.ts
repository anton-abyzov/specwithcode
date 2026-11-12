// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- the gate is plain Node shared with child processes; see heavyCheckLock.ts.
/**
 * `specweave-studio checks`: run full lint, typecheck and test suites one at
 * a time on this machine, in one reusable verification copy.
 *
 * - `checks run [--label TEXT] [--wait-timeout 10m] -- <command...>` takes
 *   the machine-wide heavy-check gate, runs the command with this terminal's
 *   input and output, and exits with the command's exit code.
 * - `checks status [--json]` prints who holds the gate and who waits.
 * - `checks copy <path-or-url> [--ref REF]` prints the path of the
 *   repository's verification copy, moved to REF, with dependencies
 *   installed when the lockfile changed.
 *
 * Exit codes of `run`: the command's own; 75 when `--wait-timeout` passed
 * before the gate was free (the command did not run); 127 when the command
 * could not be started; 2 for a bad flag. Of `copy`: 0 with the path on
 * stdout; 2 when the copy has uncommitted files; 3 when the gate is held by
 * someone else and the copy would have to change; 1 for any other failure.
 *
 * The lock is outside every project and every app home, in
 * `~/.specwithcode/locks` (the default home's folder, whatever STUDIO_HOME or
 * --base-dir says), so every app instance on the machine shares it.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { studioDefaultHome } from "@specweave-studio/shared/studioIdentity";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { baseDirFlag } from "./config.ts";
import { resolveHome } from "./db.ts";
import {
  describeHolder,
  HEAVY_CHECK_DIR_ENV,
  heavyCheckPaths,
  type HeavyCheckRecord,
  insideHeavyCheckGate,
  parseWaitTimeout,
  readHolder,
  readQueue,
  releaseHeavyCheckLock,
  runUnderHeavyCheckGate,
  tryAcquireHeavyCheckLock,
} from "./heavyCheckLock.ts";
import { ensureVerificationCopy, VerificationCopyError } from "./verificationCopy.ts";

/** A flag was wrong; nothing ran. */
export const CHECKS_EXIT_USAGE = 2;
export const CHECKS_COPY_EXIT_DIRTY = 2;
export const CHECKS_COPY_EXIT_BUSY = 3;

/** The lock folder every instance on this machine shares. */
export function machineHeavyCheckPaths(env: NodeJS.ProcessEnv = process.env) {
  const override = env[HEAVY_CHECK_DIR_ENV]?.trim();
  return heavyCheckPaths(
    override
      ? NodePath.resolve(override)
      : NodePath.join(studioDefaultHome(NodeOS.homedir()), "locks"),
  );
}

const fail = (code: number, message: string) =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
  );

const runCommand = Command.make("run", {
  label: Flag.String("label").pipe(
    Flag.withDescription("A short name for this run, shown to callers that wait."),
    Flag.optional,
  ),
  waitTimeout: Flag.String("wait-timeout").pipe(
    Flag.withDescription(
      "Give up when the gate is not free after this long, as 90s, 10m or 2h. Exits 75 without running the command. Waits without limit by default.",
    ),
    Flag.optional,
  ),
  command: Argument.String("command").pipe(
    Argument.withDescription("The command and its arguments, after --."),
    Argument.variadic,
  ),
}).pipe(
  Command.withDescription(
    "Run a full lint, typecheck or test suite holding the machine-wide heavy-check gate: one such command runs at a time on this machine, later callers wait in order. Exits with the command's exit code.",
  ),
  Command.withHandler(
    Effect.fn("cli.checks.run")(function* (flags) {
      if (flags.command.length === 0)
        return yield* fail(
          CHECKS_EXIT_USAGE,
          "checks run: give the command after --, for example: specweave-studio checks run -- pnpm test",
        );
      let waitTimeoutMs: number | undefined;
      if (Option.isSome(flags.waitTimeout)) {
        const parsed = parseWaitTimeout(flags.waitTimeout.value);
        if (parsed === null)
          return yield* fail(
            CHECKS_EXIT_USAGE,
            "checks run: --wait-timeout takes a number and a unit: 90s, 10m or 2h.",
          );
        waitTimeoutMs = parsed;
      }
      // Uninterruptible: on Ctrl-C the signal goes to the command, and the gate is released when it exits.
      const result = yield* Effect.uninterruptible(
        Effect.promise(() =>
          runUnderHeavyCheckGate({
            paths: machineHeavyCheckPaths(),
            command: flags.command.map(String),
            label: Option.getOrNull(flags.label),
            waitTimeoutMs,
            log: (line) => process.stderr.write(`${line}\n`),
          }),
        ),
      );
      process.exitCode = result.exitCode;
    }),
  ),
);

const ticketLine = (ticket: ReturnType<typeof readQueue>[number], index: number) =>
  `  ${index + 1}. ${ticket.label ?? "(no label)"} in ${ticket.cwd}${
    ticket.threadId === null ? "" : `, thread ${ticket.threadId}`
  }, PID ${ticket.pid}, waiting since ${ticket.enqueuedAt}`;

const statusCommand = Command.make("status", {
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print one JSON object: lockFile, holder (or null) and queue."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show who holds the heavy-check gate and who waits for it."),
  Command.withHandler(
    Effect.fn("cli.checks.status")(function* (flags) {
      const paths = machineHeavyCheckPaths();
      const holder = readHolder(paths);
      const queue = readQueue(paths);
      if (flags.json) {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - one output line, like `worktree owners --json`.
        yield* Console.log(JSON.stringify({ lockFile: paths.lockFile, holder, queue }));
        return;
      }
      yield* Console.log(
        [
          holder === null
            ? `The heavy-check gate is free (${paths.lockFile}).`
            : `Held by ${describeHolder(holder)}.`,
          queue.length === 0 ? "Nobody is waiting." : `Waiting, in order:`,
          ...queue.map(ticketLine),
        ].join("\n"),
      );
    }),
  ),
);

const copyCommand = Command.make("copy", {
  baseDir: baseDirFlag,
  ref: Flag.String("ref").pipe(
    Flag.withDescription(
      "Branch, tag or commit to move the copy to. Default: the checkout's HEAD, or the URL's default branch.",
    ),
    Flag.optional,
  ),
  source: Argument.String("repository").pipe(
    Argument.withDescription("A local checkout's path or a clone URL."),
  ),
}).pipe(
  Command.withDescription(
    "Print the path of this repository's one verification copy on this machine, creating it on first use, moved to --ref, with dependencies installed only when the lockfile changed. Refuses to change the copy while someone else holds the heavy-check gate, and never discards uncommitted files in it.",
  ),
  Command.withHandler(
    Effect.fn("cli.checks.copy")(function* (flags) {
      const { home } = yield* resolveHome(flags.baseDir);
      const paths = machineHeavyCheckPaths();
      const nested = insideHeavyCheckGate(paths);
      let held: HeavyCheckRecord | null = null;
      // Taken the first time the copy has to change, then kept until the command ends.
      const exclusive = <A>(work: () => A): A => {
        if (!nested && held === null) {
          held = tryAcquireHeavyCheckLock({
            paths,
            label: "checks copy",
            command: ["checks", "copy", flags.source],
          });
          if (held === null) {
            const holder = readHolder(paths);
            throw new VerificationCopyError(
              "busy",
              `The verification copy has to change, but the heavy-check gate is ${
                holder === null ? "waited for by others" : `held by ${describeHolder(holder)}`
              }. Run this under the gate (specweave-studio checks run -- ...) or try again later.`,
            );
          }
        }
        return work();
      };
      const outcome = yield* Effect.sync(() => {
        try {
          return ensureVerificationCopy({
            source: flags.source,
            ref: Option.getOrUndefined(flags.ref),
            home,
            exclusive,
            log: (line) => process.stderr.write(`${line}\n`),
          }).path;
        } catch (cause) {
          return cause instanceof Error ? cause : new Error(String(cause));
        } finally {
          const record = held as HeavyCheckRecord | null;
          if (record !== null) releaseHeavyCheckLock(paths, record.id);
        }
      });
      if (typeof outcome === "string") return yield* Console.log(outcome);
      const kind = outcome instanceof VerificationCopyError ? outcome.kind : "failed";
      yield* fail(
        kind === "dirty" ? CHECKS_COPY_EXIT_DIRTY : kind === "busy" ? CHECKS_COPY_EXIT_BUSY : 1,
        `checks copy: ${outcome.message}`,
      );
    }),
  ),
);

export const checksCommand = Command.make("checks").pipe(
  Command.withDescription(
    "Run heavy lint, typecheck and test suites one at a time on this machine, in one reusable verification copy.",
  ),
  Command.withSubcommands([runCommand, statusCommand, copyCommand]),
);
