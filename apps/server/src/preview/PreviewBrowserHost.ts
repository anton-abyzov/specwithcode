/**
 * Host setup the shared headless browser needs, and the one command that does
 * it. Every failure here names that command, so the server log, an agent's tool
 * error, and the viewer all offer the same fix: `sudo specweave-studio browser setup`.
 *
 * Studio never turns Chrome's sandbox off by itself. A host that cannot give it one
 * gets the command instead, and only the operator's explicit
 * `STUDIO_SERVER_BROWSER_SANDBOX=0` launches without it.
 */
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The subcommand that sets the host up; callers render it, with `sudo`, for how Studio was launched. */
export const SETUP_SUBCOMMAND = "browser setup";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

/**
 * What Chrome prints before aborting when its GPU process keeps failing to
 * start, as it does when the server runs inside another sandbox, such as
 * `sandbox-exec` or a locked-down container, that Chrome cannot nest its own in.
 */
export const GPU_UNUSABLE_SIGNATURE = "GPU process isn't usable";

const MAX_LAST_ERROR_CHARS = 300;
// Chrome's log prefix: `[pid:tid/MMDD/HHMMSS.micros:LEVEL:file.cc(:line)] `.
const CHROME_LOG_LINE = /^\[[^\]]*:(VERBOSE\d*|INFO|WARNING|ERROR|FATAL):[^\]]*\]\s*/;

/**
 * The browser's own last error from the end of its stderr: its last FATAL or
 * ERROR line without Chrome's log prefix, else its last line. Undefined when
 * it printed nothing.
 */
export const browserLastError = (output: string): string | undefined => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const level = (line: string) => CHROME_LOG_LINE.exec(line)?.[1];
  const chosen =
    lines.findLast((line) => level(line) === "FATAL") ??
    lines.findLast((line) => level(line) === "ERROR") ??
    lines.at(-1);
  if (chosen === undefined) return undefined;
  const text = chosen.replace(CHROME_LOG_LINE, "");
  return text.length > MAX_LAST_ERROR_CHARS ? `${text.slice(0, MAX_LAST_ERROR_CHARS)}…` : text;
};

// Playwright logs each stderr line of the browser it launched as `[pid=N][err] …`, and its
// launch error repeats them under "Browser logs" and, as `- …`, under "Call log".
const PLAYWRIGHT_STDERR_LINE = /^(?:-\s+)?\[pid=\d+\]\[err\]\s?(.*)$/;
const PLAYWRIGHT_STDERR_LINES = 40;
// Playwright replaces the log with its own note when Chrome's sandbox failed.
const PLAYWRIGHT_SANDBOX_NOTE = /sandboxing failed/i;

/**
 * The browser's last stderr lines from a Playwright launch error, for
 * {@link diagnoseLaunchFailure}. Playwright's sandbox note stands for Chrome's
 * abort message, which it drops. Empty when the error holds neither.
 */
export const playwrightBrowserOutput = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = PLAYWRIGHT_STDERR_LINE.exec(line.trim());
      return match === null ? [] : [match[1]!];
    })
    .slice(-PLAYWRIGHT_STDERR_LINES);
  if (PLAYWRIGHT_SANDBOX_NOTE.test(text)) lines.push(NO_SANDBOX_SIGNATURE);
  return lines.join("\n");
};

/** The operator's opt-out that runs the browser without Chrome's sandbox. */
export const SANDBOX_OPT_OUT = "STUDIO_SERVER_BROWSER_SANDBOX=0";

/** Whether an operator explicitly allowed Chrome to run without its sandbox. */
export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.STUDIO_SERVER_BROWSER_SANDBOX === "0";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/studio-chrome-headless-shell";

/**
 * Lets Studio's headless browser, in any Studio home and at any pinned version, create
 * the user namespace Chrome's sandbox runs in. Modelled on the profile Ubuntu
 * ships for Google Chrome; `unconfined` adds nothing beyond `userns`.
 */
export const APPARMOR_PROFILE = `# Written by \`specweave-studio browser setup\`: lets SpecWithCode's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile studio-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/studio-chrome-headless-shell>
}
`;

/**
 * Chrome's Debian dependencies that minimal images leave out, from the headless
 * shell's deb.deps. Ubuntu 24.04 and Debian 13 renamed some with a `t64`
 * suffix; setup installs whichever name the host's apt offers.
 */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
];

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox SpecWithCode's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries SpecWithCode's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

export class PreviewBrowserGpuError extends Schema.TaggedError<PreviewBrowserGpuError>()(
  "PreviewBrowserGpuError",
  /** `sandboxOff`: the browser already ran without Chrome's sandbox, so the opt-out cannot help. */
  { lastError: Schema.String, sandboxOff: Schema.Boolean },
) {
  override get message(): string {
    const quit = `SpecWithCode's browser quit because its GPU process could not start (Chrome: "${this.lastError}")`;
    const why =
      "This happens when the server runs inside another sandbox, such as sandbox-exec or a locked-down container.";
    return this.sandboxOff
      ? `${quit}, even without Chrome's sandbox. ${why} Start the server outside it, then try again.`
      : `${quit}. ${why} Start the server outside it, or set ${SANDBOX_OPT_OUT} for the server to run the browser without Chrome's sandbox, then try again.`;
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserGpuError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;

/**
 * After a launch fails, names the host setup it is missing: the sandbox, from
 * Chrome's own abort message, shared libraries, from `ldd` (Linux only), or a
 * GPU process that cannot start inside an outer sandbox. Undefined when none
 * explains it.
 */
export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
    /** Whether the browser ran without Chrome's sandbox, from {@link sandboxDisabled}. */
    readonly sandboxOff?: boolean;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      return new PreviewBrowserSandboxError({ setupCommand });
    }
    // A missing library can also take the GPU process down, and setup fixes that.
    if ((yield* HostProcessPlatform) === "linux") {
      const libraries = yield* missingLibraries(input.executable);
      if (libraries.length > 0)
        return new PreviewBrowserLibrariesError({ setupCommand, libraries });
    }
    if (input.output.includes(GPU_UNUSABLE_SIGNATURE)) {
      return new PreviewBrowserGpuError({
        lastError: browserLastError(input.output) ?? `${GPU_UNUSABLE_SIGNATURE}.`,
        sandboxOff: input.sandboxOff === true,
      });
    }
    return undefined;
  },
);

/** {@link diagnoseLaunchFailure} for a Playwright launch error, from the browser's stderr in it. */
export const diagnosePlaywrightLaunch = (input: {
  readonly executable: string;
  readonly cause: unknown;
  readonly setupCommand: string;
  readonly sandboxOff?: boolean;
}) =>
  diagnoseLaunchFailure({
    executable: input.executable,
    setupCommand: input.setupCommand,
    output: playwrightBrowserOutput(input.cause),
    ...(input.sandboxOff === undefined ? {} : { sandboxOff: input.sandboxOff }),
  });

/** Shared libraries the loader cannot find for `executable`, by `ldd`. */
export const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const report = yield* spawner
    .string(ChildProcess.make("ldd", [executable], { stdin: "ignore", stderr: "ignore" }))
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return [...report.matchAll(MISSING_LIBRARY)].map((match) => match[1]!);
});

/**
 * Whether Chrome's sandbox will be blocked here: the host restricts user
 * namespaces and Studio's AppArmor profile is not installed. Readable without
 * root, so the server checks it at startup.
 */
export const sandboxBlocked = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  if (!restricted) return false;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));
