// @effect-diagnostics nodeBuiltinImport:off - Windows and POSIX path rules under test on any OS.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  addToShellPath,
  classify,
  editWindowsPath,
  inspect,
  install,
  lookUpCommand,
  remove,
  renderAppImageLauncher,
  renderWindowsLauncher,
  repairAtLaunch,
  type CommandLineToolHost,
  type CommandLineToolPlatform,
  type EntryInfo,
  type RunResult,
} from "./commandLineTool.ts";

type Node =
  | { readonly kind: "file"; text: string; mode: number }
  | { readonly kind: "symlink"; target: string }
  | { readonly kind: "directory" };

interface FakeOptions {
  readonly platform?: CommandLineToolPlatform;
  readonly bundlePath?: string;
  readonly resourcesPath?: string;
  readonly env?: Record<string, string>;
  readonly userShell?: string;
  readonly shellPath?: string | null;
  readonly isPackaged?: boolean;
  readonly windowsPath?: { raw: string; kind?: string; machine?: string };
}

const MAC_APP = "/Applications/SpecWithCode.app";
const MAC_SHIM = `${MAC_APP}/Contents/Resources/cli/specwithcode`;
const HOME = "/Users/ada";
const COMMAND = `${HOME}/.local/bin/specwithcode`;

const makeHost = (options: FakeOptions = {}) => {
  const platform = options.platform ?? "darwin";
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const key = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const nodes = new Map<string, Node>();
  const calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    env?: Record<string, string>;
  }> = [];
  let windowsPath = options.windowsPath ?? { raw: "" };
  const resolveLinks = (value: string, depth = 0): Node | undefined => {
    const node = nodes.get(key(value));
    if (node?.kind === "symlink" && depth < 40) {
      return resolveLinks(path.resolve(path.dirname(value), node.target), depth + 1);
    }
    return node;
  };
  const exists = (value: string) => resolveLinks(value) !== undefined;
  const put = (file: string, node: Node) => {
    nodes.set(key(file), node);
    let dir = path.dirname(file);
    while (dir !== path.dirname(dir)) {
      if (!nodes.has(key(dir))) nodes.set(key(dir), { kind: "directory" });
      dir = path.dirname(dir);
    }
  };
  const create = (file: string, node: Node) => {
    if (nodes.has(key(file))) throw Object.assign(new Error(`EEXIST ${file}`), { code: "EEXIST" });
    if (!nodes.has(key(path.dirname(file)))) throw new Error(`ENOENT ${path.dirname(file)}`);
    nodes.set(key(file), node);
  };
  let suffix = 0;
  let homeDirectory = HOME;
  if (platform === "win32") homeDirectory = "C:\\Users\\Ada";
  else if (platform === "linux") homeDirectory = "/home/ada";
  const host: CommandLineToolHost = {
    platform,
    homeDirectory,
    env: options.env ?? {},
    userShell: options.userShell ?? (platform === "win32" ? undefined : "/bin/zsh"),
    appVersion: "1.0.310",
    isPackaged: options.isPackaged ?? true,
    bundlePath: options.bundlePath ?? MAC_APP,
    resourcesPath: options.resourcesPath ?? `${MAC_APP}/Contents/Resources`,
    uniqueSuffix: () => `tmp${suffix++}`,
    fs: {
      lstat: async (value) => {
        const node = nodes.get(key(value));
        return node === undefined ? null : ({ kind: node.kind } satisfies EntryInfo);
      },
      readlink: async (value) => {
        const node = nodes.get(key(value));
        return node?.kind === "symlink" ? node.target : null;
      },
      exists: async (value) => exists(value),
      readFile: async (value) => {
        const node = resolveLinks(value);
        return node?.kind === "file" ? node.text : null;
      },
      makeDirectory: async (value) => {
        put(path.join(value, ".keep"), { kind: "directory" });
        nodes.delete(key(path.join(value, ".keep")));
      },
      symlink: async (target, value) => create(value, { kind: "symlink", target }),
      writeNewFile: async (value, text, mode) => create(value, { kind: "file", text, mode }),
      rename: async (from, to) => {
        const node = nodes.get(key(from));
        if (node === undefined) throw new Error(`ENOENT ${from}`);
        nodes.delete(key(from));
        nodes.set(key(to), node);
      },
      unlink: async (value) => {
        if (!nodes.delete(key(value))) throw new Error(`ENOENT ${value}`);
      },
      appendFile: async (value, text) => {
        const node = nodes.get(key(value));
        if (node?.kind === "file") node.text += text;
        else put(value, { kind: "file", text, mode: 0o644 });
      },
      rewriteFile: async (value, text) => {
        const node = nodes.get(key(value));
        if (node?.kind !== "file") throw new Error(`ENOENT ${value}`);
        node.text = text;
      },
    },
    run: async (command, args, runOptions): Promise<RunResult | null> => {
      calls.push({ command, args, ...(runOptions.env ? { env: runOptions.env } : {}) });
      if (command === "powershell.exe") {
        const script = args.at(-1)!;
        if (script.includes("SWC_PATH_VALUE")) {
          windowsPath = {
            ...windowsPath,
            raw: runOptions.env!.SWC_PATH_VALUE!,
            kind: runOptions.env!.SWC_PATH_KIND!,
          };
          return { code: 0, stdout: "ok", stderr: "" };
        }
        const user = windowsPath.raw.replaceAll("%LOCALAPPDATA%", "C:\\Users\\Ada\\AppData\\Local");
        return {
          code: 0,
          stdout: JSON.stringify({
            raw: windowsPath.raw,
            kind: windowsPath.kind ?? "ExpandString",
            user,
            machine: windowsPath.machine ?? "C:\\Windows\\system32",
          }),
          stderr: "",
        };
      }
      if (args.includes("--version") || args.some((arg) => arg.includes("--version"))) {
        return { code: 0, stdout: "specwithcode v1.0.310\n", stderr: "" };
      }
      if (args.includes("-c")) {
        if (options.shellPath === null) return null;
        const value = options.shellPath ?? "/usr/bin:/bin";
        return {
          code: 0,
          stdout: `motd noise\n__SWC_PATH_START__${value}__SWC_PATH_END__\n`,
          stderr: "",
        };
      }
      return null;
    },
  };
  return { host, nodes, put, calls, windowsPath: () => windowsPath };
};

