// @effect-diagnostics nodeBuiltinImport:off - plain async I/O like provisioning; Effect wraps it at the RPC edge.
/**
 * Machine basics for first-run setup: whether Git, Node.js and the GitHub CLI
 * are on this machine, and installing a missing one when that needs no admin
 * password.
 *
 * - Node.js and gh come from the pinned, SHA-256 checked builds in
 *   provision/manifest.ts and are unpacked where provisioning keeps them
 *   (`<home>/runtime/node/<stem>`, `<home>/tools/gh/<version>`). Nothing is
 *   written outside the app's home and no shell profile is edited: the
 *   server adds those folders to its own PATH, which its agents inherit, and
 *   SpecWeave setup searches them too.
 * - Git on a Mac comes with Apple's developer tools (`xcode-select --install`
 *   opens macOS's own window); on Windows winget installs it and Windows asks
 *   for permission itself. Linux has no button: a package manager needs root.
 * - A tool that is already there, from Homebrew, nvm, fnm, volta or anywhere
 *   else, is never replaced.
 */
import type {
  MachinePackageManager,
  MachineToolId,
  MachineToolPresence,
  MachineToolsCheck,
} from "@specweave-studio/contracts";
import { cliArchiveTarCommand } from "@specweave-studio/shared/cliRelease";
import * as NodePath from "node:path";

import { mirroredUrl, type ProvisionHost } from "../provision/host.ts";
import {
  GH_VERSION,
  ghDownload,
  NODE_VERSION,
  nodeDownload,
  type ToolPlatformKey,
} from "../provision/manifest.ts";

const TOOL_PLATFORM_KEYS: ReadonlyArray<ToolPlatformKey> = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
];

/** The nodejs.org and gh builds for Linux need glibc; Alpine and other musl systems have none. */
export function toolPlatformKey(
  platform: string,
  arch: string,
  glibc: boolean,
): ToolPlatformKey | null {
  if (platform === "linux" && !glibc) return null;
  const key = `${platform}-${arch}`;
  return TOOL_PLATFORM_KEYS.find((candidate) => candidate === key) ?? null;
}

/** nodejs.org's Linux builds need glibc; Node reports the runtime's version when it has one. */
export function runsOnGlibc(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return typeof report?.header?.glibcVersionRuntime === "string";
}

const pathFor = (platform: string) => (platform === "win32" ? NodePath.win32 : NodePath.posix);

/** The folder that holds `node` and `npx` once the app has installed Node.js. */
export function managedNodeDir(home: string, key: ToolPlatformKey): string {
  const path = pathFor(key.split("-")[0]!);
  const root = path.join(home, "runtime", "node", nodeDownload(key).stem);
  // Windows builds keep node.exe and npx.cmd at the top of their folder.
  return key.startsWith("win32") ? root : path.join(root, "bin");
}

/** The folder that holds `gh` once the app has installed it. */
export function managedGhDir(home: string, key: ToolPlatformKey): string {
  const path = pathFor(key.split("-")[0]!);
  return path.join(home, "tools", "gh", GH_VERSION, "bin");
}

/** Where Git for Windows puts the commands it adds to the system PATH. */
const windowsGitDirs = (env: Readonly<Record<string, string | undefined>>) =>
  [
    env["ProgramFiles"],
    env["ProgramW6432"],
    env["LOCALAPPDATA"] && `${env["LOCALAPPDATA"]}\\Programs`,
  ]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => NodePath.win32.join(dir, "Git", "cmd"));

/** Every folder the app may have installed a tool into, existing or not. */
export function managedToolDirs(input: {
  readonly home: string;
  readonly platform: string;
  readonly arch: string;
  readonly glibc: boolean;
}): ReadonlyArray<string> {
  const key = toolPlatformKey(input.platform, input.arch, input.glibc);
  return key === null ? [] : [managedNodeDir(input.home, key), managedGhDir(input.home, key)];
}

const pathEntries = (env: Readonly<Record<string, string | undefined>>, platform: string) => {
  const value = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
};

