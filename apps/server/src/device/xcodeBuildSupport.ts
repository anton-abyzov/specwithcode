// @effect-diagnostics nodeBuiltinImport:off -- a fire-and-forget check that must never wait on, or be cancelled with, the request that reads it.
/**
 * Whether full Xcode builds work on this machine: macOS with a full Xcode
 * selected, so `xcodebuild -version` exits 0. Command Line Tools alone has no
 * `xcodebuild`, so it reads as no. Machines report it so a Mac build goes to a
 * Mac that can do it. Checked in the background once and kept, like the iOS
 * Simulator check; nothing waits for it.
 */
import * as NodePath from "node:path";
import * as Context from "effect/Context";

import {
  type DeveloperToolRunner,
  type IosSimulatorProbe,
  iosSimulatorProbe,
  makeIosSimulatorProbe,
  runDeveloperTool,
} from "./iosSimulatorSupport.ts";

/** A first `xcodebuild` run can be slow while it loads its plug-ins. */
export const XCODEBUILD_TIMEOUT_MS = 20_000;

/**
 * The check itself. On macOS it runs the selected Xcode's own `xcodebuild`
 * (from `xcode-select -p`), never the `/usr/bin` shim, which can open an
 * install dialog. Anywhere else it is no without running anything. A run
 * stopped by the time limit is unknown, not no, and is checked again soon.
 */
export const makeXcodeBuildCheck =
  (input: { readonly os: string; readonly run: DeveloperToolRunner }) =>
  async (): Promise<boolean | undefined> => {
    if (input.os !== "darwin") return false;
    const selected = await input.run("xcode-select", ["-p"]);
    const developerDir = selected.stdout.trim();
    if (!selected.ok || developerDir === "") return false;
    const xcodebuild = NodePath.join(developerDir, "usr", "bin", "xcodebuild");
    const version = await input.run(xcodebuild, ["-version"], XCODEBUILD_TIMEOUT_MS);
    return version.timedOut === true ? undefined : version.ok;
  };

/** This server's answer, shared by everything that reports it. */
export const xcodeBuildProbe: IosSimulatorProbe = makeIosSimulatorProbe({
  check: makeXcodeBuildCheck({ os: process.platform, run: runDeveloperTool }),
});

/** Starts both background checks on a Mac at server start; nothing waits for them. */
export const startDeveloperToolChecks = () => {
  iosSimulatorProbe.current();
  xcodeBuildProbe.current();
};

/** The check a server reads, replaceable in tests so they never spawn Xcode tools. */
export const XcodeBuildSupport = Context.Reference<IosSimulatorProbe>(
  "specweave-studio/device/XcodeBuildSupport",
  { defaultValue: () => xcodeBuildProbe },
);