const withMacBundle = (options: FakeOptions = {}) => {
  const fake = makeHost(options);
  fake.put(MAC_SHIM, {
    kind: "file",
    text: "#!/bin/sh\n# specwithcode-desktop-shim 1\n",
    mode: 0o755,
  });
  return fake;
};

describe("install on macOS", () => {
  it("links ~/.local/bin/specwithcode to the bundle's shim and reports the version", async () => {
    const { host, nodes } = withMacBundle({ shellPath: `${HOME}/.local/bin:/usr/bin` });
    const result = await install(host);
    expect(result.ok).toBe(true);
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: MAC_SHIM });
    expect(result.state).toMatchObject({
      install: "installed",
      version: "1.0.310",
      appVersion: "1.0.310",
      onPath: "yes",
      shadowedBy: null,
      commandPath: COMMAND,
      startupFile: `${HOME}/.zprofile`,
      pathLine: 'export PATH="$HOME/.local/bin:$PATH" # Added by SpecWithCode',
    });
  });

  it("never edits a shell startup file on install, and says the folder is not on PATH", async () => {
    const { host, nodes } = withMacBundle({ shellPath: "/usr/bin:/bin" });
    const result = await install(host);
    expect(result.state.onPath).toBe("no");
    expect(nodes.has(`${HOME}/.zprofile`)).toBe(false);
  });

  it("adds one marked line only when asked, and Remove takes out only that line", async () => {
    const { host, nodes, put } = withMacBundle({ shellPath: "/usr/bin:/bin" });
    put(`${HOME}/.zprofile`, { kind: "file", text: 'eval "$(brew shellenv)"', mode: 0o644 });
    await install(host);
    const added = await addToShellPath(host);
    expect(added.ok).toBe(true);
    const file = nodes.get(`${HOME}/.zprofile`) as { text: string };
    expect(file.text).toBe(
      'eval "$(brew shellenv)"\nexport PATH="$HOME/.local/bin:$PATH" # Added by SpecWithCode\n',
    );
    await addToShellPath(host);
    expect(file.text.match(/Added by SpecWithCode/g)).toHaveLength(1);
    expect(added.state.startupLineAdded).toBe(true);
    const removed = await remove(host);
    expect(removed.ok).toBe(true);
    expect(file.text).toBe('eval "$(brew shellenv)"\n');
    expect(nodes.has(COMMAND)).toBe(false);
    expect(nodes.has(`${HOME}/.local/bin`)).toBe(true);
  });

  it("uses .profile for bash on macOS when that is the file bash reads", async () => {
    const { host, put, nodes } = withMacBundle({ userShell: "/bin/bash" });
    put(`${HOME}/.profile`, { kind: "file", text: "", mode: 0o644 });
    const result = await addToShellPath(host);
    expect(result.state.startupFile).toBe(`${HOME}/.profile`);
    expect(nodes.has(`${HOME}/.bash_profile`)).toBe(false);
  });

  it("writes its own fish file and removes only that", async () => {
    const { host, nodes } = withMacBundle({ userShell: "/opt/homebrew/bin/fish" });
    await addToShellPath(host);
    const file = `${HOME}/.config/fish/conf.d/specwithcode.fish`;
    expect(nodes.get(file)).toMatchObject({
      text: "# Added by SpecWithCode\nset -gx PATH $HOME/.local/bin $PATH # Added by SpecWithCode\n",
    });
    await remove(host);
    expect(nodes.has(file)).toBe(false);
  });

  it("only shows the line for a shell it does not know", async () => {
    const { host } = withMacBundle({ userShell: "/bin/tcsh" });
    const result = await addToShellPath(host);
    expect(result.ok).toBe(false);
    expect(result.state.startupFile).toBeNull();
    expect(result.state.pathLine).toContain(".local/bin");
  });

  it("refuses from a disk image or a translocated copy", async () => {
    for (const bundlePath of [
      "/Volumes/SpecWithCode/SpecWithCode.app",
      "/private/var/folders/x/AppTranslocation/ABC/d/SpecWithCode.app",
    ]) {
      const { host, nodes } = withMacBundle({ bundlePath });
      const result = await install(host);
      expect(result.ok).toBe(false);
      expect(result.state.unavailable).toBe("temporary-location");
      expect(nodes.has(COMMAND)).toBe(false);
    }
  });

  it("refuses in a development build", async () => {
    const { host } = withMacBundle({ isPackaged: false });
    expect((await install(host)).state.unavailable).toBe("development");
  });
});