/** The first `name` in `dirs`, with Windows' executable extensions. */
async function findCommand(
  host: Pick<ProvisionHost, "isExecutable" | "exists" | "env">,
  platform: string,
  name: string,
  dirs: ReadonlyArray<string>,
): Promise<string | null> {
  const path = pathFor(platform);
  const extensions =
    platform === "win32"
      ? (host.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim().toLowerCase())
          .filter((extension) => extension !== "")
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (platform === "win32" ? await host.exists(candidate) : await host.isExecutable(candidate))
        return candidate;
    }
  }
  return null;
}

export interface MachineToolsContext {
  readonly host: ProvisionHost;
  /** The app's home (`config.baseDir`), where Node.js and gh are installed. */
  readonly home: string;
  readonly glibc: boolean;
  /** Version manager folders SpecWeave setup also searches for Node.js (nodeToolDirs). */
  readonly nodeManagerDirs: ReadonlyArray<string>;
}

const searchDirs = (ctx: MachineToolsContext) => [
  ...new Set([
    ...pathEntries(ctx.host.env, ctx.host.platform),
    ...managedToolDirs({ ...ctx, platform: ctx.host.platform, arch: ctx.host.arch }),
  ]),
];

async function packageManagerOf(ctx: MachineToolsContext): Promise<MachinePackageManager | null> {
  const { host } = ctx;
  if (host.platform === "win32") {
    const appAlias = host.env["LOCALAPPDATA"]
      ? [NodePath.win32.join(host.env["LOCALAPPDATA"], "Microsoft", "WindowsApps")]
      : [];
    return (await findCommand(host, "win32", "winget", [...searchDirs(ctx), ...appAlias])) === null
      ? null
      : "winget";
  }
  if (host.platform !== "linux") return null;
  const dirs = [...new Set([...searchDirs(ctx), "/usr/bin", "/bin", "/usr/sbin"])];
  const managers = [
    ["apt", "apt-get"],
    ["dnf", "dnf"],
    ["pacman", "pacman"],
    ["zypper", "zypper"],
  ] as const;
  for (const [manager, command] of managers) {
    if ((await findCommand(host, "linux", command, dirs)) !== null) return manager;
  }
  return null;
}

/**
 * Git, Node.js and gh on this machine, and which missing ones the app can
 * install. `git` comes from the agent search's own check (probeGit), which
 * knows the macOS developer-tools shim.
 */
export async function checkMachineTools(
  ctx: MachineToolsContext,
  git: "present" | "missing" | undefined,
): Promise<MachineToolsCheck> {
  const { host } = ctx;
  const dirs = searchDirs(ctx);
  const presence = (found: string | null): MachineToolPresence =>
    found === null ? "missing" : "present";
  const node = presence(
    await findCommand(host, host.platform, "node", [...new Set([...dirs, ...ctx.nodeManagerDirs])]),
  );
  const gh = presence(await findCommand(host, host.platform, "gh", dirs));
  const packageManager = await packageManagerOf(ctx);
  const key = toolPlatformKey(host.platform, host.arch, ctx.glibc);
  const gitState: MachineToolPresence = git ?? "unknown";
  const installable: MachineToolId[] = [];
  if (gitState === "missing" && (host.platform === "darwin" || packageManager === "winget"))
    installable.push("git");
  if (node === "missing" && key !== null) installable.push("node");
  if (gh === "missing" && key !== null) installable.push("gh");
  return { git: gitState, node, gh, packageManager, installable };
}

export type InstallLog = (line: string) => void;

export interface InstallOutcome {
  /** macOS or winget's installer carries on in its own window. */
  readonly handedOff: boolean;
  readonly detail: string;
  /** Folders to add to the server's PATH, so agents find the tool without a restart. */
  readonly pathDirs: ReadonlyArray<string>;
}

export class MachineToolInstallError extends Error {
  readonly code: "unsupported" | "present" | "failed";
  constructor(code: "unsupported" | "present" | "failed", message: string) {
    super(message);
    this.code = code;
  }
}

