/** Looks at the machine: what is installed, where, and whether it runs. Changes nothing. */
import type { ProvisionProvider, ProvisionService } from "@specweave-studio/contracts";

import { type ProvisionHost } from "./host.ts";
import { nodeDownload, parseVersion } from "./manifest.ts";

import { type CheckedTarget } from "./target.ts";
import {
  type Ctx,
  LAUNCHD_LABEL,
  OUR_LAUNCHER_MARKER,
  PATH_DROP_IN,
  type Paths,
  type Probe,
  type Probes,
  type ProvisionOptions,
  SYSTEMD_UNIT,
  dirname,
  isLinux,
  join,
} from "./context.ts";

export async function readTargetFacts(host: ProvisionHost) {
  const platform = host.platform;
  let libc: "glibc" | "musl" | "darwin" | "unknown" = platform === "darwin" ? "darwin" : "unknown";
  if (platform === "linux") {
    const ldd = await host.exec("ldd", ["--version"], { timeoutMs: 5000 });
    const text = `${ldd.stdout}${ldd.stderr}`;
    libc = /musl/iu.test(text)
      ? "musl"
      : /glibc|gnu libc|gnu c library/iu.test(text)
        ? "glibc"
        : "unknown";
    if (libc === "unknown" && (await host.exists("/etc/alpine-release"))) libc = "musl";
  }
  const macosVersion =
    platform === "darwin"
      ? (await host.exec("sw_vers", ["-productVersion"], { timeoutMs: 5000 })).stdout.trim() || null
      : null;
  return {
    platform,
    arch: host.arch,
    osRelease: platform === "linux" ? await host.readText("/etc/os-release") : null,
    macosVersion,
    libc,
    systemd: platform === "linux" && (await host.exists("/run/systemd/system")),
    wsl: platform === "linux" && /microsoft/iu.test((await host.readText("/proc/version")) ?? ""),
  };
}

export const stripTarget = (target: CheckedTarget) => ({
  platform: target.platform,
  arch: target.arch,
  osId: target.osId,
  osVersion: target.osVersion,
  prettyName: target.prettyName,
  libc: target.libc,
  init: target.init,
  supported: target.supported,
  reason: target.reason,
  nearest: target.nearest,
});

export const emptyService = (home: string | null): ProvisionService => ({
  manager: "none",
  unit: null,
  installed: false,
  active: false,
  version: null,
  home,
  missingOnPath: [],
});

export async function resolvePaths(host: ProvisionHost, options: ProvisionOptions): Promise<Paths> {
  const unitPath = join(host.home, ".config/systemd/user", SYSTEMD_UNIT);
  const plistPath = join(host.home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  let home = options.baseDir ?? host.env.STUDIO_HOME ?? null;
  let homeSource = options.baseDir ? "--base-dir" : host.env.STUDIO_HOME ? "STUDIO_HOME" : "";
  if (!home) {
    // The installed service names its home; provisioning works on that one.
    const unit = (await host.readText(unitPath)) ?? (await host.readText(plistPath)) ?? "";
    const fromUnit =
      /^Environment="?STUDIO_HOME=([^"\n]+)"?$/mu.exec(unit)?.[1] ??
      /<key>STUDIO_HOME<\/key>\s*<string>([^<]+)<\/string>/u.exec(unit)?.[1];
    if (fromUnit) {
      home = fromUnit;
      homeSource = "the installed service";
    }
  }
  if (!home) {
    const legacy = join(host.home, ".specweave-studio");
    const branded = join(host.home, ".specwithcode");
    home =
      (await host.readLink(legacy)) !== null
        ? branded
        : (await host.exists(join(legacy, "userdata"))) || (await host.exists(join(legacy, "dev")))
          ? legacy
          : (await host.exists(branded)) || !(await host.exists(legacy))
            ? branded
            : legacy;
    homeSource = "the default";
  }
  const provisionDir = join(home, "provision");
  return {
    home,
    homeSource,
    binDir: host.env.STUDIO_INSTALL_BIN_DIR ?? join(host.home, ".local/bin"),
    provisionDir,
    statePath: join(provisionDir, "state.json"),
    lockPath: join(provisionDir, "run.lock"),
    downloads: join(provisionDir, "downloads"),
    unitPath,
    plistPath,
  };
}

