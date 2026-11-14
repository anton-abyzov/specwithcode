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
  MachineReadinessToolId,
  MachineToolId,
  MachineToolPresence,
  MachineToolsCheck,
  MachineToolStatus,
} from "@specweave-studio/contracts";
import { cliArchiveTarCommand } from "@specweave-studio/shared/cliRelease";
import { compareSemverVersions } from "@specweave-studio/shared/semver";
import * as NodePath from "node:path";

import { mirroredUrl, type ProvisionHost } from "../provision/host.ts";
import { acquireProvisionLock } from "../provision/runner.ts";
import {
  GH_VERSION,
  ghDownload,
  NODE_MIN_MAJOR,
  NODE_VERSION,
  nodeDownload,
  SPECWEAVE_MIN_VERSION,
  SPECWEAVE_VERSION,
  type ToolPlatformKey,
} from "../provision/manifest.ts";
import {
  installSpecweave,
  managedSpecweaveDir,
  SpecweaveInstallFailure,
  specweaveVersionAt,
} from "./specweaveTool.ts";

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

let glibc: boolean | undefined;

/**
 * nodejs.org's Linux builds need glibc; Node reports the runtime's version when
 * it has one. A diagnostic report is heavy, so it is built once, and only on Linux.
 */
export function runsOnGlibc(): boolean {
  if (glibc !== undefined) return glibc;
  // oxlint-disable-next-line studio/no-global-process-runtime -- the running server's own libc.
  if (process.platform !== "linux") return (glibc = false);
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    glibc = typeof report?.header?.glibcVersionRuntime === "string";
  } catch {
    glibc = false;
  }
  return glibc;
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

/** Every folder the app installs its current pins into, existing or not. */
export function managedToolDirs(input: {
  readonly home: string;
  readonly platform: string;
  readonly arch: string;
  readonly glibc: boolean;
}): ReadonlyArray<string> {
  const key = toolPlatformKey(input.platform, input.arch, input.glibc);
  const specweave = managedSpecweaveDir(input.home, input.platform);
  return key === null
    ? [specweave]
    : [managedNodeDir(input.home, key), managedGhDir(input.home, key), specweave];
}

const VERSION_DIR = /^v?(\d+\.\d+\.\d+)$/u;
const newestFirst = (a: string, b: string) => compareSemverVersions(b, a);

/**
 * The folders of the app's own copies that exist, one per tool: the current
 * pin's, else the newest older one. An app update moves a pin before its
 * quiet check installs the new build, and until then the older copy stays on
 * the PATH, so agents never lose a tool they had.
 */
