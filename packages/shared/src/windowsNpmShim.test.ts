import { describe, expect, it, vi } from "vite-plus/test";

import { npmShimExecutable } from "./windowsNpmShim.ts";

const shimPath = "C:\\Users\\Test User\\AppData\\Roaming\\npm\\opencode.cmd";
const executable =
  "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
const npmShim = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  "",
].join("\r\n");

const exists = (filePath: string) => filePath === executable;

describe("npmShimExecutable", () => {
  it.each([".cmd", ".CMD"])("resolves npm's native %s shim with Windows paths on any OS", (ext) => {
    const readFile = vi.fn(() => npmShim);
    const path = shimPath.replace(".cmd", ext);
    expect(npmShimExecutable(path, readFile, exists)).toBe(executable);
    expect(readFile).toHaveBeenCalledWith(path);
  });

  it("accepts LF and blank lines from the same template", () => {
    expect(npmShimExecutable(shimPath, () => npmShim.replaceAll("\r\n", "\n\n"), exists)).toBe(
      executable,
    );
  });

  it.each([
    npmShim.replace("SETLOCAL", "SETLOCAL\r\nSET OPENCODE_CONFIG=C:\\custom"),
    npmShim.replace(
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      '"%_prog%" "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
    ),
    npmShim.replace("%*", "--custom %*"),
    npmShim.replace("%*", "%* & echo done"),
    npmShim.replace("node_modules", "%CUSTOM_MODULES%"),
    npmShim.replace("SETLOCAL", "  SETLOCAL"),
    npmShim.replace('opencode.exe"   %*', 'opencode.exe"\u00a0%*'),
    ...["\u00a0", "\t", " "].map((suffix) =>
      npmShim.replace("SET dp0=%~dp0", `SET dp0=%~dp0${suffix}`),
    ),
  ])("preserves a custom or differently interpreted shim (%#)", (contents) => {
    expect(
      npmShimExecutable(
        shimPath,
        () => contents,
        () => true,
      ),
    ).toBeUndefined();
  });

  it("preserves a missing executable or unreadable shim", () => {
    expect(
      npmShimExecutable(
        shimPath,
        () => npmShim,
        () => false,
      ),
    ).toBeUndefined();
    expect(npmShimExecutable(shimPath, () => undefined, exists)).toBeUndefined();
  });

  it.each([".exe", ".bat", ".ps1"])("does not read or rewrite %s files", (extension) => {
    const readFile = vi.fn(() => npmShim);
    expect(
      npmShimExecutable(shimPath.replace(".cmd", extension), readFile, exists),
    ).toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });
});
