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
  | { readonly kind: "file"; text: string; mode: number; readOnly?: boolean; unreadable?: boolean }
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
  readonly readOnlyVolumes?: ReadonlyArray<string>;
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
  /** Let a test change things between the app's check and its write. */
  const hooks: {
    /** When the app writes its temporary entry, after it checked the command's path. */
    afterTemporary?: () => void;
    /** On each lstat of a path, with how many times it was looked at so far. */
    onLstat?: (path: string, count: number) => void;
    beforePathWrite?: (() => void) | undefined;
    /** When the app makes the command's folder, right before it creates the command. */
    onMakeDirectory?: () => void;
  } = {};
  const lstatCounts = new Map<string, number>();
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
    now: () => 0,
    fs: {
      realpath: async (value) => {
        let current = value;
        for (let depth = 0; depth < 40; depth++) {
          const node = nodes.get(key(current));
          if (node === undefined) return null;
          if (node.kind !== "symlink") return current;
          current = path.resolve(path.dirname(current), node.target);
        }
        return null;
      },
      isExecutableFile: async (value) => {
        const node = resolveLinks(value);
        return node?.kind === "file" && (platform === "win32" || (node.mode & 0o111) !== 0);
      },
      isOnReadOnlyVolume: async (value) =>
        (options.readOnlyVolumes ?? []).some((volume) => value.startsWith(volume)),
      lstat: async (value) => {
        const count = (lstatCounts.get(value) ?? 0) + 1;
        lstatCounts.set(value, count);
        hooks.onLstat?.(value, count);
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
        return node?.kind === "file" && !node.unreadable ? node.text : null;
      },
      makeDirectory: async (value) => {
        hooks.onMakeDirectory?.();
        put(path.join(value, ".keep"), { kind: "directory" });
        nodes.delete(key(path.join(value, ".keep")));
      },
      symlink: async (target, value) => {
        create(value, { kind: "symlink", target });
        if (value.includes(".tmp")) hooks.afterTemporary?.();
      },
      writeNewFile: async (value, text, mode) => {
        create(value, { kind: "file", text, mode });
        if (value.includes(".tmp")) hooks.afterTemporary?.();
      },
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
        const node = resolveLinks(value);
        if (node === undefined && nodes.has(key(value))) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        if (node?.kind === "file" && node.readOnly) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        if (node?.kind === "file") node.text += text;
        else put(value, { kind: "file", text, mode: 0o644 });
      },
      rewriteFile: async (value, text) => {
        const node = resolveLinks(value);
        if (node?.kind !== "file") throw new Error(`ENOENT ${value}`);
        if (node.readOnly) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        node.text = text;
      },
    },
    run: async (command, args, runOptions): Promise<RunResult | null> => {
      calls.push({ command, args, ...(runOptions.env ? { env: runOptions.env } : {}) });
      if (command === "powershell.exe") {
        const script = args.at(-1)!;
        if (script.includes("SWC_PATH_VALUE")) {
          hooks.beforePathWrite?.();
          if (windowsPath.raw !== runOptions.env!.SWC_PATH_EXPECTED) {
            return { code: 0, stdout: "changed", stderr: "" };
          }
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
  return {
    host,
    nodes,
    put,
    calls,
    hooks,
    windowsPath: () => windowsPath,
    setWindowsPath: (raw: string) => {
      windowsPath = { ...windowsPath, raw };
    },
  };
};

const SHIM_TEXT = "#!/bin/sh\n# specwithcode-desktop-shim 1\n";
const WINDOWS_SHIM_TEXT = "@echo off\r\nrem specwithcode-desktop-shim 1\r\n";

/** A shim with the app beside it, at `shim` (`.../resources/cli/specwithcode`). */
const putShim = (fake: ReturnType<typeof makeHost>, shim: string) => {
  fake.put(shim, { kind: "file", text: SHIM_TEXT, mode: 0o755 });
  fake.put(NodePath.posix.join(shim, "..", "..", "app.asar"), {
    kind: "file",
    text: "",
    mode: 0o644,
  });
};

const withMacBundle = (options: FakeOptions = {}) => {
  const fake = makeHost(options);
  putShim(fake, MAC_SHIM);
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
    put("/opt/homebrew/lib/node_modules/specwithcode/bin.js", {
      kind: "file",
      text: "",
      mode: 0o755,
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
    const fake = withMacBundle();
    const { host, put, nodes } = fake;
    putShim(fake, other);
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
    const fake = makeHost({
      platform: "linux",
      bundlePath: "/opt/SpecWithCode",
      resourcesPath: "/opt/SpecWithCode/resources",
      userShell: "/bin/bash",
    });
    const { host, nodes } = fake;
    putShim(fake, LINUX_SHIM);
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
    expect(await classify(host)).toMatchObject({ install: "installed", pointsAt: appImage });
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
    fake.put(SHIM, { kind: "file", text: WINDOWS_SHIM_TEXT, mode: 0o644 });
    return fake;
  };

  it("writes a launcher in the user's app data and adds its folder to the user PATH", async () => {
    const { host, nodes, windowsPath } = windowsHost("%USERPROFILE%\\bin;C:\\Tools");
    const result = await install(host);
    expect(result.ok).toBe(true);
    expect(nodes.get(LAUNCHER.toLowerCase())).toMatchObject({ text: renderWindowsLauncher(SHIM) });
    expect(renderWindowsLauncher(SHIM)).toBe(
      `@echo off\r\nrem specwithcode-desktop-launcher 1\r\nrem Runs the specwithcode command inside the SpecWithCode app. The app wrote this\r\nrem (Settings > Machines > Command line) and keeps it pointed at the app.\r\nsetlocal\r\nset "SWC_SHIM=${SHIM}"\r\ncall "%%SWC_SHIM%%" %*\r\nexit /b %ERRORLEVEL%\r\n`,
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

  it("escapes % in the shim path and reads it back", async () => {
    const shim = "C:\\100%\\resources\\cli\\specwithcode.cmd";
    expect(renderWindowsLauncher(shim)).toContain(
      'set "SWC_SHIM=C:\\100%%\\resources\\cli\\specwithcode.cmd"',
    );
    const { host, put } = windowsHost(BIN);
    put(LAUNCHER, { kind: "file", text: renderWindowsLauncher(shim), mode: 0o644 });
    expect((await classify(host)).pointsAt).toBe(shim);
  });
});

const MANAGED_WRAPPER =
  '#!/bin/sh\nset -eu\numask 077\nexec /x/releases/1/node /x/releases/1/apps/server/dist/bin.mjs "$@"\n';

describe("review round 1", () => {
  it("never replaces what appeared at the path after the check (install and launch repair)", async () => {
    const { host, put, nodes, hooks } = withMacBundle();
    const stale = `${HOME}/Downloads/SpecWithCode.app/Contents/Resources/cli/specwithcode`;
    put(COMMAND, { kind: "symlink", target: stale });
    hooks.afterTemporary = () => {
      nodes.set(COMMAND, { kind: "file", text: MANAGED_WRAPPER, mode: 0o700 });
    };
    const result = await install(host);
    expect(result).toMatchObject({ ok: false, reason: { code: "changed", path: COMMAND } });
    expect(nodes.get(COMMAND)).toMatchObject({ text: MANAGED_WRAPPER });
    expect([...nodes.keys()].filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("refuses when something appears at an empty path after the check", async () => {
    const { host, nodes, hooks } = withMacBundle();
    hooks.onMakeDirectory = () => {
      nodes.set(COMMAND, { kind: "file", text: MANAGED_WRAPPER, mode: 0o700 });
    };
    expect(await install(host)).toMatchObject({ ok: false, reason: { code: "changed" } });
    expect(nodes.get(COMMAND)).toMatchObject({ text: MANAGED_WRAPPER });
  });

  it("Remove never deletes a file swapped in after the check", async () => {
    const { host, nodes, hooks, put } = withMacBundle();
    put(COMMAND, { kind: "symlink", target: MAC_SHIM });
    // classify looks twice; the third look is the check right before the unlink.
    hooks.onLstat = (value, count) => {
      if (value === COMMAND && count === 3) {
        nodes.set(COMMAND, { kind: "file", text: "mine", mode: 0o755 });
      }
    };
    expect(await remove(host)).toMatchObject({ ok: false, reason: { code: "changed" } });
    expect(nodes.get(COMMAND)).toMatchObject({ text: "mine" });
  });

  it("probes a login shell on macOS and an interactive non-login shell on Linux", async () => {
    const mac = withMacBundle();
    await inspect(mac.host);
    expect(mac.calls.find((call) => call.args.includes("-c"))?.args.slice(0, 2)).toEqual([
      "-l",
      "-i",
    ]);
    const linux = makeHost({
      platform: "linux",
      bundlePath: "/opt/SpecWithCode",
      resourcesPath: "/opt/SpecWithCode/resources",
      userShell: "/bin/bash",
    });
    await inspect(linux.host);
    expect(linux.calls.find((call) => call.args.includes("-c"))?.args[0]).toBe("-i");
  });

  it("reads the shell once per minute, and again after the app changed a startup file", async () => {
    const { host, calls } = withMacBundle();
    await inspect(host);
    await inspect(host);
    const probes = () => calls.filter((call) => call.args.includes("-c")).length;
    expect(probes()).toBe(1);
    await addToShellPath(host);
    expect(probes()).toBe(2);
  });

  it("does not add to a startup file it cannot read in full", async () => {
    const { host, put, nodes } = withMacBundle();
    put(`${HOME}/.zprofile`, { kind: "file", text: "big", mode: 0o644, unreadable: true });
    const result = await addToShellPath(host);
    expect(result).toMatchObject({ ok: false, reason: { code: "startup-file-unreadable" } });
    expect(nodes.get(`${HOME}/.zprofile`)).toMatchObject({ text: "big" });
  });

  it("Remove takes the line out of every startup file, whatever the shell is now", async () => {
    const zsh = withMacBundle();
    await install(zsh.host);
    await addToShellPath(zsh.host);
    const bash = withMacBundle({ userShell: "/bin/bash" });
    for (const [name, node] of zsh.nodes) bash.nodes.set(name, node);
    expect((await remove(bash.host)).ok).toBe(true);
    expect(bash.nodes.get(`${HOME}/.zprofile`)).toMatchObject({ text: "" });
  });

  it("Remove keeps what the user added to the fish file", async () => {
    const { host, nodes } = withMacBundle({ userShell: "/opt/homebrew/bin/fish" });
    await addToShellPath(host);
    const file = `${HOME}/.config/fish/conf.d/specwithcode.fish`;
    (nodes.get(file) as { text: string }).text += "set -gx EDITOR vim\n";
    expect((await remove(host)).ok).toBe(true);
    expect(nodes.get(file)).toMatchObject({ text: "set -gx EDITOR vim\n" });
  });

  it("says plainly when the command went but a read-only startup file kept the line", async () => {
    const { host, put, nodes } = withMacBundle();
    await install(host);
    put(`${HOME}/.zprofile`, {
      kind: "file",
      text: 'export PATH="$HOME/.local/bin:$PATH" # Added by SpecWithCode\n',
      mode: 0o444,
      readOnly: true,
    });
    const result = await remove(host);
    expect(result).toMatchObject({
      ok: false,
      reason: { code: "remove-partial", path: `${HOME}/.zprofile`, errno: "EACCES" },
    });
    expect(nodes.has(COMMAND)).toBe(false);
  });

  it("skips a dangling .bash_profile on macOS, as bash does", async () => {
    const { host, put } = withMacBundle({ userShell: "/bin/bash" });
    put(`${HOME}/.bash_profile`, { kind: "symlink", target: "/gone/bash_profile" });
    put(`${HOME}/.profile`, { kind: "file", text: "", mode: 0o644 });
    expect((await inspect(host)).startupFile).toBe(`${HOME}/.profile`);
  });

  it("turns a system error into a reason code, not raw text", async () => {
    const { host, put } = withMacBundle();
    put(`${HOME}/.zprofile`, { kind: "file", text: "", mode: 0o444, readOnly: true });
    expect(await addToShellPath(host)).toMatchObject({
      ok: false,
      reason: { code: "startup-file-write", path: `${HOME}/.zprofile`, errno: "EACCES" },
    });
  });

  it("does not write through a dangling startup-file link", async () => {
    const { host, put } = withMacBundle();
    put(`${HOME}/.zprofile`, { kind: "symlink", target: "/gone/zprofile" });
    expect(await addToShellPath(host)).toMatchObject({
      ok: false,
      reason: { code: "startup-file-unreadable", path: `${HOME}/.zprofile` },
    });
  });

  it("treats a lookalike link that is not a shim inside an app as someone else's", async () => {
    const { host, put, nodes } = withMacBundle();
    const lookalike = `${HOME}/project/resources/cli/specwithcode`;
    put(lookalike, { kind: "file", text: "#!/bin/sh\necho mine\n", mode: 0o755 });
    put(COMMAND, { kind: "symlink", target: lookalike });
    expect((await install(host)).state.install).toBe("blocked-other");
    expect(nodes.get(COMMAND)).toEqual({ kind: "symlink", target: lookalike });
  });

  it("does not call a non-executable file or a link chain to this app's shim in the way", async () => {
    const { host, put } = withMacBundle();
    put("/usr/local/bin/specwithcode", { kind: "file", text: "notes", mode: 0o644 });
    put("/opt/a/specwithcode", { kind: "symlink", target: "/opt/b/specwithcode" });
    put("/opt/b/specwithcode", { kind: "symlink", target: MAC_SHIM });
    expect(
      (await lookUpCommand(host, ["/usr/local/bin", "/opt/a", `${HOME}/.local/bin`])).shadowedBy,
    ).toBeNull();
  });

  it("refuses from a disk image mounted outside /Volumes", async () => {
    const { host } = withMacBundle({
      bundlePath: "/tmp/mnt/SpecWithCode.app",
      readOnlyVolumes: ["/tmp/mnt"],
    });
    expect((await install(host)).state.unavailable).toBe("temporary-location");
  });

  it("refuses an AppImage path it could never read back", async () => {
    for (const appImage of ["Apps/SpecWithCode.AppImage", "/home/ada/a\nb.AppImage"]) {
      const { host, put, nodes } = makeHost({
        platform: "linux",
        bundlePath: "/tmp/.mount_x",
        resourcesPath: "/tmp/.mount_x/resources",
        env: { APPIMAGE: appImage },
      });
      put("/tmp/.mount_x/resources/cli/specwithcode", { kind: "file", text: "", mode: 0o755 });
      expect(await install(host)).toMatchObject({ ok: false, reason: { code: "unsafe-path" } });
      expect(nodes.has("/home/ada/.local/bin/specwithcode")).toBe(false);
    }
  });
});

describe("review round 1, Windows", () => {
  const ROOT = "C:\\Users\\Ada\\AppData\\Local\\Programs\\SpecWithCode";
  const SHIM = `${ROOT}\\resources\\cli\\specwithcode.cmd`;
  const windows = (raw: string, kind = "ExpandString", env?: Record<string, string>) => {
    const fake = makeHost({
      platform: "win32",
      bundlePath: ROOT,
      resourcesPath: `${ROOT}\\resources`,
      env: env ?? { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      windowsPath: { raw, kind },
    });
    fake.put(SHIM, { kind: "file", text: WINDOWS_SHIM_TEXT, mode: 0o644 });
    return fake;
  };

  it("keeps another installer's PATH edit made while the app was editing", async () => {
    const fake = windows("C:\\Tools");
    fake.hooks.beforePathWrite = () => fake.setWindowsPath("C:\\Tools;C:\\Other");
    const result = await install(fake.host);
    expect(result).toMatchObject({ ok: false, reason: { code: "path-changed" } });
    expect(fake.windowsPath().raw).toBe("C:\\Tools;C:\\Other");
  });

  it("leaves a user PATH of an unusual registry type alone", async () => {
    const fake = windows("C:\\Tools", "Binary");
    expect(await install(fake.host)).toMatchObject({ ok: false, reason: { code: "path-write" } });
    expect(fake.windowsPath()).toMatchObject({ raw: "C:\\Tools", kind: "Binary" });
  });

  it("falls back to the profile's AppData when LOCALAPPDATA is empty", async () => {
    const fake = windows("", "ExpandString", { LOCALAPPDATA: "" });
    expect((await inspect(fake.host)).binDirectory).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\SpecWithCode\\bin",
    );
  });

  it("passes the command path to cmd through a variable, so % in it survives", async () => {
    const fake = windows("");
    await install(fake.host);
    const call = fake.calls.find((item) => item.args.some((arg) => arg.includes("--version")));
    expect(call?.args.at(-1)).toBe('""%SWC_COMMAND%" --version"');
    expect(call?.env?.SWC_COMMAND).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\SpecWithCode\\bin\\specwithcode.cmd",
    );
  });

  it("offers the PATH step again: install on an installed command only edits PATH", async () => {
    const fake = windows("C:\\Tools");
    fake.hooks.beforePathWrite = () => {
      fake.hooks.beforePathWrite = undefined;
      fake.setWindowsPath("C:\\Tools;C:\\Other");
    };
    expect((await install(fake.host)).ok).toBe(false);
    const again = await install(fake.host);
    expect(again.ok).toBe(true);
    expect(fake.windowsPath().raw).toBe(
      "C:\\Tools;C:\\Other;C:\\Users\\Ada\\AppData\\Local\\SpecWithCode\\bin",
    );
  });
});
