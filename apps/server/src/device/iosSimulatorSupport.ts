// @effect-diagnostics nodeBuiltinImport:off -- a fire-and-forget check that must never wait on, or be cancelled with, the request that reads it.
/**
 * Whether this machine can run iOS Simulators, and if not, which setup step
 * is missing. Machines report a yes or no to each other so work that needs a
 * simulator is placed on a Mac; the local device host reports the step. The
 * check runs in the background and is kept; ordinary reads never wait for it,
 * and a read before it finishes is unknown. "Check again" forces a fresh one.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
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

/**
 * A background check kept between reads: a yes is kept, a no is checked again
 * after `IOS_SIMULATOR_RECHECK_MS` and an unknown after `UNKNOWN_RECHECK_MS`.
 * `read({ force: true })` runs a fresh check whatever is kept.
 */
export interface KeptCheck<A> {
  /** The kept answer without waiting; starts a check when none is kept or it is old. */
  readonly current: () => A | undefined;
  /** Waits for an answer: the kept one while it is fresh, a fresh one when forced. */
  readonly read: (options?: { readonly force?: boolean }) => Promise<A>;
}

export const makeKeptCheck = <A>(input: {
  readonly check: () => Promise<A>;
  /** How a kept answer ages: a yes is kept, a no and an unknown are checked again. */
  readonly classify: (value: A) => "yes" | "no" | "unknown";
  /** The answer when the check itself throws. */
  readonly onFailure: A;
  readonly now?: () => number;
}): KeptCheck<A> => {
  const now = input.now ?? Date.now;
  let answer: { readonly value: A; readonly at: number; readonly run: number } | undefined;
  let running: { readonly promise: Promise<A>; readonly forced: boolean } | undefined;
  let runs = 0;
  const start = (forced: boolean) => {
    const run = ++runs;
    const promise = input
      .check()
      .catch(() => input.onFailure)
      .then((value) => {
        // A slower, older run never replaces a newer answer.
        if (answer === undefined || answer.run < run) answer = { value, at: now(), run };
        if (running?.promise === promise) running = undefined;
        return value;
      });
    running = { promise, forced };
    return promise;
  };
  const stale = (kept: { readonly value: A; readonly at: number }) => {
    const kind = input.classify(kept.value);
    return kind === "unknown"
      ? now() - kept.at >= UNKNOWN_RECHECK_MS
      : kind === "no" && now() - kept.at >= IOS_SIMULATOR_RECHECK_MS;
  };
  return {
    current: () => {
      if (running === undefined && (answer === undefined || stale(answer))) start(false);
      return answer?.value;
    },
    read: (options) => {
      if (options?.force === true) return running?.forced ? running.promise : start(true);
      if (answer !== undefined && !stale(answer)) return Promise.resolve(answer.value);
      return running?.promise ?? start(false);
    },
  };
};

