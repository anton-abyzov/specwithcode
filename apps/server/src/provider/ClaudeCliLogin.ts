/**
 * Claude Code's own sign-in, run for the person: `claude auth login` with no
 * terminal. The app reads the link the command prints and hands a pasted code
 * to it. Claude Code saves its own sign-in; the app never reads a token.
 *
 * The rules here follow what the command printed on macOS, Windows and Linux
 * (CLI 2.1.302 and 2.1.322) when it was started with pipes instead of a terminal:
 *
 * - stdout carries "Opening browser to sign in…", then a line with a link whose
 *   page shows a code, then "Paste code here if prompted > ".
 * - It also opens a browser on its own machine. `BROWSER` set to one program's
 *   path replaces that browser on all three systems.
 * - A refused code ends it with exit code 1 and "Login failed: …" on stderr.
 * - Interrupted, it exits 0 on macOS and Linux, so the exit code proves nothing.
 *
 * @module provider/ClaudeCliLogin
 */
import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";

export const CLAUDE_LOGIN_ARGS = ["auth", "login"] as const;
export const CLAUDE_LOGOUT_ARGS = ["auth", "logout"] as const;

/** A person may need minutes for a password manager or a second factor. */
const SIGN_IN_LIMIT_MS = 600_000;
const SIGN_OUT_LIMIT: Duration.Input = "20 seconds";

/** The command prints its link within a second; this covers a slow start. */
const LINK_LIMIT: Duration.Input = "30 seconds";
/** A link at the very end of the output is taken once nothing has followed it for this long. */
const LINK_QUIET: Duration.Input = "750 millis";
/** What people set `BROWSER` to so that nothing opens one. */
const NO_BROWSER_VALUES = /^(?:|none|true|false|echo|:)$/iu;
/** Output is kept to find the link and the last line, not as a log. */
const OUTPUT_LIMIT = 32_768;

// Colour codes and terminal hyperlinks, in case a later version adds them.
const TERMINAL_CODES =
  // oxlint-disable-next-line no-control-regex -- escape sequences are what this removes
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

/**
 * The link the command prints for a browser on any device. It is found by its
 * shape, not by the sentence before it, which may be reworded. Only a link
 * with something after it counts: output arrives in pieces, and a piece that
 * stops inside the link would read as a shorter link.
 */