/** Where agents look: the login-shell PATH the server reads at start, plus the usual user folders. */
export function searchPathFor(ctx: Ctx): string {
  const parts = [
    ctx.paths.binDir,
    join(ctx.host.home, ".local/share/specweave/providers/bin"),
    ...(ctx.options.loginShellPath() ?? "").split(":"),
    ...(ctx.options.serverPath ?? "").split(":"),
    ...(ctx.host.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(parts.filter((part) => part.length > 0))].join(":");
}

export async function versionOf(host: ProvisionHost, path: string | null, args = ["--version"]) {
  if (!path) return null;
  const result = await host.exec(path, args, {
    timeoutMs: 20_000,
    env: { DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" },
  });
  return result.code === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : null;
}

/**
 * Whether the command agents find is one provisioning may replace: null when
 * none is found, false when it lives elsewhere (Homebrew, apt, a manual copy),
 * since a copy in the user bin folder would only shadow it.
 */
export async function ownsLauncher(
  ctx: Ctx,
  link: string,
  managedRoot: string,
  foundPath?: string | null,
): Promise<boolean | null> {
  if (foundPath !== undefined && foundPath !== null && foundPath !== link) return false;
  if (!(await ctx.host.exists(link))) return null;
  const target = await ctx.host.readLink(link);
  if (target !== null) return target.startsWith(`${managedRoot}/`);
  const text = (await ctx.host.readText(link)) ?? "";
  return text.split("\n")[1] === OUR_LAUNCHER_MARKER;
}

export async function probeAll(ctx: Ctx): Promise<Probes> {
  const { host, paths } = ctx;
  const searchPath = searchPathFor(ctx);
  const which = (name: string) => host.which(name, searchPath);

  const gitPath =
    ctx.target.platform === "darwin" &&
    (await host.exec("xcode-select", ["-p"], { timeoutMs: 5000 })).code !== 0
      ? null
      : await which("git");
  const ghPath = await which("gh");
  const claudePath = await which("claude");
  const codexPath = await which("codex");
  const tailscalePath =
    (await which("tailscale")) ??
    ((await host.isExecutable("/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
      ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
      : null);

  const privateNode = join(paths.home, "runtime/node", nodeDownload(ctx.key).stem, "bin/node");
  const runtimeOk = /^v22\.(\d+)\./u.exec(ctx.options.runtime.version);
  const node: Probe =
    runtimeOk && Number(runtimeOk[1]) >= 20
      ? {
          found: ctx.options.runtime.version.replace(/^v/u, ""),
          path: ctx.options.runtime.execPath,
          detail: `This command runs on ${ctx.options.runtime.execPath}.`,
        }
      : {
          found: await versionOf(host, (await host.isExecutable(privateNode)) ? privateNode : null),
          path: privateNode,
        };

  let tailscaleState: string | null = null;
  if (tailscalePath) {
    const status = await host.exec(tailscalePath, ["status", "--json"], { timeoutMs: 10_000 });
    tailscaleState = /"BackendState":\s*"([A-Za-z]+)"/u.exec(status.stdout)?.[1] ?? null;
  }

  const launchers: Record<string, string | null> = {};
  for (const name of ["specwithcode", "specweave-studio"]) {
    const path = join(paths.binDir, name);
    launchers[name] = (await host.isExecutable(path)) ? await versionOf(host, path) : null;
  }
  const serverFound = launchers.specwithcode ?? launchers["specweave-studio"] ?? null;

  const service = await probeService(ctx);
  const servicePath = await probeServicePath(ctx, service, {
    claude: claudePath,
    codex: codexPath,
    gh: ghPath,
    git: gitPath,
  });

  let linger: boolean | null = null;
  let sleepMasked: boolean | null = null;
  if (isLinux(ctx.target)) {
    const result = await host.exec(
      "loginctl",
      ["show-user", host.user, "-p", "Linger", "--value"],
      { timeoutMs: 5000 },
    );
    linger =
      result.code === 0
        ? result.stdout.trim() === "yes"
        : await host.exists(`/var/lib/systemd/linger/${host.user}`);
    const sleep = await host.exec("systemctl", ["is-enabled", "sleep.target"], { timeoutMs: 5000 });
    sleepMasked = /masked/u.test(sleep.stdout);
  }

  const providers = await probeProviders(ctx, { claude: claudePath, codex: codexPath, gh: ghPath });
  return {
    searchPath,
    git: { found: await versionOf(host, gitPath), path: gitPath },
    gh: {
      found: await versionOf(host, ghPath),
      path: ghPath,
      ours: await ownsLauncher(ctx, join(paths.binDir, "gh"), join(paths.home, "tools/gh"), ghPath),
    },
    node,
    claude: {
      found: await versionOf(host, claudePath),
      path: claudePath,
      ours: await ownsLauncher(
        ctx,
        join(paths.binDir, "claude"),
        join(host.home, ".local/share/claude/versions"),
        claudePath,
      ),
    },
    codex: {
      found: await versionOf(host, codexPath),
      path: codexPath,
      ours: await ownsLauncher(
        ctx,
        join(paths.binDir, "codex"),
        join(paths.home, "tools/codex"),
        codexPath,
      ),
    },
    tailscale: {
      found: await versionOf(host, tailscalePath, ["version"]),
      path: tailscalePath,
      state: tailscaleState,
    },
    server: { found: serverFound, path: join(paths.binDir, "specwithcode"), launchers },
    manager: await probeManager(ctx),
    service,
    servicePath,
    linger,
    sleepMasked,
    providers,
  };
}

const DESKTOP_APPS = (home: string) => [
  "/Applications/SpecWithCode.app",
  join(home, "Applications/SpecWithCode.app"),
];

/** The same detection as install.sh's find_existing_install, for macOS only. */
export async function probeManager(ctx: Ctx): Promise<Probes["manager"]> {
  const { host } = ctx;
  if (ctx.target.platform !== "darwin") return null;
  const agents = join(host.home, "Library/LaunchAgents");
  for (const name of await host.listDir(agents)) {
    const match = /^(com\.specweave\.studio\.[^/]+)\.plist$/u.exec(name);
    if (!match || name === `${LAUNCHD_LABEL}.plist` || name.endsWith(".updater.plist")) continue;
    // Helpers beside a managed server (health checks, tunnels) are not the server.
    if (/\.(health|tunnel-[^.]+)(\.|$)/u.test(match[1]!)) continue;
    return { kind: "managed", label: match[1]!, version: await desktopVersion(ctx) };
  }
  if (ctx.options.standalone) return null;
  for (const app of DESKTOP_APPS(host.home)) {
    if (!(await host.isExecutable(join(app, "Contents/MacOS/SpecWithCode")))) continue;
    return { kind: "desktop", label: app, version: await desktopVersion(ctx, app) };
  }
  return null;
}

async function desktopVersion(ctx: Ctx, only?: string): Promise<string | null> {
  for (const app of only ? [only] : DESKTOP_APPS(ctx.host.home)) {
    const plist = await ctx.host.readText(join(app, "Contents/Info.plist"));
    const version = plist
      ? /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]
      : undefined;
    if (version) return version;
  }
  return null;
}

export async function probeService(ctx: Ctx): Promise<ProvisionService> {
  const { host, paths } = ctx;
  if (isLinux(ctx.target)) {
    const unit = await host.readText(paths.unitPath);
    const active =
      (
        await host.exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { timeoutMs: 10_000 })
      ).stdout.trim() === "active";
    const version = unit ? (/runtime\/versions\/([^/\s]+)\//u.exec(unit)?.[1] ?? null) : null;
    return {
      manager: "systemd",
      unit: unit === null ? null : paths.unitPath,
      installed: unit !== null,
      active,
      version: version ?? (unit ? await serviceStatusVersion(ctx) : null),
      home: paths.home,
      missingOnPath: [],
    };
  }
  const plist = await host.readText(paths.plistPath);
  const printed = await host.exec("launchctl", ["print", `gui/${host.uid}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  });
  return {
    manager: "launchd",
    unit: plist === null ? null : paths.plistPath,
    installed: plist !== null,
    active: printed.code === 0 && /state = running/u.test(printed.stdout),
    version: plist ? await serviceStatusVersion(ctx) : null,
    home: paths.home,
    missingOnPath: [],
  };
}

export async function serviceStatusVersion(ctx: Ctx): Promise<string | null> {
  const launcher = join(ctx.paths.binDir, "specwithcode");
  if (!(await ctx.host.isExecutable(launcher))) return null;
  const status = await ctx.host.exec(launcher, ["service", "status"], {
    timeoutMs: 20_000,
    env: { STUDIO_HOME: ctx.paths.home },
  });
  return /@(\d+\.\d+\.\d+[^\s]*)/u.exec(status.stdout)?.[1] ?? null;
}

/**
 * The server merges its login shell's PATH into the one the service manager
 * gave it (os-jank fixPath), and agents inherit the result. An agent command is
 * missing only when its folder is on neither.
 */
export async function probeServicePath(
  ctx: Ctx,
  service: ProvisionService,
  commands: Record<string, string | null>,
): Promise<Probes["servicePath"]> {
  const dropInPath = join(dirname(ctx.paths.unitPath), `${SYSTEMD_UNIT}.d`, PATH_DROP_IN);
  const dropInText = isLinux(ctx.target) ? await ctx.host.readText(dropInPath) : null;
  let managerPath = "";
  if (ctx.options.serverPath !== undefined) managerPath = ctx.options.serverPath;
  else if (isLinux(ctx.target) && service.installed) {
    const shown = await ctx.host.exec(
      "systemctl",
      ["--user", "show", SYSTEMD_UNIT, "-p", "Environment", "--value"],
      { timeoutMs: 10_000 },
    );
    managerPath = /(?:^|\s)"?PATH=([^\s"]+)/u.exec(shown.stdout)?.[1] ?? "";
    if (!managerPath) {
      const env = await ctx.host.exec("systemctl", ["--user", "show-environment"], {
        timeoutMs: 10_000,
      });
      managerPath = /^PATH=(.*)$/mu.exec(env.stdout)?.[1] ?? "/usr/local/bin:/usr/bin:/bin";
    }
  } else if (service.unit && !isLinux(ctx.target)) {
    const plist = (await ctx.host.readText(service.unit)) ?? "";
    managerPath = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1] ?? "";
  }
  const shellPath = ctx.options.serverPath !== undefined ? "" : ctx.options.loginShellPath();
  const shellUnread = ctx.options.serverPath === undefined && shellPath === undefined;
  const effective =
    ctx.options.serverPath !== undefined
      ? managerPath
      : [
          ...new Set(
            [
              ...(shellPath ?? ctx.host.env.PATH ?? "").split(":"),
              ...managerPath.split(":"),
            ].filter(Boolean),
          ),
        ].join(":");
  const missing: string[] = [];
  for (const [name, path] of Object.entries(commands)) {
    if (!path) continue;
    if (!(await ctx.host.which(name, effective))) missing.push(name);
  }
  return { effective, missing, dropIn: dropInText !== null, shellUnread };
}

export async function probeProviders(
  ctx: Ctx,
  paths: { claude: string | null; codex: string | null; gh: string | null },
): Promise<ProvisionProvider[]> {
  const { host } = ctx;
  const claudeSignedIn = async () => {
    if (host.env.ANTHROPIC_API_KEY) return true;
    const credentials = await host.readText(join(host.home, ".claude/.credentials.json"));
    if (credentials && credentials.trim().length > 0) return true;
    const settings = (await host.readText(join(host.home, ".claude/settings.json"))) ?? "";
    if (/"apiKeyHelper"/u.test(settings)) return true;
    if (ctx.target.platform === "darwin") {
      // Presence of the keychain item only; -w (the secret) is never asked for.
      const item = await host.exec(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials"],
        { timeoutMs: 5000 },
      );
      return item.code === 0;
    }
    return false;
  };
  const codexHome = host.env.CODEX_HOME ?? join(host.home, ".codex");
  return [
    {
      id: "claude",
      found: paths.claude !== null,
      version: await versionOf(host, paths.claude),
      path: paths.claude,
      signedIn: paths.claude ? await claudeSignedIn() : null,
    },
    {
      id: "codex",
      found: paths.codex !== null,
      version: await versionOf(host, paths.codex),
      path: paths.codex,
      signedIn: paths.codex
        ? ((await host.readText(join(codexHome, "auth.json")))?.trim().length ?? 0) > 0
        : null,
    },
    {
      id: "gh",
      found: paths.gh !== null,
      version: await versionOf(host, paths.gh),
      path: paths.gh,
      signedIn: paths.gh
        ? (await host.exec(paths.gh, ["auth", "status"], { timeoutMs: 15_000 })).code === 0
        : null,
    },
  ];
}