/** A check answers yes, no, or undefined when it could not tell; undefined stays unknown. */
export const makeIosSimulatorProbe = (input: {
  readonly check: () => Promise<boolean | undefined>;
  readonly now?: () => number;
}): IosSimulatorProbe => {
  const kept = makeKeptCheck<boolean | undefined>({
    check: input.check,
    classify: (value) => (value === undefined ? "unknown" : value ? "yes" : "no"),
    onFailure: false,
    ...(input.now ? { now: input.now } : {}),
  });
  return { current: kept.current };
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

/** How long a `simctl list` may take; a cold CoreSimulator start can take several seconds. */
export const SIMCTL_LIST_TIMEOUT_MS = 15_000;

/** What stops iOS Simulators on a Mac, in the order a person fixes them. */
export type IosSetupStatus =
  | "ready"
  | "xcode_missing"
  | "xcode_not_selected"
  | "xcode_setup_unfinished"
  | "ios_runtime_missing"
  | "ios_simulator_missing"
  /** A tool timed out, so the check could not tell. */
  | "unknown";

export interface IosSimulatorSetup {
  readonly status: IosSetupStatus;
  /** The Xcode app bundle found, selected or in Applications. */
  readonly xcodeAppPath: string | null;
  /** The selected developer folder's `simctl help` exited 0. */
  readonly simctlAnswered: boolean;
}

const developerDirApp = (developerDir: string) =>
  /^(.*\.app)\/Contents\/Developer\/?$/.exec(developerDir)?.[1] ?? null;

/** Available iOS runtimes in `simctl list runtimes -j`, by identifier. */
const iosRuntimeIds = (stdout: string): ReadonlySet<string> | null => {
  try {
    const parsed = JSON.parse(stdout) as {
      readonly runtimes?: ReadonlyArray<{
        readonly identifier?: unknown;
        readonly platform?: unknown;
        readonly isAvailable?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.runtimes)) return null;
    return new Set(
      parsed.runtimes
        .filter(
          (runtime) =>
            runtime.isAvailable !== false &&
            typeof runtime.identifier === "string" &&
            (runtime.platform === "iOS" ||
              (runtime.platform === undefined && runtime.identifier.includes(".SimRuntime.iOS-"))),
        )
        .map((runtime) => runtime.identifier as string),
    );
  } catch {
    return null;
  }
};

/** Whether `simctl list devices available -j` holds a device on one of these runtimes. */
const hasIosDevice = (stdout: string, runtimes: ReadonlySet<string>): boolean | null => {
  try {
    const parsed = JSON.parse(stdout) as {
      readonly devices?: Record<string, ReadonlyArray<{ readonly isAvailable?: unknown }>>;
    };
    if (parsed.devices === null || typeof parsed.devices !== "object") return null;
    return Object.entries(parsed.devices).some(
      ([runtime, devices]) =>
        runtimes.has(runtime) &&
        Array.isArray(devices) &&
        devices.some((device) => device.isAvailable !== false),
    );
  } catch {
    return null;
  }
};

/**
 * The full iOS Simulator check on a Mac. It runs the selected developer
 * folder's own `simctl`, not `xcrun`: on a Mac without developer tools `xcrun`
 * opens an install dialog, and `xcode-select -p` (which honors DEVELOPER_DIR)
 * does not. Xcode counts as installed only when its app bundle was found, and
 * as working only when that `simctl` answered.
 */
export const makeIosSimulatorSetupCheck =
  (input: {
    readonly run: DeveloperToolRunner;
    /** Xcode app bundles in the Applications folders, by full path. */
    readonly findXcodeApps: () => Promise<ReadonlyArray<string>>;
  }) =>
  async (): Promise<IosSimulatorSetup> => {
    const selected = await input.run("xcode-select", ["-p"]);
    const developerDir = selected.ok ? selected.stdout.trim() : "";
    const selectedApp = developerDir === "" ? null : developerDirApp(developerDir);
    const help =
      developerDir === ""
        ? { ok: false as const, timedOut: false }
        : // A macOS path, whatever machine runs this code.
          await input.run(NodePath.posix.join(developerDir, "usr", "bin", "simctl"), ["help"]);
    if (help.timedOut === true)
      return { status: "unknown", xcodeAppPath: selectedApp, simctlAnswered: false };
    if (!help.ok) {
      if (selectedApp !== null)
        return {
          status: "xcode_setup_unfinished",
          xcodeAppPath: selectedApp,
          simctlAnswered: false,
        };
      const found = (await input.findXcodeApps().catch(() => []))[0] ?? null;
      return {
        status: found === null ? "xcode_missing" : "xcode_not_selected",
        xcodeAppPath: found,
        simctlAnswered: false,
      };
    }
    // A developer folder outside an app bundle (DEVELOPER_DIR) whose simctl answers is a working Xcode.
    const xcodeAppPath = selectedApp ?? developerDir;
    const simctl = NodePath.posix.join(developerDir, "usr", "bin", "simctl");
    const answered = (status: IosSetupStatus): IosSimulatorSetup => ({
      status,
      xcodeAppPath,
      simctlAnswered: true,
    });
    const runtimesRun = await input.run(simctl, ["list", "runtimes", "-j"], SIMCTL_LIST_TIMEOUT_MS);
    if (runtimesRun.timedOut === true) return answered("unknown");
    const runtimes = runtimesRun.ok ? iosRuntimeIds(runtimesRun.stdout) : null;
    if (runtimes === null) return answered("xcode_setup_unfinished");
    if (runtimes.size === 0) return answered("ios_runtime_missing");
    const devicesRun = await input.run(
      simctl,
      ["list", "devices", "available", "-j"],
      SIMCTL_LIST_TIMEOUT_MS,
    );
    if (devicesRun.timedOut === true) return answered("unknown");
    const device = devicesRun.ok ? hasIosDevice(devicesRun.stdout, runtimes) : null;
    if (device === null) return answered("unknown");
    return answered(device ? "ready" : "ios_simulator_missing");
  };

/** Xcode*.app in /Applications and ~/Applications. */
const findXcodeApps = async (): Promise<ReadonlyArray<string>> => {
  const folders = ["/Applications", NodePath.join(NodeOs.homedir(), "Applications")];
  const found: string[] = [];
  for (const folder of folders) {
    const names = await NodeFs.readdir(folder).catch(() => [] as string[]);
    for (const name of names.toSorted())
      if (/^Xcode.*\.app$/.test(name)) found.push(NodePath.join(folder, name));
  }
  return found;
};

/** A kept setup check; a ready Mac is kept, anything else is checked again. */
export const makeIosSimulatorSetup = (input: {
  readonly check: () => Promise<IosSimulatorSetup>;
  readonly now?: () => number;
}): KeptCheck<IosSimulatorSetup> =>
  makeKeptCheck({
    check: input.check,
    classify: (setup) =>
      setup.status === "unknown" ? "unknown" : setup.status === "ready" ? "yes" : "no",
    onFailure: { status: "xcode_missing", xcodeAppPath: null, simctlAnswered: false },
    ...(input.now ? { now: input.now } : {}),
  });

/** This server's setup check. Ask it only on macOS. */
export const iosSimulatorSetup = makeIosSimulatorSetup({
  check: makeIosSimulatorSetupCheck({ run: runDeveloperTool, findXcodeApps }),
});

/**
 * The answer to "do simulators run here", shared by everything that reports
 * it: yes once the selected Xcode's `simctl` answers, even before a simulator
 * exists. It reads the setup check, so a forced recheck updates it.
 */
export const iosSimulatorProbeFrom = (setup: KeptCheck<IosSimulatorSetup>): IosSimulatorProbe => ({
  current: () => {
    const answer = setup.current();
    if (answer === undefined) return undefined;
    if (answer.simctlAnswered) return true;
    return answer.status === "unknown" ? undefined : false;
  },
});

/** This server's answer. */
export const iosSimulatorProbe = iosSimulatorProbeFrom(iosSimulatorSetup);

/** The check a server reads, replaceable in tests so they never spawn Xcode tools. */
export const IosSimulatorSupport = Context.Reference<IosSimulatorProbe>(
  "specweave-studio/device/IosSimulatorSupport",
  { defaultValue: () => iosSimulatorProbe },
);

/** The setup check the local device host reads, replaceable in tests. */
export const IosSimulatorSetupSupport = Context.Reference<KeptCheck<IosSimulatorSetup>>(
  "specweave-studio/device/IosSimulatorSetupSupport",
  { defaultValue: () => iosSimulatorSetup },
);
