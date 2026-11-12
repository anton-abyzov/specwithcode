// @effect-diagnostics nodeBuiltinImport:off -- a fire-and-forget check that must never wait on, or be cancelled with, the request that reads it.
/**
 * Whether this machine can run iOS Simulators: macOS with Xcode selected and
 * its `simctl` answering. Machines report it to each other so work that needs
 * a simulator is placed on a Mac. The check runs in the background once and
 * is kept; nothing waits for it, and a read before it finishes is unknown.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Context from "effect/Context";

const CHECK_TIMEOUT_MS = 5_000;
/** A "no" is checked again after this long, so installing Xcode is noticed without a restart. */
export const IOS_SIMULATOR_RECHECK_MS = 10 * 60_000;
/** A check that could not tell (it timed out) runs again after this long. */
export const UNKNOWN_RECHECK_MS = 60_000;

export interface IosSimulatorProbe {
  /**
   * The last answer, or undefined while the first check runs. Starts a check
   * when none has run or a "no" is old, and never waits for it. Ask it only
   * on macOS: anywhere else the answer is no without checking.
   */
  readonly current: () => boolean | undefined;
}

/** A check answers yes, no, or undefined when it could not tell; undefined stays unknown. */
export const makeIosSimulatorProbe = (input: {
  readonly check: () => Promise<boolean | undefined>;
  readonly now?: () => number;
}): IosSimulatorProbe => {
  const now = input.now ?? Date.now;
  let answer: { readonly value: boolean | undefined; readonly at: number } | undefined;
  let running = false;
  const start = () => {
    if (running) return;
    running = true;
    void input
      .check()
      .catch(() => false)
      .then((value) => {
        answer = { value, at: now() };
        running = false;
      });
  };
  const stale = (kept: { readonly value: boolean | undefined; readonly at: number }) =>
    kept.value === undefined
      ? now() - kept.at >= UNKNOWN_RECHECK_MS
      : !kept.value && now() - kept.at >= IOS_SIMULATOR_RECHECK_MS;
  return {
    current: () => {
      if (answer === undefined || stale(answer)) start();
      return answer?.value;
    },
  };
};

/**
 * Runs one developer tool; ok is a zero exit within the time limit, and
 * timedOut is set when the time limit stopped it. Never throws.
 */
export type DeveloperToolRunner = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<{ readonly ok: boolean; readonly stdout: string; readonly timedOut?: boolean }>;

export const runDeveloperTool: DeveloperToolRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      NodeChildProcess.execFile(
        command,
        [...args],
        { timeout: timeoutMs ?? CHECK_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
        (error, stdout) =>
          resolve({
            ok: error === null,
            stdout: String(stdout ?? ""),
            ...(error?.killed === true ? { timedOut: true } : {}),
          }),
      );
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });

/**
 * Runs the selected Xcode's own `simctl`, not `xcrun`: on a Mac without
 * developer tools `xcrun` opens an install dialog, and `xcode-select -p`
 * (which honors DEVELOPER_DIR) does not.
 */
const simctlAnswers = async (): Promise<boolean> => {
  const selected = await runDeveloperTool("xcode-select", ["-p"]);
  const developerDir = selected.stdout.trim();
  if (!selected.ok || developerDir === "") return false;
  return (await runDeveloperTool(NodePath.join(developerDir, "usr", "bin", "simctl"), ["help"])).ok;
};

/** This server's answer, shared by everything that reports it. */
export const iosSimulatorProbe = makeIosSimulatorProbe({ check: simctlAnswers });

/** The check a server reads, replaceable in tests so they never spawn Xcode tools. */
export const IosSimulatorSupport = Context.Reference<IosSimulatorProbe>(
  "specweave-studio/device/IosSimulatorSupport",
  { defaultValue: () => iosSimulatorProbe },
);
