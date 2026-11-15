// @effect-diagnostics nodeBuiltinImport:off - A standalone check script, run with plain Node against an installed app.
/**
 * Proves "Install command-line tool" against an installed desktop app, with the app's own code
 * (apps/desktop/src/cli/commandLineTool.ts) and a throwaway home:
 *
 *   node scripts/desktop-e2e/command-line-tool.ts --resources <app resources dir> --app-version <x.y.z> --result <file.json>
 *
 * Install, then `specwithcode --version` in a new login shell (a new PowerShell with the user
 * PATH from the registry on Windows) prints the app's version; install refuses to replace a
 * managed wrapper; a command pointing into a deleted bundle is repaired as at launch; Remove
 * leaves nothing behind. On Windows it really edits HKCU\Environment\Path, so run it only on a
 * throwaway runner or with --allow-user-path.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Tool from "../../apps/desktop/src/cli/commandLineTool.ts";
import { makeNodeCommandLineToolHost } from "../../apps/desktop/src/cli/commandLineToolHost.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    resources: { type: "string" },
    "app-version": { type: "string" },
    result: { type: "string" },
    "app-image": { type: "string" },
    "allow-user-path": { type: "boolean", default: false },
  },
});
const resources = values.resources;
/** "auto": what the bundle's own CLI reports when started directly, without the shim. */
const directVersion = (dir: string): string | undefined => {
  const root = NodePath.dirname(dir);
  const candidates =
    process.platform === "darwin"
      ? [
          NodePath.join(root, "MacOS", "SpecWithCode"),
          NodePath.join(root, "MacOS", "SpecWithCode (Nightly)"),
        ]
      : process.platform === "win32"
        ? [
            NodePath.join(root, "SpecWithCode.exe"),
            NodePath.join(root, "SpecWithCode (Nightly).exe"),
          ]
        : [NodePath.join(root, "specweave-studio-desktop")];
  const exe = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (exe === undefined) return undefined;
  const entry = NodePath.join(
    dir,
    process.platform === "win32" ? "server.asar" : "app.asar",
    "apps",
    "server",
    "dist",
    "bin.mjs",
  );
  const result = NodeChildProcess.spawnSync(exe, [entry, "--version"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 60_000,
  });
  return /v?(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)?.[1];
};
const appVersion =
  values["app-version"] === "auto" && resources ? directVersion(resources) : values["app-version"];
if (!resources || !appVersion) {
  console.error(
    "usage: --resources <dir> --app-version <x.y.z> [--result <file>] [--app-image <path>]",
  );
  process.exit(2);
}
const platform = process.platform;
if (platform === "win32" && !values["allow-user-path"] && process.env.GITHUB_ACTIONS !== "true") {
  console.error(
    "On Windows this edits the user PATH; pass --allow-user-path on a throwaway machine.",
  );
  process.exit(2);
}

const home = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-cli-home-")),
);
const steps: Array<{ step: string; ok: boolean; detail: unknown }> = [];
const check = (step: string, ok: boolean, detail: unknown) => {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
};

if (values["app-image"]) process.env.APPIMAGE = values["app-image"];
if (platform === "win32") process.env.LOCALAPPDATA = NodePath.join(home, "AppData", "Local");
if (platform !== "win32") process.env.SHELL = platform === "darwin" ? "/bin/zsh" : "/bin/bash";

const host = makeNodeCommandLineToolHost({
  platform,
  homeDirectory: home,
  appVersion,
  isPackaged: true,
  resourcesPath: NodePath.resolve(resources),
});
if (host === null) throw new Error(`unsupported platform ${platform}`);