export async function existingManagedToolDirs(
  host: Pick<ProvisionHost, "exists" | "listDir">,
  input: {
    readonly home: string;
    readonly platform: string;
    readonly arch: string;
    readonly glibc: boolean;
  },
): Promise<ReadonlyArray<string>> {
  const path = pathFor(input.platform);
  const key = toolPlatformKey(input.platform, input.arch, input.glibc);
  const found: string[] = [];
  const pick = async (current: string, olderOf: () => Promise<ReadonlyArray<string>>) => {
    if (await host.exists(current)) return found.push(current);
    for (const dir of await olderOf()) if (await host.exists(dir)) return found.push(dir);
  };
  const versionDirs = async (root: string) =>
    (await host.listDir(root))
      .flatMap((name) => {
        const version = VERSION_DIR.exec(name)?.[1];
        return version === undefined ? [] : [version];
      })
      .toSorted(newestFirst);
  if (key !== null) {
    const nodeRoot = path.join(input.home, "runtime", "node");
    const suffix = nodeDownload(key).stem.slice(`node-v${NODE_VERSION}`.length);
    await pick(managedNodeDir(input.home, key), async () =>
      (await host.listDir(nodeRoot))
        .flatMap((name) => {
          const version = /^node-v(\d+\.\d+\.\d+)(.*)$/u.exec(name);
          return version && version[2] === suffix ? [version[1]!] : [];
        })
        .toSorted(newestFirst)
        .map((version) => {
          const root = path.join(nodeRoot, `node-v${version}${suffix}`);
          return key.startsWith("win32") ? root : path.join(root, "bin");
        }),
    );
    const ghRoot = path.join(input.home, "tools", "gh");
    await pick(managedGhDir(input.home, key), async () =>
      (await versionDirs(ghRoot)).map((version) => path.join(ghRoot, version, "bin")),
    );
  }
  const specweaveRoot = path.join(input.home, "tools", "specweave");
  await pick(managedSpecweaveDir(input.home, input.platform), async () =>
    (await versionDirs(specweaveRoot)).map((version) =>
      input.platform === "win32"
        ? path.join(specweaveRoot, version)
        : path.join(specweaveRoot, version, "bin"),
    ),
  );
  return found;
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

const isManaged = (ctx: MachineToolsContext, found: string) => {
  const path = pathFor(ctx.host.platform);
  const inside = (root: string) => {
    const relative = path.relative(root, found);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  return inside(path.join(ctx.home, "runtime", "node")) || inside(path.join(ctx.home, "tools"));
};

const older = (version: string | null, than: string) =>
  version !== null && compareSemverVersions(version, than) < 0;

/** Where a tool was found, and the version that runs. */
async function locate(
  ctx: MachineToolsContext,
  tool: "node" | "gh" | "specweave",
  dirs: ReadonlyArray<string>,
): Promise<{ readonly path: string; readonly version: string | null } | null> {
  const { host } = ctx;
  const found = await findCommand(host, host.platform, tool, dirs);
  if (found === null) return null;
  const version =
    tool === "specweave" ? await specweaveVersionAt(host, found) : await versionOf(host, found);
  return { path: found, version };
}

/**
 * Git, Node.js, gh and SpecWeave on this machine, their versions, and which
 * ones the app can install or bring up to date. `git` comes from the agent
 * search's own check (probeGit), which knows the macOS developer-tools shim.
 */
export async function checkMachineTools(
  ctx: MachineToolsContext,
  git: "present" | "missing" | undefined,
): Promise<MachineToolsCheck> {
  const { host } = ctx;
  const dirs = searchDirs(ctx);
  const presence = (found: unknown): MachineToolPresence =>
    found === null ? "missing" : "present";
  const nodeFound = await locate(ctx, "node", [...new Set([...dirs, ...ctx.nodeManagerDirs])]);
  const ghFound = await locate(ctx, "gh", dirs);
  const specweaveFound = await locate(ctx, "specweave", [
    ...new Set([...dirs, ...ctx.nodeManagerDirs]),
  ]);
  const node = presence(nodeFound);
  const gh = presence(ghFound);
  const packageManager = await packageManagerOf(ctx);
  const key = toolPlatformKey(host.platform, host.arch, ctx.glibc);
  const gitState: MachineToolPresence = git ?? "unknown";
  const installable: MachineToolId[] = [];
  if (gitState === "missing" && (host.platform === "darwin" || packageManager === "winget"))
    installable.push("git");
  if (node === "missing" && key !== null) installable.push("node");
  if (gh === "missing" && key !== null) installable.push("gh");

  const status = (
    tool: MachineReadinessToolId,
    found: { readonly path: string; readonly version: string | null } | null,
    outdatedFor: (version: string | null, managed: boolean) => boolean,
    installableWhenMissing: boolean,
    updatable: boolean,
  ): MachineToolStatus => {
    const managed = found !== null && isManaged(ctx, found.path);
    const outdated = found !== null && outdatedFor(found.version, managed);
    return {
      tool,
      presence: presence(found),
      version: found?.version ?? null,
      managed,
      outdated,
      // The person's own copy is never replaced; the app's own older one is.
      canInstall: found === null ? installableWhenMissing : outdated && managed && updatable,
    };
  };
  const nodeMajor = (version: string | null) =>
    version === null ? null : Number.parseInt(version, 10);
  const tools: MachineToolStatus[] = [
    {
      tool: "git",
      presence: gitState,
      version: null,
      managed: false,
      outdated: false,
      canInstall: installable.includes("git"),
    },
    status(
      "node",
      nodeFound,
      (version, managed) =>
        (nodeMajor(version) ?? NODE_MIN_MAJOR) < NODE_MIN_MAJOR ||
        (managed && older(version, NODE_VERSION)),
      installable.includes("node"),
      key !== null,
    ),
    status(
      "gh",
      ghFound,
      (version, managed) => managed && older(version, GH_VERSION),
      installable.includes("gh"),
      key !== null,
    ),
    status(
      "specweave",
      specweaveFound,
      (version, managed) =>
        older(version, SPECWEAVE_MIN_VERSION) || (managed && older(version, SPECWEAVE_VERSION)),
      // SpecWeave installs with a recent enough Node.js on the machine, or one the app installs first.
      (nodeFound !== null && (nodeMajor(nodeFound.version) ?? NODE_MIN_MAJOR) >= NODE_MIN_MAJOR) ||
        installable.includes("node"),
      true,
    ),
  ];
  return { git: gitState, node, gh, packageManager, installable, tools };
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
  readonly code: "unsupported" | "busy" | "present" | "failed";
  constructor(code: "unsupported" | "busy" | "present" | "failed", message: string) {
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
type PinnedInstall = {
  readonly name: string;
  readonly pinned: { readonly url: string; readonly sha256: string; readonly maxBytes: number };
  readonly file: string;
  readonly destination: string;
  /** The binary, relative to the unpacked folder, that must report `version`. */
  readonly binary: string;
  readonly version: string;
};

/**
 * Provisioning writes the same folders, so an install takes its lock and
 * waits for no one: while it runs, the person is told to try again after.
 */
async function installPinned(
  ctx: MachineToolsContext,
  log: InstallLog,
  input: PinnedInstall,
): Promise<void> {
  await withInstallLock(ctx, () => installPinnedUnlocked(ctx, log, input));
}

async function withInstallLock<A>(ctx: MachineToolsContext, run: () => Promise<A>): Promise<A> {
  const path = pathFor(ctx.host.platform);
  const provisionDir = path.join(ctx.home, "provision");
  await ctx.host.mkdirp(provisionDir);
  const release = await acquireProvisionLock(ctx.host, path.join(provisionDir, "run.lock"));
  if (release === null)
    throw new MachineToolInstallError(
      "busy",
      "SpecWithCode is setting this machine up right now. Try again when that ends.",
    );
  try {
    return await run();
  } finally {
    await release();
  }
}

/** The display name of each tool, for messages. */
export const machineToolName = (tool: MachineReadinessToolId) =>
  tool === "gh"
    ? "GitHub CLI"
    : tool === "node"
      ? "Node.js"
      : tool === "specweave"
        ? "SpecWeave"
        : "Git";

/** The Node.js an npm install runs with: the machine's own first, else the app's; never one older than SpecWeave supports. */
async function findNodeForNpm(ctx: MachineToolsContext): Promise<string | null> {
  const found = await locate(ctx, "node", [
    ...new Set([...searchDirs(ctx), ...ctx.nodeManagerDirs]),
  ]);
  if (found === null) return null;
  const major = found.version === null ? null : Number.parseInt(found.version, 10);
  if (major !== null && major < NODE_MIN_MAJOR)
    throw new MachineToolInstallError(
      "unsupported",
      `SpecWeave needs Node.js ${NODE_MIN_MAJOR} or newer, and the Node.js at ${found.path} is version ${found.version}. Update it where you installed it, then install SpecWeave.`,
    );
  return found.path;
}

async function installPinnedUnlocked(
  ctx: MachineToolsContext,
  log: InstallLog,
  input: PinnedInstall,
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
      {
        timeoutMs: 10 * 60_000,
        // GNU tar runs gzip from the PATH, which a service may not carry.
        ...(host.platform === "win32"
          ? {}
          : {
              env: {
                PATH:
                  withPathDirs(host.env["PATH"], ["/usr/bin", "/bin"], host.platform) ??
                  host.env["PATH"],
              },
            }),
      },
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
  tool: MachineReadinessToolId,
  git: "present" | "missing" | undefined,
  log: InstallLog,
): Promise<InstallOutcome> {
  const { host } = ctx;
  const before = await checkMachineTools(ctx, git);
  const current = before.tools?.find((entry) => entry.tool === tool);
  const updating = current?.presence === "present" && current.outdated && current.managed;
  if (current?.presence === "present" && !updating)
    throw new MachineToolInstallError(
      "present",
      `${machineToolName(tool)} is already on this machine, so nothing was changed.`,
    );
  if (tool === "specweave") {
    if (!current?.canInstall) {
      const node = before.tools?.find((entry) => entry.tool === "node");
      throw new MachineToolInstallError(
        "unsupported",
        node?.presence === "present" && node.outdated && !node.managed
          ? `SpecWeave needs Node.js ${NODE_MIN_MAJOR} or newer, and this machine has Node.js ${node.version ?? "of an older version"}. Update it where you installed it, then install SpecWeave.`
          : "SpecWeave runs on Node.js, which this machine does not have. Install Node.js first.",
      );
    }
    return withInstallLock(ctx, () => installSpecweave(ctx, log, findNodeForNpm)).catch(
      (cause: unknown) => {
        throw cause instanceof SpecweaveInstallFailure
          ? new MachineToolInstallError(cause.code, cause.message)
          : cause;
      },
    );
  }
  // The app's own older copy is replaced by the current pin, next to it.
  if (!updating && !before.installable.includes(tool))
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
    // Tools macOS counts as installed, yet no Git runs: no window opens, so say so.
    if (result.code !== 0 && /already installed/iu.test(`${result.stdout}\n${result.stderr}`))
      throw new MachineToolInstallError(
        "failed",
        "macOS says its developer tools are already installed, but Git does not run. Open Terminal and run git --version to see why.",
      );
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
/**
 * The PATH with `dirs` in place of the app's other copies of the same tools
 * (another version under the same `runtime/node`, `tools/gh` or
 * `tools/specweave` folder), at the place the old copy had, so an update takes
 * effect without a restart. Other entries keep their order.
 */
export function swapManagedPathDirs(
  current: string | undefined,
  dirs: ReadonlyArray<string>,
  home: string,
  platform: string,
): string | undefined {
  const path = pathFor(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const roots = [
    path.join(home, "runtime", "node"),
    path.join(home, "tools", "gh"),
    path.join(home, "tools", "specweave"),
  ].map((root) => fold(root) + path.sep);
  const rootOf = (dir: string) => roots.find((root) => fold(dir).startsWith(root));
  const replaced = new Set(dirs.map(rootOf).filter((root) => root !== undefined));
  const wanted = new Set(dirs.map(fold));
  const entries = (current ?? "").split(delimiter).filter((entry) => entry !== "");
  const out: string[] = [];
  let placed = false;
  for (const entry of entries) {
    const root = rootOf(entry);
    const stale = (root !== undefined && replaced.has(root)) || wanted.has(fold(entry));
    if (!stale) out.push(entry);
    else if (!placed) {
      out.push(...dirs);
      placed = true;
    }
  }
  if (!placed) out.push(...dirs);
  const next = out.join(delimiter);
  return next === entries.join(delimiter) ? undefined : next;
}

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
