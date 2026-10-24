// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// The exact cmd-shim template npm writes for a native executable.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];
const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

function readFileSyncOrUndefined(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isFileSync(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve only npm's native executable shim. A native executable started through
 * cmd.exe can outlive libuv's Windows kill-on-close job; spawning it directly
 * keeps its lifetime bound to its parent. Custom scripts must still run as-is.
 */
export function npmShimExecutable(
  shimPath: string,
  readFile: (filePath: string) => string | undefined = readFileSyncOrUndefined,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  const path = NodePath.win32;
  if (path.extname(shimPath).toLowerCase() !== ".cmd") return undefined;
  // CMD preserves trailing whitespace in unquoted SET values, so never trim.
  const lines = readFile(shimPath)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }
  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1)!)?.[1];
  if (target === undefined) return undefined;
  const executable = path.join(path.dirname(shimPath), target);
  return isFile(executable) ? executable : undefined;
}