/** `specwithcode --version` as a person would run it in a brand-new terminal. */
const freshTerminalVersion = (): { code: number | null; out: string } => {
  if (platform === "win32") {
    const script =
      "$env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); specwithcode --version";
    const result = NodeChildProcess.spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: process.env.LOCALAPPDATA! },
        timeout: 60_000,
      },
    );
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }
  const shell = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const result = NodeChildProcess.spawnSync(
    "/usr/bin/env",
    [
      "-i",
      `HOME=${home}`,
      `USER=${process.env.USER ?? "user"}`,
      "TERM=dumb",
      `SHELL=${shell}`,
      shell,
      "-l",
      "-i",
      "-c",
      "specwithcode --version",
    ],
    { encoding: "utf8", timeout: 60_000, input: "" },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

const commandPath = Tool.commandPathFor(host);
try {
  const before = await Tool.inspect(host);
  check("starts not installed", before.install === "none" && before.unavailable === null, before);

  const installed = await Tool.install(host);
  check(
    "install puts the app's own command in place",
    installed.ok &&
      installed.state.install === "installed" &&
      installed.state.version === appVersion,
    installed,
  );

  if (platform !== "win32" && installed.state.onPath !== "yes") {
    const added = await Tool.addToShellPath(host);
    check(
      `the PATH line goes into ${added.state.startupFile}`,
      added.ok && added.state.startupLineAdded && added.state.onPath === "yes",
      added,
    );
  }

  const fresh = freshTerminalVersion();
  check(
    "specwithcode --version in a new terminal prints the app's version",
    fresh.code === 0 && fresh.out.includes(appVersion),
    fresh,
  );

  const again = await Tool.install(host);
  check(
    "installing again changes nothing",
    again.ok && again.state.install === "installed",
    again.state,
  );

  // As if the app had been run from somewhere else that is now gone.
  NodeFS.rmSync(commandPath);
  if (platform === "win32") {
    NodeFS.writeFileSync(
      commandPath,
      Tool.renderWindowsLauncher("C:\\Gone\\SpecWithCode\\resources\\cli\\specwithcode.cmd"),
    );
  } else if (values["app-image"]) {
    NodeFS.writeFileSync(commandPath, Tool.renderAppImageLauncher("/gone/SpecWithCode.AppImage"), {
      mode: 0o755,
    });
  } else {
    NodeFS.symlinkSync("/gone/SpecWithCode.app/Contents/Resources/cli/specwithcode", commandPath);
  }
  const broken = await Tool.inspect(host);
  check("a command into a deleted bundle reads as broken", broken.install === "broken", broken);
  const repaired = await Tool.repairAtLaunch(host);
  const afterRepair = freshTerminalVersion();
  check(
    "launch repair points it at this app and it runs again",
    repaired === "repaired" && afterRepair.code === 0 && afterRepair.out.includes(appVersion),
    { repaired, afterRepair },
  );

  const removed = await Tool.remove(host);
  const leftovers =
    platform === "win32"
      ? NodeFS.existsSync(commandPath)
      : NodeFS.existsSync(commandPath) ||
        NodeFS.readdirSync(home, { recursive: true, encoding: "utf8" }).some((name) =>
          NodeFS.statSync(NodePath.join(home, name)).isFile()
            ? NodeFS.readFileSync(NodePath.join(home, name), "utf8").includes(
                Tool.STARTUP_LINE_MARKER,
              )
            : false,
        );
  check(
    "Remove leaves no command and no PATH change",
    removed.ok &&
      removed.state.install === "none" &&
      !leftovers &&
      (platform !== "win32" || removed.state.onPath === "no"),
    removed.state,
  );

  const managed =
    '#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i HOME=/x /x/.local/share/specweave-studio/releases/1/node /x/.local/share/specweave-studio/releases/1/apps/server/dist/bin.mjs "$@"\n';
  if (platform !== "win32") {
    NodeFS.writeFileSync(commandPath, managed, { mode: 0o700 });
    const refused = await Tool.install(host);
    check(
      "install never replaces a managed wrapper",
      !refused.ok &&
        refused.state.install === "blocked-managed" &&
        NodeFS.readFileSync(commandPath, "utf8") === managed,
      refused,
    );
    NodeFS.rmSync(commandPath);
  }
} catch (error) {
  check("no exception", false, String(error instanceof Error ? error.stack : error));
} finally {
  if (platform === "win32") await Tool.remove(host).catch(() => undefined);
  NodeFS.rmSync(home, { recursive: true, force: true });
}

const ok = steps.every((step) => step.ok);
if (values.result) {
  NodeFS.writeFileSync(
    values.result,
    `${JSON.stringify({ platform, appVersion, ok, steps }, null, 2)}\n`,
  );
}
process.exit(ok ? 0 : 1);
