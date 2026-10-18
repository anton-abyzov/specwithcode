// @effect-diagnostics nodeBuiltinImport:off - Probes the host compiler that the native regressions run with.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const probes = {
  clang: {
    file: "probe.m",
    source:
      "#import <Foundation/Foundation.h>\nint main(void) { @autoreleasepool { [NSObject new]; } }\n",
    args: ["-fobjc-arc", "-fsanitize=thread", "-framework", "Foundation"],
  },
  swiftc: {
    file: "probe.swift",
    source: "import Foundation\n_ = NSObject()\n",
    args: ["-swift-version", "5", "-sanitize=thread"],
  },
};

const describeFailure = (error: unknown) => {
  const failure = error as NodeJS.ErrnoException & { signal?: string | null; stderr?: string };
  if (failure.code === "ENOENT") return "it is not installed";
  if (failure.signal) return `the program was killed by ${failure.signal}`;
  const line = failure.stderr
    ?.split("\n")
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  return line ?? failure.message;
};

const developerDirectory = () => {
  try {
    return NodeChildProcess.execFileSync("xcode-select", ["--print-path"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "the selected developer directory";
  }
};

/**
 * Builds and runs an empty ThreadSanitizer program with the compiler that a native regression
 * uses, and returns why the regression can't run on this host, or `undefined` when it can.
 *
 * A toolchain older than the running macOS fails before any code under test runs: its linker
 * can't read the newer SDK, or its ThreadSanitizer runtime crashes while it starts.
 *
 * With CI set it throws instead: the PR gate (mobile native) and release.sh's stage 1 exist to run
 * these regressions, and a silent skip there let unpatched Expo 58 modules reach a release.
 */
export const threadSanitizerUnavailable = (compiler: keyof typeof probes): string | undefined => {
  const probe = probes[compiler];
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-toolchain-probe-"));
  try {
    const source = NodePath.join(directory, probe.file);
    const executable = NodePath.join(directory, "probe");
    NodeFS.writeFileSync(source, probe.source);
    try {
      NodeChildProcess.execFileSync(compiler, [...probe.args, source, "-o", executable], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
      });
      NodeChildProcess.execFileSync(executable, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000,
      });
      return undefined;
    } catch (error) {
      // A slow host is no verdict on the toolchain, so the regression runs and decides.
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") return undefined;
      const reason =
        `${compiler} from ${developerDirectory()} can't build and run a ` +
        `ThreadSanitizer program on this Mac (${describeFailure(error)}). Select a toolchain that ` +
        "supports this macOS release with xcode-select or DEVELOPER_DIR.";
      if (process.env.CI)
        throw new Error(`${reason} CI runs these regressions, so it can't skip them.`, { cause: error });
      return reason;
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};
