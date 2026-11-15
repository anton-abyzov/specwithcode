// @effect-diagnostics globalTimers:off globalDate:off -- The child-process deadline and clock live at this Node boundary, outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off - Exclusive creates, no-follow reads and in-place appends on the user's own files, which effect/FileSystem cannot express.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  CommandLineToolFileSystem,
  CommandLineToolHost,
  CommandLineToolPlatform,
  EntryInfo,
  RunResult,
} from "./commandLineTool.ts";

const MAX_OUTPUT_BYTES = 256 * 1024;

const nodeFileSystem: CommandLineToolFileSystem = {
  lstat: async (path) => {
    const info = await NodeFSP.lstat(path).catch(() => null);
    if (info === null) return null;
    let kind: EntryInfo["kind"] = "other";
    if (info.isSymbolicLink()) kind = "symlink";
    else if (info.isFile()) kind = "file";
    else if (info.isDirectory()) kind = "directory";
    return { kind };
  },
  readlink: (path) => NodeFSP.readlink(path).catch(() => null),
  exists: (path) =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    ),
  realpath: (path) => NodeFSP.realpath(path).catch(() => null),
  isExecutableFile: async (path) => {
    const info = await NodeFSP.stat(path).catch(() => null);
    if (info === null || !info.isFile()) return false;
    return NodeFSP.access(path, NodeFS.constants.X_OK).then(
      () => true,
      () => false,
    );
  },
  isOnReadOnlyVolume: (path) =>
    NodeFSP.access(path, NodeFS.constants.W_OK).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "EROFS",
    ),
  readFile: async (path, maxBytes) => {
    // O_NONBLOCK: a FIFO at this path must not wait for a writer.
    const handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
    ).catch(() => null);
    if (handle === null) return null;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return null;
      return await handle.readFile("utf8");
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
  makeDirectory: async (path) => {
    await NodeFSP.mkdir(path, { recursive: true, mode: 0o755 });
  },
  symlink: (target, path) => NodeFSP.symlink(target, path),
  writeNewFile: async (path, text, mode) => {
    const handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
      mode,
    );
    try {
      await handle.writeFile(text);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => NodeFSP.rename(from, to),
  unlink: (path) => NodeFSP.unlink(path),
  appendFile: (path, text) => NodeFSP.appendFile(path, text, { mode: 0o644 }),
  rewriteFile: (path, text) => NodeFSP.writeFile(path, text),
};

/** How long to wait for output after the program itself exits, when something it started holds the pipes. */
const DRAIN_AFTER_EXIT_MS = 250;

const makeRun =
  (platform: CommandLineToolPlatform): CommandLineToolHost["run"] =>
  (command, args, options) =>
    new Promise<RunResult | null>((resolve) => {
      // Its own process group on macOS and Linux, so a timeout stops whatever the shell started.
      const detached = platform !== "win32";
      let settled = false;
      let child: NodeChildProcess.ChildProcess;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) into.push(chunk);
      };
      const stop = () => {
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const done = (value: RunResult | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const finish = (code: number | null) =>
        done({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      try {
        child = NodeChildProcess.spawn(command, [...args], {
          detached,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: command.toLowerCase().endsWith("cmd.exe"),
          env:
            options.inheritEnv === false
              ? { ...options.env }
              : { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: undefined },
        });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        stop();
        done(null);
      }, options.timeoutMs);
      child.stdout?.on("data", collect(stdout));
      child.stderr?.on("data", collect(stderr));
      child.on("error", () => done(null));
      child.on("close", (code) => finish(code));
      child.on("exit", (code) => {
        // A daemon from a startup file may keep the pipes open: answer with what came so far.
        setTimeout(() => {
          if (settled) return;
          stop();
          finish(code);
        }, DRAIN_AFTER_EXIT_MS).unref();
      });
    });

/** The running app's bundle: the `.app` on macOS, the install folder elsewhere. */
export const bundlePathFor = (platform: NodeJS.Platform, resourcesPath: string): string => {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return platform === "darwin"
    ? path.dirname(path.dirname(resourcesPath))
    : path.dirname(resourcesPath);
};

export const makeNodeCommandLineToolHost = (input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly appVersion: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
}): CommandLineToolHost | null => {
  if (input.platform !== "darwin" && input.platform !== "linux" && input.platform !== "win32") {
    return null;
  }
  const platform: CommandLineToolPlatform = input.platform;
  let userShell: string | undefined;
  try {
    userShell = NodeOS.userInfo().shell ?? undefined;
  } catch {
    userShell = undefined;
  }
  return {
    platform,
    homeDirectory: input.homeDirectory,
    env: process.env,
    userShell: process.env.SHELL || userShell,
    appVersion: input.appVersion,
    isPackaged: input.isPackaged,
    bundlePath: bundlePathFor(platform, input.resourcesPath),
    resourcesPath: input.resourcesPath,
    fs: nodeFileSystem,
    run: makeRun(platform),
    uniqueSuffix: () => NodeCrypto.randomUUID(),
    now: () => Date.now(),
  };
};
