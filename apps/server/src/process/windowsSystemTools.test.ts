// @effect-diagnostics nodeBuiltinImport:off - reads the source files the guard covers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  windowsPowerShellPath,
  windowsSystem32Dir,
  windowsSystem32Path,
  windowsSystemRoot,
} from "./windowsSystemTools.ts";

describe("windowsSystemTools", () => {
  it("builds System32 paths from SystemRoot, then windir, then the default", () => {
    expect(windowsSystemRoot({ SystemRoot: "D:\\Windows", windir: "E:\\Win" })).toBe("D:\\Windows");
    expect(windowsSystemRoot({ windir: "E:\\Win" })).toBe("E:\\Win");
    expect(windowsSystemRoot({ SystemRoot: "  " })).toBe("C:\\Windows");
    expect(windowsSystem32Path("taskkill.exe", { SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\taskkill.exe",
    );
    expect(windowsSystem32Dir({ SystemRoot: "D:\\Windows\\" })).toBe("D:\\Windows\\System32");
    expect(windowsPowerShellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  // Windows looks for a bare program name in the current folder before PATH.
  it.each([
    "htmlRender/headlessChrome.ts",
    "process/ownedProcessTree.ts",
    "cloud/bootService.ts",
    "cloud/runtimeVersionRetention.ts",
    "cloud/MachineHardwareIdentity.ts",
    "cli/uninstall.ts",
  ])("%s starts no Windows system tool by bare name", (file) => {
    const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8");
    expect(source).not.toMatch(
      /(?:spawn|run|execText|runProbe|probe|command:)\s*\(?\s*"(?:powershell|taskkill|schtasks|reg|cmd|ping)(?:\.exe)?"/i,
    );
  });
});