describe("what is already there", () => {
  it("never overwrites a managed wrapper written by install.sh or the fleet installer", async () => {
    const { host, put, nodes } = withMacBundle();
    const wrapper =
      '#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i HOME=/Users/ada /Users/ada/.local/share/specweave-studio/releases/1.0.300/node /Users/ada/.local/share/specweave-studio/releases/1.0.300/apps/server/dist/bin.mjs "$@"\n';
    put(COMMAND, { kind: "file", text: wrapper, mode: 0o700 });
    const result = await install(host);
    expect(result.ok).toBe(false);
    expect(result.state.install).toBe("blocked-managed");
    expect(nodes.get(COMMAND)).toMatchObject({ text: wrapper });
    const removed = await remove(host);
    expect(removed.ok).toBe(false);
    expect(nodes.get(COMMAND)).toMatchObject({ text: wrapper });
  });

  it("never overwrites any other file or link", async () => {
    const { host, put, nodes } = withMacBundle();
    put(COMMAND, { kind: "symlink", target: "/opt/homebrew/lib/node_modules/specwithcode/bin.js" });
    expect((await install(host)).state.install).toBe("blocked-other");
    expect(nodes.get(COMMAND)).toEqual({
      kind: "symlink",
      target: "/opt/homebrew/lib/node_modules/specwithcode/bin.js",
    });
  });

  it("names another specwithcode earlier on PATH and changes nothing", async () => {
    const { host, put } = withMacBundle({
      shellPath: `/opt/homebrew/bin:${HOME}/.local/bin:/usr/bin`,
    });
    put("/opt/homebrew/bin/specwithcode", {
      kind: "symlink",
      target: "../lib/node_modules/specwithcode/bin.js",
    });
    const result = await install(host);
    expect(result.state).toMatchObject({
      install: "installed",
      onPath: "yes",
      shadowedBy: "/opt/homebrew/bin/specwithcode",
    });
  });

  it("does not call a second link to this same app's shim in the way", async () => {
    const { host, put } = withMacBundle({ shellPath: `/usr/local/bin:${HOME}/.local/bin` });
    put("/usr/local/bin/specwithcode", { kind: "symlink", target: MAC_SHIM });
    expect(
      (await lookUpCommand(host, [`/usr/local/bin`, `${HOME}/.local/bin`])).shadowedBy,
    ).toBeNull();
  });

  it("reads ~ and $HOME entries in PATH", async () => {
    const { host } = withMacBundle();
    expect((await lookUpCommand(host, ["~/.local/bin"])).onPath).toBe("yes");
    expect((await lookUpCommand(host, ["$HOME/.local/bin"])).onPath).toBe("yes");
    expect((await lookUpCommand(host, null)).onPath).toBe("unknown");
  });

  it("reports unknown when the shell cannot be read", async () => {
    const { host } = withMacBundle({ shellPath: null });
    expect((await inspect(host)).onPath).toBe("unknown");
  });
});

