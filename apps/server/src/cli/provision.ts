/**
 * `specwithcode provision` (also `specweave-studio provision`): prepare this
 * machine as a fleet worker from scratch, or verify that it already is. See
 * apps/server/src/provision/runner.ts for what it installs and what it never
 * touches.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { formatItemLine, formatReadback } from "../provision/format.ts";
import { loginShellPath, makeNodeProvisionHost } from "../provision/host.ts";
import { ProvisionRunError, runProvision } from "../provision/runner.ts";
import { baseDirFlag } from "./config.ts";

const readbackJson = (readback: unknown): string => JSON.stringify(readback, null, 2);

export class ProvisionCliError extends Schema.TaggedError<ProvisionCliError>()(
  "ProvisionCliError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

class ProvisionCliFailure extends Schema.TaggedError<ProvisionCliFailure>()("ProvisionCliFailure", {
  cause: Schema.Defect(),
}) {}

export const provisionCommand = Command.make("provision", {
  baseDir: baseDirFlag,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Show the plan: what is installed, what would change. Changes nothing."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription(
      "Print the readback as one JSON object (OS, packages wanted and found, service, server, providers, your steps).",
    ),
    Flag.withDefault(false),
  ),
  resume: Flag.Boolean("resume").pipe(
    Flag.withDescription(
      "Continue the last run that did not finish; finished steps are only re-checked.",
    ),
    Flag.withDefault(false),
  ),
  serverVersion: Flag.String("server-version").pipe(
    Flag.withDescription(
      `The SpecWithCode server version to install or verify (default ${packageJson.version}, this release). A newer installed version is kept.`,
    ),
    Flag.optional,
  ),
  standalone: Flag.Boolean("standalone").pipe(
    Flag.withDescription(
      "On a Mac with the desktop app, plan a command-line server and service beside it instead of leaving the server to the app.",
    ),
    Flag.withDefault(false),
  ),
  restartService: Flag.Boolean("restart-service").pipe(
    Flag.withDescription(
      "Restart the background service to apply a PATH change, only if it runs no threads.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Install or verify what a fleet worker needs: git, gh, Node.js 22, Claude Code, Codex, Tailscale and this server with its service, all pinned and checked. Never signs in, grants workers or enables billing.",
  ),
  Command.withHandler(
    Effect.fn("cli.provision")(function* (flags) {
      const host = makeNodeProvisionHost({
        interactive: !flags.json && Boolean(process.stdin.isTTY && process.stderr.isTTY),
      });
      const serverVersion = Option.getOrUndefined(flags.serverVersion)?.replace(/^v/u, "");
      if (serverVersion !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/u.test(serverVersion))
        return yield* new ProvisionCliError({
          reason: `${serverVersion} is not a SpecWithCode version.`,
        });
      const result = yield* Effect.tryPromise({
        try: () =>
          runProvision(host, {
            dryRun: flags.dryRun,
            resume: flags.resume,
            manifestVersion: packageJson.version,
            ...(serverVersion ? { serverVersion } : {}),
            ...(Option.isSome(flags.baseDir) ? { baseDir: flags.baseDir.value } : {}),
            mode: "cli",
            restartService: flags.restartService,
            standalone: flags.standalone,
            loginShellPath,
            runtime: { version: process.version, execPath: process.execPath },
            onEvent: (event) => {
              if (flags.json) return;
              if (event.type === "item" && event.item.status !== "running")
                process.stderr.write(`${formatItemLine(event.item)}\n`);
              else if (event.type === "log") process.stderr.write(`      ${event.line}\n`);
            },
          }),
        catch: (cause) => new ProvisionCliFailure({ cause }),
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        const error = result.failure.cause;
        if (error instanceof ProvisionRunError && error.readback) {
          yield* Console.log(
            flags.json ? readbackJson(error.readback) : formatReadback(error.readback),
          );
          process.exitCode = 2;
          return;
        }
        return yield* new ProvisionCliError({
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      const readback = result.success;
      yield* Console.log(flags.json ? readbackJson(readback) : formatReadback(readback));
      // 0: provisioned (your steps may remain); 1: a step failed; 3: waiting for the root steps.
      if (readback.items.some((item) => item.status === "failed")) process.exitCode = 1;
      else if (readback.items.some((item) => item.status === "needs-root")) process.exitCode = 3;
    }),
  ),
);
