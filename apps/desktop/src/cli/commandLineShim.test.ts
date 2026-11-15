// @effect-diagnostics nodeBuiltinImport:off - Runs the shipped shell shim against a throwaway bundle layout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SHIM_MARKER } from "./commandLineTool.ts";

const IS_WINDOWS = HostProcessPlatform.defaultValue() === "win32";
const SHIM_DIR = NodePath.resolve(import.meta.dirname, "../../resources/cli");
const POSIX_SHIM = NodePath.join(SHIM_DIR, "specwithcode");
const WINDOWS_SHIM = NodePath.join(SHIM_DIR, "specwithcode.cmd");

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** A bundle whose "executable" prints what it was started with. */
const fakeBundle = (layout: "mac" | "linux", executable: string) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-shim-"));
  scratch.push(root);
  const bundle =
    layout === "mac" ? NodePath.join(root, "App.app", "Contents") : NodePath.join(root, "opt");
  const resources = NodePath.join(bundle, layout === "mac" ? "Resources" : "resources");
  NodeFS.mkdirSync(NodePath.join(resources, "cli"), { recursive: true });
  const exeDir = layout === "mac" ? NodePath.join(bundle, "MacOS") : bundle;
  NodeFS.mkdirSync(exeDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(exeDir, executable),
    '#!/bin/sh\nprintf "%s|" "$ELECTRON_RUN_AS_NODE" "$STUDIO_CLI_NAME" "$@"\nexit 7\n',
    { mode: 0o755 },
  );
  NodeFS.copyFileSync(POSIX_SHIM, NodePath.join(resources, "cli", "specwithcode"));
  NodeFS.chmodSync(NodePath.join(resources, "cli", "specwithcode"), 0o755);
  // ~/.local/bin/specwithcode -> a relative link -> the shim, as a user might chain them.
  const bin = NodePath.join(root, "home", ".local", "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.symlinkSync(NodePath.join(resources, "cli", "specwithcode"), NodePath.join(bin, "inner"));
  NodeFS.symlinkSync("inner", NodePath.join(bin, "specwithcode"));
  return { command: NodePath.join(bin, "specwithcode"), resources: NodeFS.realpathSync(resources) };
};

const run = (command: string, args: string[]) =>
  NodeChildProcess.spawnSync(command, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

describe.skipIf(IS_WINDOWS)("POSIX shim", () => {
  it("runs the macOS bundle's executable on its own CLI through links, passing arguments and the exit code", () => {
    const { command, resources } = fakeBundle("mac", "SpecWithCode");
    const result = run(command, ["fleet", "invite", "a b"]);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe(
      `1|specwithcode|${resources}/app.asar/apps/server/dist/bin.mjs|fleet|invite|a b|`,
    );
  });

  it("finds the Nightly executable", () => {
    const { command } = fakeBundle("mac", "SpecWithCode (Nightly)");
    expect(run(command, ["--version"]).stdout).toContain("--version|");
  });

  it("runs the Linux executable", () => {
    const { command, resources } = fakeBundle("linux", "specweave-studio-desktop");
    expect(run(command, ["--version"]).stdout).toBe(
      `1|specwithcode|${resources}/app.asar/apps/server/dist/bin.mjs|--version|`,
    );
  });

  it("explains an incomplete app instead of failing silently", () => {
    const { command } = fakeBundle("linux", "something-else");
    const result = run(command, []);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("is incomplete");
  });
});

describe("shim files", () => {
  it("carry the marker the installer looks for", () => {
    expect(NodeFS.readFileSync(POSIX_SHIM, "utf8")).toContain(`# ${SHIM_MARKER}\n`);
    expect(NodeFS.readFileSync(WINDOWS_SHIM, "utf8")).toContain(`rem ${SHIM_MARKER}\r\n`);
  });

  it("the Windows shim uses CRLF, keeps its variables local and passes every argument", () => {
    const text = NodeFS.readFileSync(WINDOWS_SHIM, "utf8");
    expect(text.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(text).toContain("\r\nsetlocal\r\n");
    expect(text).toContain('set "STUDIO_DESKTOP_CLI_LAUNCHER=1"');
    expect(text).toContain(
      '"%SWC_EXE%" "%SWC_RESOURCES%\\server.asar\\apps\\server\\dist\\bin.mjs" %*',
    );
    // No parenthesised block: an install folder such as "Program Files (x86)" would end it early.
    expect(text).not.toMatch(/\(\r\n/);
  });

  it.skipIf(IS_WINDOWS)("the POSIX shim is executable", () => {
    expect(NodeFS.statSync(POSIX_SHIM).mode & 0o111).not.toBe(0);
  });
});