/** The last lines of a failed command, for the log's closing line. */
const tail = (result: { stdout: string; stderr: string }) =>
  `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/u).slice(-4).join(" ").slice(0, 600);

async function versionOf(host: ProvisionHost, binary: string): Promise<string | null> {
  const result = await host.exec(binary, ["--version"], { timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  return /(\d+\.\d+\.\d+)/u.exec(result.stdout)?.[1] ?? null;
}

/**
 * Downloads a pinned archive, checks its SHA-256, unpacks it into a staging
 * folder next to `destination` and moves it into place, so a stopped install
 * never leaves a half-unpacked tool behind.
 */
async function installPinned(
  ctx: MachineToolsContext,
  log: InstallLog,
  input: {
    readonly name: string;
    readonly pinned: { readonly url: string; readonly sha256: string; readonly maxBytes: number };
    readonly file: string;
    readonly destination: string;
    /** The binary, relative to the unpacked folder, that must report `version`. */
    readonly binary: string;
    readonly version: string;
  },
): Promise<void> {
  const { host } = ctx;
  const path = pathFor(host.platform);
  const downloads = path.join(ctx.home, "provision", "downloads");
  const archive = path.join(downloads, input.file);
  const staging = path.join(path.dirname(input.destination), ".staging-machine-tools");
  await host.mkdirp(downloads);
  await host.remove(archive);
  log(`Downloading ${input.pinned.url}`);
  let reported = 0;
  await host.download(
    mirroredUrl(input.pinned.url, host.env["STUDIO_PROVISION_MIRROR_URL"]),
    archive,
    {
      sha256: input.pinned.sha256,
      maxBytes: input.pinned.maxBytes,
      onProgress: (bytes) => {
        if (bytes - reported < 8 * 1024 * 1024) return;
        reported = bytes;
        log(`Downloaded ${Math.round(bytes / 1048576)} MB`);
      },
    },
  );
  log(`SHA-256 ${input.pinned.sha256} matches the pinned build.`);
  try {
    await host.remove(staging);
    await host.mkdirp(staging);
    log(`Unpacking ${input.name}`);
    // A service's PATH can be narrow; the system's own tar is always in /usr/bin or /bin.
    const tar =
      host.platform === "win32"
        ? cliArchiveTarCommand("win32", host.env)
        : ((await findCommand(host, host.platform, "tar", [
            ...pathEntries(host.env, host.platform),
            "/usr/bin",
            "/bin",
          ])) ?? "tar");
    const unpacked = await host.exec(
      tar,
      [input.file.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", staging],
      { timeoutMs: 10 * 60_000 },
    );
    if (unpacked.code !== 0)
      throw new MachineToolInstallError(
        "failed",
        `Unpacking ${input.name} failed: ${tail(unpacked)}`,
      );
    // Most archives wrap one folder; the Windows gh zip has its files at the top.
    const entries = (await host.listDir(staging)).filter((entry) => !entry.startsWith("."));
    const root =
      entries.length === 1 && (await host.exists(path.join(staging, entries[0]!, input.binary)))
        ? path.join(staging, entries[0]!)
        : staging;
    const reportedVersion = await versionOf(host, path.join(root, input.binary));
    if (reportedVersion !== input.version)
      throw new MachineToolInstallError(
        "failed",
        `The downloaded ${input.name} does not run on this machine${reportedVersion ? ` (it reports ${reportedVersion})` : ""}.`,
      );
    await host.remove(input.destination);
    await host.mkdirp(path.dirname(input.destination));
    await host.rename(root, input.destination);
    log(`${input.name} ${input.version} is in ${input.destination}`);
  } finally {
    await host.remove(staging);
    await host.remove(archive);
  }
}

const WINGET_GIT_ARGS = [
  "install",
  "--id",
  "Git.Git",
  "-e",
  "--source",
  "winget",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
] as const;
/** What the Windows Git button runs, shown with its log. */
const WINGET_GIT_COMMAND = `winget ${WINGET_GIT_ARGS.slice(0, 6).join(" ")}`;

/** Installs one missing tool. Refuses one that is already there or that needs an admin password. */
export async function installMachineTool(
  ctx: MachineToolsContext,
  tool: MachineToolId,
  git: "present" | "missing" | undefined,
  log: InstallLog,
): Promise<InstallOutcome> {
  const { host } = ctx;
  const before = await checkMachineTools(ctx, git);
  if (before[tool] === "present")
    throw new MachineToolInstallError(
      "present",
      `${tool === "gh" ? "GitHub CLI" : tool === "node" ? "Node.js" : "Git"} is already on this machine, so nothing was changed.`,
    );
  if (!before.installable.includes(tool))
    throw new MachineToolInstallError(
      "unsupported",
      tool === "git"
        ? "This machine needs Git installed with its package manager, which asks for an admin password."
        : "There is no pinned build for this machine, so install it from its own site.",
    );
  const key = toolPlatformKey(host.platform, host.arch, ctx.glibc);

  if (tool === "git" && host.platform === "darwin") {
    log("$ xcode-select --install");
    const result = await host.exec("/usr/bin/xcode-select", ["--install"], {
      timeoutMs: 60_000,
      onLine: log,
    });
    // It exits non-zero when macOS's window is already open or the tools are on their way.
    return {
      handedOff: true,
      detail:
        result.code === 0
          ? "macOS opened its own window to install its developer tools, which carry Git."
          : `macOS answered: ${tail(result)}`,
      pathDirs: [],
    };
  }
  if (tool === "git") {
    log(`$ ${WINGET_GIT_COMMAND}`);
    const winget =
      (await findCommand(host, "win32", "winget", [
        ...searchDirs(ctx),
        ...(host.env["LOCALAPPDATA"]
          ? [NodePath.win32.join(host.env["LOCALAPPDATA"], "Microsoft", "WindowsApps")]
          : []),
      ])) ?? "winget";
    const result = await host.exec(winget, [...WINGET_GIT_ARGS], {
      timeoutMs: 20 * 60_000,
      onLine: log,
    });
    if (result.code !== 0)
      throw new MachineToolInstallError("failed", `winget ended with exit code ${result.code}.`);
    return {
      handedOff: false,
      detail: "Git is installed.",
      pathDirs: windowsGitDirs(host.env),
    };
  }
  if (key === null)
    throw new MachineToolInstallError("unsupported", "No pinned build fits this machine.");
  const path = pathFor(host.platform);
  if (tool === "node") {
    const pinned = nodeDownload(key);
    await installPinned(ctx, log, {
      name: "Node.js",
      pinned,
      file: pinned.file,
      destination: path.join(ctx.home, "runtime", "node", pinned.stem),
      binary: key.startsWith("win32") ? "node.exe" : path.join("bin", "node"),
      version: NODE_VERSION,
    });
    return {
      handedOff: false,
      detail: `Node.js ${NODE_VERSION} is installed for SpecWithCode.`,
      pathDirs: [managedNodeDir(ctx.home, key)],
    };
  }
  const pinned = ghDownload(key);
  await installPinned(ctx, log, {
    name: "GitHub CLI",
    pinned,
    file: pinned.file,
    destination: path.join(ctx.home, "tools", "gh", GH_VERSION),
    binary: path.join("bin", key.startsWith("win32") ? "gh.exe" : "gh"),
    version: GH_VERSION,
  });
  return {
    handedOff: false,
    detail: `GitHub CLI ${GH_VERSION} is installed. Sign in with gh auth login.`,
    pathDirs: [managedGhDir(ctx.home, key)],
  };
}

/**
 * Adds folders to the end of a PATH that lacks them, so the person's own
 * tools keep coming first. Returns the new value, or undefined when unchanged.
 */
export function withPathDirs(
  current: string | undefined,
  dirs: ReadonlyArray<string>,
  platform: string,
): string | undefined {
  const delimiter = platform === "win32" ? ";" : ":";
  const entries = (current ?? "").split(delimiter).filter((entry) => entry !== "");
  const same = (a: string, b: string) =>
    platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const missing = dirs.filter((dir) => !entries.some((entry) => same(entry, dir)));
  if (missing.length === 0) return undefined;
  return [...entries, ...missing].join(delimiter);
}
