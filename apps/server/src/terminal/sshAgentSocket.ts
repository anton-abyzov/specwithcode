import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Finds the user's ssh-agent socket for terminal shells.
 *
 * A server started by launchd (the macOS background service) does not inherit
 * SSH_AUTH_SOCK from a login session, so `ssh-add -l` in a terminal fails with
 * "Could not open a connection to your authentication agent". The process
 * value wins when its socket exists; otherwise on macOS the launchd session
 * value (`launchctl getenv SSH_AUTH_SOCK`) is used. The launchctl lookup runs
 * in the background and is cached, so `current` never waits on it: a terminal
 * opened before the first lookup finishes starts without the override.
 */
export interface SshAgentSocketLookup {
  readonly current: Effect.Effect<string | undefined>;
}

export interface SshAgentSocketLookupInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly socketExists: (socketPath: string) => Effect.Effect<boolean>;
  readonly launchctlGetenv: Effect.Effect<string | undefined>;
  readonly runFork: (effect: Effect.Effect<void>) => void;
}

const EMPTY_LOOKUP_RETRY_MS = 60_000;

export const makeSshAgentSocketLookup = (
  input: SshAgentSocketLookupInput,
): SshAgentSocketLookup => {
  const processValue = input.env.SSH_AUTH_SOCK?.trim() || undefined;
  if (input.platform !== "darwin") {
    return { current: Effect.succeed(undefined) };
  }
  let cached: string | undefined;
  let refreshing = false;
  // A lookup that found no socket is not retried for a minute.
  let emptyUntil = 0;
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    input.runFork(
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) < emptyUntil) return;
        const exit = yield* input.launchctlGetenv.pipe(
          Effect.flatMap((value) =>
            value === undefined
              ? Effect.succeed(undefined)
              : input
                  .socketExists(value)
                  .pipe(Effect.map((exists) => (exists ? value : undefined))),
          ),
          Effect.exit,
        );
        cached = exit._tag === "Success" ? exit.value : undefined;
        emptyUntil =
          cached === undefined ? (yield* Clock.currentTimeMillis) + EMPTY_LOOKUP_RETRY_MS : 0;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            refreshing = false;
          }),
        ),
      ),
    );
  };
  if (processValue === undefined) refresh();
  const current = Effect.gen(function* () {
    if (processValue !== undefined && (yield* input.socketExists(processValue))) {
      return processValue;
    }
    // The agent socket moves when the agent restarts; drop a stale value and
    // look again in the background.
    if (cached !== undefined && (yield* input.socketExists(cached))) return cached;
    cached = undefined;
    refresh();
    return undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
  return { current };
};

export const launchctlGetenvSshAuthSock: Effect.Effect<
  string | undefined,
  never,
  ProcessRunner.ProcessRunner
> = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner.run({
    command: "/bin/launchctl",
    args: ["getenv", "SSH_AUTH_SOCK"],
    timeout: "2 seconds",
    maxOutputBytes: 4096,
    outputMode: "truncate",
    timeoutBehavior: "timedOutResult",
  });
  if (result.code !== 0 || result.timedOut) return undefined;
  return result.stdout.trim() || undefined;
}).pipe(Effect.orElseSucceed(() => undefined));