describe("stale command repair", () => {
  it("re-points a link into a deleted bundle at launch, including after a move into Applications", async () => {
    const { host, put, nodes } = withMacBundle();
    put(COMMAND, {
      kind: "symlink",
      target: `${HOME}/Downloads/SpecWithCode.app/Contents/Resources/cli/specwithcode`,
    });
    expect((await classify(host)).install).toBe("broken");
    expect(await repairAtLaunch(host)).toBe("repaired");
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: MAC_SHIM });
    expect([...nodes.keys()].filter((name) => name.includes(".specwithcode.tmp"))).toEqual([]);
  });

  it("leaves a link to another existing copy alone at launch; Install points it here", async () => {
    const other = `${HOME}/Applications/SpecWithCode.app/Contents/Resources/cli/specwithcode`;
    const { host, put, nodes } = withMacBundle();
    put(other, { kind: "file", text: "#!/bin/sh\n", mode: 0o755 });
    put(COMMAND, { kind: "symlink", target: other });
    expect(await repairAtLaunch(host)).toBe("unchanged");
    expect((await inspect(host)).install).toBe("other-copy");
    await install(host);
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: MAC_SHIM });
  });

  it("never creates the command at launch, or touches what is not the app's own", async () => {
    const { host, put, nodes } = withMacBundle();
    expect(await repairAtLaunch(host)).toBe("unchanged");
    expect(nodes.has(COMMAND)).toBe(false);
    put(COMMAND, { kind: "symlink", target: "/nowhere/specwithcode" });
    expect(await repairAtLaunch(host)).toBe("unchanged");
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: "/nowhere/specwithcode" });
  });

  it("does not repair from a disk image", async () => {
    const { host, put, nodes } = withMacBundle({
      bundlePath: "/Volumes/SpecWithCode/SpecWithCode.app",
    });
    const stale = `${HOME}/Downloads/SpecWithCode.app/Contents/Resources/cli/specwithcode`;
    put(COMMAND, { kind: "symlink", target: stale });
    expect(await repairAtLaunch(host)).toBe("unchanged");
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: stale });
  });
});