export function readClaudeLoginLink(output: string): string | undefined {
  for (const match of output
    .replace(TERMINAL_CODES, "")
    .matchAll(/https:\/\/[^\s"'<>]+(?=[\s"'<>])/gu)) {
    try {
      const url = new URL(match[0]);
      if (url.pathname.includes("/oauth/authorize") && url.searchParams.has("state")) {
        return match[0];
      }
    } catch {
      // Not an address after all; keep looking.
    }
  }
  return undefined;
}

/** Two parts of visible characters joined by one `#`: nothing that could start a second line. */
const CODE_LINE = /^[!-"$-~]+#[!-"$-~]+$/u;

/**
 * What the person pasted, as the line the command expects: `code#state`. They
 * may paste the code from the page, or the address of the page that shows it.
 * The command gives no second prompt after a line it cannot read, so a wrong
 * shape is refused here. The result is always one line.
 */
export function readClaudeLoginCode(pasted: string): string | undefined {
  let text = pasted.trim();
  if (/^https?:\/\//iu.test(text)) {
    try {
      const url = new URL(text);
      // An address may carry an encoded line break or `#`; the check below refuses those.
      text = `${url.searchParams.get("code")?.trim() ?? ""}#${url.searchParams.get("state")?.trim() ?? ""}`;
    } catch {
      return undefined;
    }
  }
  return CODE_LINE.test(text) ? text : undefined;
}

const NOT_STARTED = "Could not start Claude Code's sign-in. Check that Claude Code is installed.";

export type ClaudeLoginEnd =
  | { readonly signedIn: true }
  | { readonly signedIn: false; readonly detail: string };

/** How the command ended, in words for the person. Never quotes more than one line of it. */
export function readClaudeLoginEnd(output: string, exitCode: number | undefined): ClaudeLoginEnd {
  const text = output.replace(TERMINAL_CODES, "");
  if (exitCode === 0 && /Login successful/u.test(text)) return { signedIn: true };
  const refused = /Login failed:\s*([^\r\n]*)/u.exec(text)?.[1]?.trim();
  if (refused !== undefined) {
    const reason = refused.slice(0, 240);
    return {
      signedIn: false,
      detail:
        reason.length > 0
          ? `Claude did not accept the sign-in. Start again to get a new page. Claude Code said: ${reason}`
          : "Claude did not accept the sign-in. Start again to get a new page.",
    };
  }
  // No exit code and not a word: the command never ran.
  if (exitCode === undefined && text.trim().length === 0) {
    return { signedIn: false, detail: NOT_STARTED };
  }
  return {
    signedIn: false,
    detail: "Claude Code's sign-in stopped before it finished. Start again.",
  };
}

export interface ClaudeCliLoginInput {
  readonly instanceId: ProviderInstanceId;
  /** The Claude Code command or path this instance runs. */
  readonly binaryPath: string;
  /** The instance's environment, with its `CLAUDE_CONFIG_DIR` when it has one. */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  /**
   * True when the person's browser is on this machine: the command opens the
   * page itself and nothing has to be typed. False when they are on another
   * device, where a browser opened here would be seen by nobody.
   */
  readonly openBrowserHere: boolean;
  /**
   * Called once, when the command has printed its link. `sendCode` passes on
   * what the person pasted from that link's page.
   */
  readonly onLink: (
    link: string,
    sendCode: (pasted: string) => Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<void>;
  /** For tests. */
  readonly linkLimit?: Duration.Input | undefined;
}

/**
 * A program that takes the page's address and does nothing, so the command
 * opens no browser on this machine. Undefined where none could be set up; the
 * command then opens its browser, which is harmless.
 */
const noBrowserProgram = Effect.fn("ClaudeCliLogin.noBrowserProgram")(function* (
  platform: NodeJS.Platform,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  if (platform !== "win32") {
    for (const candidate of ["/usr/bin/true", "/bin/true"]) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
    return undefined;
  }
  // Windows has no such program, and the command runs a batch file given by path.
  const path = yield* Path.Path;
  return yield* fs.makeTempDirectoryScoped({ prefix: "specwithcode-sign-in-" }).pipe(
    Effect.flatMap((directory) => {
      const file = path.join(directory, "no-browser.cmd");
      return fs.writeFileString(file, "@exit /b 0\r\n").pipe(Effect.as(file));
    }),
    Effect.orElseSucceed(() => undefined),
  );
});

/**
 * Runs the sign-in to its end. Succeeds when Claude Code says it signed in;
 * the caller then checks the account itself. Interrupting it, or closing its
 * scope, stops the command.
 */
export const runClaudeCliLogin = Effect.fn("ClaudeCliLogin.run")(function* (
  input: ClaudeCliLoginInput,
): Effect.fn.Return<
  void,
  ProviderSetupError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const browser = input.openBrowserHere ? undefined : yield* noBrowserProgram(platform);
  const environment: NodeJS.ProcessEnv = { ...input.environment };
  if (browser !== undefined) environment.BROWSER = browser;
  // With the person here a browser must open, whatever the machine's shell says.
  else if (
    input.openBrowserHere &&
    environment.BROWSER !== undefined &&
    NO_BROWSER_VALUES.test(environment.BROWSER.trim())
  )
    delete environment.BROWSER;
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, CLAUDE_LOGIN_ARGS, {
    env: environment,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(Effect.mapError((cause) => failure("start", NOT_STARTED, cause)));
  yield* Effect.addFinalizer(() => child.kill({ forceKillAfter: "2 seconds" }).pipe(Effect.ignore));

  let output = "";
  let pieces = 0;
  const link = yield* Deferred.make<string>();
  const decoder = new TextDecoder();
  const read = (stream: typeof child.stdout) =>
    stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          pieces += 1;
          output = (output + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_LIMIT);
          const found = readClaudeLoginLink(output);
          return found === undefined ? Effect.void : Deferred.succeed(link, found);
        }),
      ),
      Effect.ignore,
    );
  const readers = yield* Effect.all([read(child.stdout), read(child.stderr)], {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.forkScoped);

  // A later version may print the link last, with nothing after it.
  yield* Effect.gen(function* () {
    let seen = -1;
    while (!(yield* Deferred.isDone(link))) {
      yield* Effect.sleep(LINK_QUIET);
      const found = seen === pieces ? readClaudeLoginLink(`${output}\n`) : undefined;
      if (found !== undefined) yield* Deferred.succeed(link, found);
      seen = pieces;
    }
  }).pipe(Effect.forkScoped);

  // stdin stays open for the whole sign-in: the code may come minutes later.
  const lines = yield* Queue.unbounded<Uint8Array>();
  yield* Stream.fromQueue(lines).pipe(Stream.run(child.stdin), Effect.ignore, Effect.forkScoped);
  const encoder = new TextEncoder();
  const sendCode = (pasted: string) =>
    Effect.suspend(() => {
      const line = readClaudeLoginCode(pasted);
      return line === undefined
        ? Effect.fail(
            failure(
              "complete",
              "That is not the whole code. Copy it from the page again: it has two parts joined by #.",
            ),
          )
        : Queue.offer(lines, encoder.encode(`${line}\n`)).pipe(Effect.asVoid);
    });

  const ended = yield* child.exitCode.pipe(
    Effect.map((code) => Number(code)),
    Effect.orElseSucceed(() => undefined),
    Effect.forkScoped,
  );
  /** The command's last words are read before its end is judged. */
  const end = Fiber.join(ended).pipe(
    Effect.tap(() => Fiber.join(readers).pipe(Effect.timeoutOption("1 second"))),
    Effect.map((exitCode) => readClaudeLoginEnd(output, exitCode)),
  );

  const found = yield* Effect.raceFirst(
    Deferred.await(link).pipe(Effect.map((address) => ({ address }))),
    end.pipe(Effect.map((result) => ({ result }))),
  ).pipe(
    Effect.timeoutOrElse({
      duration: input.linkLimit ?? LINK_LIMIT,
      orElse: () =>
        Effect.fail(
          failure(
            "start",
            "Claude Code did not show its sign-in page. Update Claude Code, then try again.",
          ),
        ),
    }),
  );
  if ("result" in found) {
    // It ended before any link: already signed in, or it could not start.
    if (found.result.signedIn) return;
    return yield* failure("start", found.result.detail);
  }
  yield* input.onLink(found.address, sendCode);

  const result = yield* end;
  if (!result.signedIn) return yield* failure("start", result.detail);
});

/** Runs `claude auth logout` for this instance's config folder. */
export const runClaudeCliLogout = Effect.fn("ClaudeCliLogin.logout")(function* (
  input: Pick<ClaudeCliLoginInput, "instanceId" | "binaryPath" | "environment" | "cwd">,
): Effect.fn.Return<void, ProviderSetupError, ChildProcessSpawner.ChildProcessSpawner> {
  const failure = (cause?: unknown) =>
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation: "logout",
      detail: "Claude Code could not sign out. Try again.",
      ...(cause === undefined ? {} : { cause }),
    });
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, CLAUDE_LOGOUT_ARGS, {
    env: input.environment,
  });
  const result = yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: input.environment,
      shell: spawnCommand.shell,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }),
  ).pipe(
    Effect.mapError((cause) => failure(cause)),
    Effect.timeoutOrElse({ duration: SIGN_OUT_LIMIT, orElse: () => Effect.fail(failure()) }),
  );
  if (result.code !== 0) return yield* failure();
});

const SIGN_IN_METHOD: ProviderAuthMethod = {
  id: "claude-account",
  name: "Claude account",
  description: null,
  type: "agent",
};

/**
 * The sign-in controller of one Claude instance. Claude Code keeps the sign-in
 * in the instance's config folder, so instances on one folder share it.
 */
export const makeClaudeCliAuth = Effect.fn("ClaudeCliLogin.makeAuth")(function* (
  input: Pick<ClaudeCliLoginInput, "instanceId" | "binaryPath" | "environment" | "cwd"> & {
    readonly configDir: string;
    /** Reads the account again, past any cached answer. */
    readonly checkAccount: Effect.Effect<ServerProvider>;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* ProviderAuthFlow.make({
    instanceId: input.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${input.configDir}` },
    methods: Effect.succeed([SIGN_IN_METHOD]),
    timeoutMs: SIGN_IN_LIMIT_MS,
    authenticate: (_methodId, context) =>
      Effect.gen(function* () {
        yield* runClaudeCliLogin({
          ...input,
          // A browser opened here is only seen when the person is at this machine.
          openBrowserHere: context.callbackMode === "server",
          onLink: (link, sendCode) =>
            context.setInteraction(
              {
                type: "browser",
                id: "claude-sign-in",
                url: link,
                requiresConsent: false,
                acceptsCallback: true,
              },
              undefined,
              sendCode,
            ),
        });
        yield* context.verifying;
        const account = yield* input.checkAccount;
        if (account.auth.status === "unauthenticated") {
          return yield* new ProviderSetupError({
            instanceId: input.instanceId,
            operation: "start",
            detail: "Claude Code finished its sign-in but still reports signed out. Try again.",
          });
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    logout: runClaudeCliLogout(input).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.andThen(input.checkAccount),
      Effect.asVoid,
    ),
  });
});