describe("Linux", () => {
  const LINUX_SHIM = "/opt/SpecWithCode/resources/cli/specwithcode";
  const LINUX_COMMAND = "/home/ada/.local/bin/specwithcode";

  it("links the .deb's shim and suggests .bashrc for bash", async () => {
    const { host, put, nodes } = makeHost({
      platform: "linux",
      bundlePath: "/opt/SpecWithCode",
      resourcesPath: "/opt/SpecWithCode/resources",
      userShell: "/bin/bash",
    });
    put(LINUX_SHIM, { kind: "file", text: "", mode: 0o755 });
    const result = await install(host);
    expect(nodes.get(LINUX_COMMAND)).toEqual({ kind: "symlink", target: LINUX_SHIM });
    expect(result.state.startupFile).toBe("/home/ada/.bashrc");
  });

  it("writes an AppImage launcher that names the AppImage, and repairs it after a move", async () => {
    const appImage = "/home/ada/Apps/SpecWithCode.AppImage";
    const mount = "/tmp/.mount_SpecWiXYZ";
    const { host, put, nodes } = makeHost({
      platform: "linux",
      bundlePath: mount,
      resourcesPath: `${mount}/resources`,
      env: { APPIMAGE: appImage },
    });
    put(`${mount}/resources/cli/specwithcode`, { kind: "file", text: "", mode: 0o755 });
    put(appImage, { kind: "file", text: "", mode: 0o755 });
    const result = await install(host);
    expect(result.state.install).toBe("installed");
    expect(nodes.get(LINUX_COMMAND)).toEqual({
      kind: "file",
      text: renderAppImageLauncher(appImage),
      mode: 0o755,
    });
    const moved = makeHost({
      platform: "linux",
      bundlePath: mount,
      resourcesPath: `${mount}/resources`,
      env: { APPIMAGE: "/home/ada/SpecWithCode-new.AppImage" },
    });
    moved.put(`${mount}/resources/cli/specwithcode`, { kind: "file", text: "", mode: 0o755 });
    moved.put("/home/ada/SpecWithCode-new.AppImage", { kind: "file", text: "", mode: 0o755 });
    moved.put(LINUX_COMMAND, { kind: "file", text: renderAppImageLauncher(appImage), mode: 0o755 });
    expect(await repairAtLaunch(moved.host)).toBe("repaired");
    expect(moved.nodes.get(LINUX_COMMAND)).toMatchObject({
      text: renderAppImageLauncher("/home/ada/SpecWithCode-new.AppImage"),
    });
  });

  it("quotes an AppImage path with a quote in it and reads it back", async () => {
    const appImage = "/home/ada/it's here/SpecWithCode.AppImage";
    const { host, put } = makeHost({
      platform: "linux",
      bundlePath: "/tmp/.mount_x",
      resourcesPath: "/tmp/.mount_x/resources",
      env: { APPIMAGE: appImage },
    });
    put("/tmp/.mount_x/resources/cli/specwithcode", { kind: "file", text: "", mode: 0o755 });
    put(appImage, { kind: "file", text: "", mode: 0o755 });
    put(LINUX_COMMAND, { kind: "file", text: renderAppImageLauncher(appImage), mode: 0o755 });
    expect(renderAppImageLauncher(appImage)).toContain(
      `appimage='/home/ada/it'"'"'s here/SpecWithCode.AppImage'`,
    );
    expect(await classify(host)).toEqual({ install: "installed", pointsAt: appImage });
  });

  it("treats an edited launcher as someone else's", async () => {
    const { host, put } = makeHost({
      platform: "linux",
      bundlePath: "/tmp/.mount_x",
      resourcesPath: "/tmp/.mount_x/resources",
      env: { APPIMAGE: "/home/ada/a.AppImage" },
    });
    put(LINUX_COMMAND, {
      kind: "file",
      text: `${renderAppImageLauncher("/home/ada/a.AppImage")}echo extra\n`,
      mode: 0o755,
    });
    expect((await classify(host)).install).toBe("blocked-other");
  });
});

describe("Windows", () => {
  const ROOT = "C:\\Users\\Ada\\AppData\\Local\\Programs\\SpecWithCode";
  const SHIM = `${ROOT}\\resources\\cli\\specwithcode.cmd`;
  const BIN = "C:\\Users\\Ada\\AppData\\Local\\SpecWithCode\\bin";
  const LAUNCHER = `${BIN}\\specwithcode.cmd`;
  const windowsHost = (raw: string, kind = "ExpandString", machine?: string) => {
    const fake = makeHost({
      platform: "win32",
      bundlePath: ROOT,
      resourcesPath: `${ROOT}\\resources`,
      env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      windowsPath: { raw, kind, ...(machine === undefined ? {} : { machine }) },
    });
    fake.put(SHIM, { kind: "file", text: "", mode: 0o644 });
    return fake;
  };

  it("writes a launcher in the user's app data and adds its folder to the user PATH", async () => {
    const { host, nodes, windowsPath } = windowsHost("%USERPROFILE%\\bin;C:\\Tools");
    const result = await install(host);
    expect(result.ok).toBe(true);
    expect(nodes.get(LAUNCHER.toLowerCase())).toMatchObject({ text: renderWindowsLauncher(SHIM) });
    expect(renderWindowsLauncher(SHIM)).toBe(
      `@echo off\r\nrem specwithcode-desktop-launcher 1\r\nrem Runs the specwithcode command inside the SpecWithCode app. The app wrote this\r\nrem (Settings > Machines > Command line) and keeps it pointed at the app.\r\n"${SHIM}" %*\r\n`,
    );
    expect(windowsPath()).toMatchObject({
      raw: `%USERPROFILE%\\bin;C:\\Tools;${BIN}`,
      kind: "ExpandString",
    });
    expect(result.state).toMatchObject({ install: "installed", onPath: "yes", pathLine: null });
  });

  it("keeps a REG_SZ value's type and does not add the folder twice", async () => {
    const { host, windowsPath } = windowsHost(`C:\\Tools;${BIN.toUpperCase()}\\`, "String");
    await install(host);
    expect(windowsPath()).toMatchObject({
      raw: `C:\\Tools;${BIN.toUpperCase()}\\`,
      kind: "String",
    });
  });

  it("recognises the folder written with %LOCALAPPDATA%", () => {
    expect(
      editWindowsPath("%LOCALAPPDATA%\\SpecWithCode\\bin;C:\\x", BIN, "remove", (entry) =>
        entry.replace("%LOCALAPPDATA%", "C:\\Users\\Ada\\AppData\\Local"),
      ),
    ).toBe("C:\\x");
  });

  it("Remove takes out only its own PATH entry and launcher", async () => {
    const { host, nodes, windowsPath } = windowsHost("C:\\Tools");
    await install(host);
    const result = await remove(host);
    expect(result.ok).toBe(true);
    expect(windowsPath().raw).toBe("C:\\Tools");
    expect(nodes.has(LAUNCHER.toLowerCase())).toBe(false);
  });

  it("names an npm specwithcode on the machine PATH that comes first", async () => {
    const { host, put } = windowsHost(
      "C:\\Tools",
      "ExpandString",
      "C:\\Users\\Ada\\AppData\\Roaming\\npm",
    );
    put("C:\\Users\\Ada\\AppData\\Roaming\\npm\\specwithcode.cmd", {
      kind: "file",
      text: "",
      mode: 0o644,
    });
    const result = await install(host);
    expect(result.state.shadowedBy).toBe("C:\\Users\\Ada\\AppData\\Roaming\\npm\\specwithcode.cmd");
  });

  it("repairs a launcher that points into a removed install folder", async () => {
    const { host, put, nodes } = windowsHost(BIN);
    const old = "D:\\Old\\SpecWithCode\\resources\\cli\\specwithcode.cmd";
    put(LAUNCHER, { kind: "file", text: renderWindowsLauncher(old), mode: 0o644 });
    expect((await classify(host)).install).toBe("broken");
    expect(await repairAtLaunch(host)).toBe("repaired");
    expect(nodes.get(LAUNCHER.toLowerCase())).toMatchObject({ text: renderWindowsLauncher(SHIM) });
  });

  it("never replaces a specwithcode.cmd it did not write", async () => {
    const { host, put, nodes } = windowsHost("");
    put(LAUNCHER, { kind: "file", text: "@echo off\r\nnode x.js %*\r\n", mode: 0o644 });
    expect((await install(host)).state.install).toBe("blocked-other");
    expect(nodes.get(LAUNCHER.toLowerCase())).toMatchObject({
      text: "@echo off\r\nnode x.js %*\r\n",
    });
  });

  it("escapes % in the shim path", () => {
    expect(renderWindowsLauncher("C:\\100%\\resources\\cli\\specwithcode.cmd")).toContain(
      '"C:\\100%%\\resources\\cli\\specwithcode.cmd" %*',
    );
  });
});
