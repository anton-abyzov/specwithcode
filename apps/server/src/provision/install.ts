/** Root steps and user-level installs; each verified before it is put in place. */
import type {
  ProvisionItem,
  ProvisionItemId,
  ProvisionRootStep,
} from "@specweave-studio/contracts";

import { type ExecOptions, mirroredUrl, userManagerEnv } from "./host.ts";
import {
  CLAUDE_VERSION,
  claudeDownload,
  codexDownload,
  compareVersions,
  GH_VERSION,
  ghDownload,
  GIT_MIN_VERSION,
  NODE_VERSION,
  nodeDownload,
  TAILSCALE_KEYRING_SHA256,
  TAILSCALE_MAC_PKG_URL,
  tailscaleKeyringUrl,
} from "./manifest.ts";
import { renderRootScript, shellQuote, type RootPlan } from "./rootScript.ts";
import {
  type Ctx,
  OUR_LAUNCHER_MARKER,
  PATH_DROP_IN,
  type Probes,
  SYSTEMD_UNIT,
  dirname,
  isLinux,
  join,
} from "./context.ts";
import { ownsLauncher, versionOf } from "./probe.ts";
import { item, tailscaleItem } from "./plan.ts";

// ---------------------------------------------------------------------------
// Root steps

export function buildRootPlan(ctx: Ctx, p: Probes): RootPlan {
  const linux = isLinux(ctx.target);
  const needsGit = linux && compareVersions(p.git.found, GIT_MIN_VERSION) < 0;
  // Planned only when missing and wanted (no Connect link, or --with-tailscale); an
  // installed app bundle on macOS is never planned, so `installer -pkg` never runs over it.
  const needsTailscale = tailscaleItem(ctx, p).status === "planned";
  return {
    platform: linux ? "linux" : "darwin",
    user: ctx.host.user,
    generatedAt: ctx.host.now().toISOString(),
    aptPackages: needsGit ? ["git", "ca-certificates"] : [],
    tailscale: needsTailscale
      ? linux
        ? {
            file: join(ctx.paths.downloads, "tailscale-archive-keyring.gpg"),
            distro: ctx.target.distro ?? "ubuntu",
            codename: ctx.target.codename ?? "noble",
          }
        : { file: join(ctx.paths.downloads, "Tailscale.pkg") }
      : null,
    enableLinger: linux && p.linger === false,
  };
}

export const rootItems = (plan: RootPlan): ProvisionItemId[] => [
  ...(plan.aptPackages.includes("git") ? (["git"] as const) : []),
  ...(plan.tailscale ? (["tailscale"] as const) : []),
  ...(plan.enableLinger ? (["linger"] as const) : []),
];

export function describeRootStep(ctx: Ctx, plan: RootPlan, ran: boolean): ProvisionRootStep {
  const script = join(ctx.paths.provisionDir, "root-steps.sh");
  const text = renderRootScript(plan);
  return {
    command: `sudo sh ${shellQuote(script)}`,
    script,
    sha256: ctx.host.sha256Text(text),
    items: rootItems(plan),
    ran,
  };
}

export async function runRootStep(ctx: Ctx, plan: RootPlan): Promise<ProvisionRootStep> {
  const { host } = ctx;
  if (plan.tailscale) {
    if (isLinux(ctx.target))
      await host.download(
        mirroredUrl(
          tailscaleKeyringUrl(plan.tailscale.distro!, plan.tailscale.codename!),
          host.env.STUDIO_PROVISION_MIRROR_URL,
        ),
        plan.tailscale.file,
        { sha256: TAILSCALE_KEYRING_SHA256, maxBytes: 64 * 1024 },
      );
    // Signed package: the root script checks its Developer ID before installing.
    else
      await host.downloadSigned(
        mirroredUrl(TAILSCALE_MAC_PKG_URL, host.env.STUDIO_PROVISION_MIRROR_URL),
        plan.tailscale.file,
        300 * 1024 * 1024,
      );
  }
  const step = describeRootStep(ctx, plan, false);
  await host.writeText(step.script, renderRootScript(plan), 0o644);
  await ctx.log(`root steps written to ${step.script} (sha256 ${step.sha256})`);
  const onLine = (line: string) => {
    ctx.emit({ type: "log", id: step.items[0] ?? "git", line: line.slice(0, 1900) });
    void ctx.log(`root: ${line}`);
  };
  let result: { code: number } | null = null;
  if (host.uid === 0)
    result = await host.exec("sh", [step.script], { timeoutMs: 30 * 60_000, onLine });
  else if ((await host.exec("sudo", ["-n", "true"], { timeoutMs: 10_000 })).code === 0)
    result = await host.exec("sudo", ["-n", "sh", step.script], { timeoutMs: 30 * 60_000, onLine });
  else if (host.interactive && ctx.options.mode === "cli") {
    // The password goes to sudo at this terminal; the app never sees it.
    process.stderr.write(
      `\nThese steps need root: ${step.items.join(", ")}.\nsudo asks for your password here.\n`,
    );
    result = await host.exec("sudo", ["sh", step.script], {
      timeoutMs: 30 * 60_000,
      inheritStdio: true,
    });
  }
  if (result === null) {
    await ctx.log(
      `root steps not run: run ${step.command} in this machine's terminal, then specwithcode provision again`,
    );
    return step;
  }
  await ctx.log(`root steps exited ${result.code}`);
  return { ...step, ran: result.code === 0 };
}

// ---------------------------------------------------------------------------
// Installs. Each downloads into <home>/provision/downloads, checks the pinned
// SHA-256, unpacks into a staging folder and moves the result into place, so a
// killed run never leaves a half-installed command behind.

export const url = (ctx: Ctx, value: string) =>
  mirroredUrl(value, ctx.host.env.STUDIO_PROVISION_MIRROR_URL);

export async function fetchPinned(
  ctx: Ctx,
  id: ProvisionItemId,
  pinned: { url: string; sha256: string; maxBytes: number },
  name: string,
) {
  const file = join(ctx.paths.downloads, name);
  await ctx.host.remove(file);
  let reported = 0;
  await ctx.log(`${id}: downloading ${pinned.url}`);
  await ctx.host.download(url(ctx, pinned.url), file, {
    sha256: pinned.sha256,
    maxBytes: pinned.maxBytes,
    onProgress: (bytes) => {
      if (bytes - reported >= 16 * 1024 * 1024) {
        reported = bytes;
        ctx.emit({ type: "log", id, line: `Downloaded ${Math.round(bytes / 1048576)} MB` });
      }
    },
  });
  await ctx.log(`${id}: SHA-256 ${pinned.sha256} verified`);
  return file;
}

export async function must(
  ctx: Ctx,
  command: string,
  args: string[],
  what: string,
  env?: ExecOptions["env"],
) {
  const result = await ctx.host.exec(command, args, {
    timeoutMs: 10 * 60_000,
    ...(env === undefined ? {} : { env }),
  });
  if (result.code !== 0) throw new Error(`${what} failed: ${installFailureReason(result)}`);
  return result;
}

export async function placeLauncher(
  ctx: Ctx,
  name: string,
  managedRoot: string,
  link: string,
  target: string,
) {
  const owned = await ownsLauncher(ctx, link, managedRoot);
  if (owned === false)
    throw new Error(`${link} exists and was not installed by provisioning; it is left alone.`);
  await ctx.host.symlink(target, link);
  await ctx.log(`${name}: ${link} -> ${target}`);
}

export async function installNode(ctx: Ctx) {
  const pinned = nodeDownload(ctx.key);
  const archive = await fetchPinned(ctx, "node", pinned, `${pinned.stem}.tar.gz`);
  const root = join(ctx.paths.home, "runtime/node");
  const staging = join(root, `.staging-provision`);
  await ctx.host.remove(staging);
  await ctx.host.mkdirp(staging);
  await must(
    ctx,
    "tar",
    ["-xzf", archive, "-C", staging, "--strip-components=1"],
    "Unpacking Node.js",
  );
  const reported = await versionOf(ctx.host, join(staging, "bin/node"));
  if (reported !== NODE_VERSION)
    throw new Error("The downloaded Node.js does not run on this machine.");
  await ctx.host.remove(join(root, pinned.stem));
  await ctx.host.rename(staging, join(root, pinned.stem));
  await ctx.host.remove(archive);
}

export async function installGh(ctx: Ctx) {
  const pinned = ghDownload(ctx.key);
  const archive = await fetchPinned(ctx, "gh", pinned, pinned.file);
  const root = join(ctx.paths.home, "tools/gh");
  const staging = join(root, ".staging");
  await ctx.host.remove(staging);
  await ctx.host.mkdirp(staging);
  if (pinned.file.endsWith(".zip"))
    await must(ctx, "unzip", ["-q", archive, "-d", staging], "Unpacking gh");
  else await must(ctx, "tar", ["-xzf", archive, "-C", staging], "Unpacking gh");
  const inner = join(staging, pinned.file.replace(/\.(tar\.gz|zip)$/u, ""));
  if ((await versionOf(ctx.host, join(inner, "bin/gh"))) !== GH_VERSION)
    throw new Error("The downloaded gh does not report its pinned version.");
  const destination = join(root, GH_VERSION);
  await ctx.host.remove(destination);
  await ctx.host.rename(inner, destination);
  await ctx.host.remove(staging);
  await ctx.host.remove(archive);
  await placeLauncher(ctx, "gh", root, join(ctx.paths.binDir, "gh"), join(destination, "bin/gh"));
}

export async function installClaude(ctx: Ctx) {
  const pinned = claudeDownload(ctx.key);
  const file = await fetchPinned(ctx, "claude", pinned, `claude-${CLAUDE_VERSION}`);
  const versions = join(ctx.host.home, ".local/share/claude/versions");
  await ctx.host.mkdirp(versions);
  await ctx.host.chmod(file, 0o755);
  if ((await versionOf(ctx.host, file)) !== CLAUDE_VERSION)
    throw new Error("The downloaded Claude Code does not report its pinned version.");
  const destination = join(versions, CLAUDE_VERSION);
  await ctx.host.rename(file, destination);
  await placeLauncher(ctx, "claude", versions, join(ctx.paths.binDir, "claude"), destination);
}

/** The same managed layout CodexInstallation writes and reads (tools/codex/<version>, active.json). */
export async function installCodex(ctx: Ctx) {
  const pinned = codexDownload(ctx.key);
  const archive = await fetchPinned(ctx, "codex", pinned, `codex-${pinned.version}.tar.gz`);
  const listing = (await must(ctx, "tar", ["-tzf", archive], "Listing the Codex archive")).stdout
    .trim()
    .split("\n");
  if (listing.some((entry) => entry.startsWith("/") || entry.split("/").includes("..")))
    throw new Error("The Codex archive contains unsafe entries.");
  const managed = join(ctx.paths.home, "tools/codex");
  const destination = join(managed, pinned.version);
  const staging = join(managed, ".install-provision");
  await ctx.host.remove(staging);
  await ctx.host.mkdirp(staging);
  await must(ctx, "tar", ["-xzf", archive, "-C", staging], "Unpacking Codex");
  const manifest = JSON.parse(
    (await ctx.host.readText(join(staging, "codex-package.json"))) ?? "{}",
  ) as Record<string, unknown>;
  if (
    manifest.version !== pinned.version ||
    manifest.target !== pinned.target ||
    manifest.entrypoint !== "bin/codex"
  )
    throw new Error("The downloaded Codex package does not match the expected release.");
  const reported = await ctx.host.exec(join(staging, "bin/codex"), ["--version"], {
    timeoutMs: 60_000,
  });
  if (reported.stdout.trim() !== `codex-cli ${pinned.version}`)
    throw new Error("The downloaded Codex executable has the wrong version.");
  await ctx.host.writeText(
    join(staging, ".install-complete.json"),
    JSON.stringify({ version: pinned.version, target: pinned.target, sha256: pinned.sha256 }),
    0o600,
  );
  await ctx.host.remove(destination);
  await ctx.host.rename(staging, destination);
  await ctx.host.writeText(
    join(managed, "active.json"),
    JSON.stringify({ version: pinned.version }),
    0o600,
  );
  await ctx.host.remove(archive);
  // A small launcher rather than a link, so Codex finds its companion files from its real path.
  const link = join(ctx.paths.binDir, "codex");
  if ((await ownsLauncher(ctx, link, managed)) === false)
    throw new Error(`${link} exists and was not installed by provisioning; it is left alone.`);
  await ctx.host.writeText(
    link,
    `#!/bin/sh\n${OUR_LAUNCHER_MARKER}\nexec ${shellQuote(join(destination, "bin/codex"))} "$@"\n`,
    0o755,
  );
}

/**
 * The release's own entry, as install.sh uses it, rather than the `env -i` launcher. The server
 * fills in the user manager's variables itself (systemdUserBus.ts), so either works.
 */
async function serviceEntry(ctx: Ctx, probes: Probes): Promise<string> {
  const found = probes.server.found;
  if (found !== null) {
    const entry = join(ctx.paths.home, "runtime/versions", found, "specweave-studio");
    if (await ctx.host.isExecutable(entry)) return entry;
  }
  return join(ctx.paths.binDir, "specwithcode");
}

export async function applyServerItem(
  ctx: Ctx,
  id: "server" | "service" | "service-path" | "legacy-names",
  probes: Probes,
): Promise<ProvisionItem | null> {
  const { host, paths } = ctx;
  const launcher = join(paths.binDir, "specwithcode");
  if (id === "server") {
    await installServer(ctx);
    return null;
  }
  if (id === "service") {
    if (isLinux(ctx.target) && probes.service.installed)
      await must(
        ctx,
        "systemctl",
        ["--user", "start", SYSTEMD_UNIT],
        "Starting the service",
        await userManagerEnv(ctx.host),
      );
    else
      await must(
        ctx,
        await serviceEntry(ctx, probes),
        ["service", "install"],
        "Installing the service",
      );
    return null;
  }
  if (id === "legacy-names") {
    const legacy = join(paths.binDir, "specweave-studio");
    const text = await host.readText(launcher);
    if (text === null) throw new Error(`${launcher} is missing.`);
    if (!(await host.exists(legacy))) await host.writeText(legacy, text, 0o700);
    return null;
  }
  // service-path: a systemd drop-in that puts the missing folders first on the service PATH.
  const missingDirs = await Promise.all(
    probes.servicePath.missing.map(async (name) =>
      dirname((await host.which(name, probes.searchPath)) ?? ""),
    ),
  );
  const pathValue = [
    ...new Set([
      ...missingDirs.filter((dir) => dir.length > 1),
      ...probes.servicePath.effective.split(":"),
    ]),
  ].join(":");
  const dropIn = join(dirname(paths.unitPath), `${SYSTEMD_UNIT}.d`, PATH_DROP_IN);
  await host.writeText(
    dropIn,
    `# Written by specwithcode provision: the folders of the agent commands the service could not find.\n[Service]\nEnvironment="PATH=${pathValue}"\n`,
    0o644,
  );
  await must(
    ctx,
    "systemctl",
    ["--user", "daemon-reload"],
    "Reloading systemd",
    await userManagerEnv(ctx.host),
  );
  if (
    ctx.options.mode === "cli" &&
    ctx.options.restartService &&
    (await serviceIdle(ctx)) === true
  ) {
    await must(
      ctx,
      "systemctl",
      ["--user", "restart", SYSTEMD_UNIT],
      "Restarting the service",
      await userManagerEnv(ctx.host),
    );
    return null;
  }
  return {
    ...item(
      "service-path",
      "claude, codex, gh and git found",
      "drop-in written",
      "changed",
      `Wrote ${dropIn}; it applies when the service next restarts. Restart it when no threads run.`,
      "specwithcode service restart",
    ),
  };
}

/** Whether the service runs any threads, from its own report (`service prepare-update` without --stop-work or --hold). */
export async function serviceIdle(ctx: Ctx): Promise<boolean | null> {
  const launcher = join(ctx.paths.binDir, "specwithcode");
  const result = await ctx.host.exec(launcher, ["service", "prepare-update", "--json"], {
    timeoutMs: 60_000,
    env: { STUDIO_HOME: ctx.paths.home },
  });
  const idle = /"idle":\s*(true|false)/u.exec(result.stdout)?.[1];
  return idle === undefined ? null : idle === "true";
}

/** install.sh from this release, checked against the release's SHA256SUMS before it runs. */
export async function installServer(ctx: Ctx) {
  const { host, paths } = ctx;
  const base = (
    host.env.STUDIO_RELEASE_BASE_URL ??
    "https://github.com/anton-abyzov/specwithcode/releases/download"
  ).replace(/\/+$/u, "");
  if (!base.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(base))
    throw new Error("STUDIO_RELEASE_BASE_URL must be an https:// address.");
  const version = ctx.wantedServer;
  const sums = await host.fetchText(`${base}/v${version}/SHA256SUMS`);
  if (!sums.ok)
    throw new Error(
      `SpecWithCode ${version} has no SHA256SUMS at ${base}/v${version} (HTTP ${sums.status}).`,
    );
  const sha = /^([0-9a-f]{64}) [ *]install\.sh$/mu.exec(sums.text)?.[1];
  if (!sha) throw new Error(`SHA256SUMS for ${version} does not list install.sh.`);
  const script = join(paths.downloads, `install-${version}.sh`);
  await host.download(`${base}/v${version}/install.sh`, script, {
    sha256: sha,
    maxBytes: 1024 * 1024,
  });
  await ctx.log(`server: install.sh for ${version} verified (sha256 ${sha})`);
  const result = await host.exec("sh", [script, "--version", version], {
    timeoutMs: 30 * 60_000,
    env: { STUDIO_HOME: paths.home, STUDIO_INSTALL_BIN_DIR: paths.binDir },
    onLine: (line) => {
      ctx.emit({ type: "log", id: "server", line: line.slice(0, 1900) });
      void ctx.log(`install.sh: ${line}`);
    },
  });
  if (result.code !== 0)
    throw new Error(`install.sh ${version} failed: ${installFailureReason(result)}`);
}

/** The line that says why install.sh failed, not the tail of a stack trace. */
export function installFailureReason(result: { stdout: string; stderr: string }): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^at\s/u.test(line));
  const reason =
    lines.find((line) => /\b\w*Error\b.*\[[\w-]+\]/u.test(line)) ??
    lines.find((line) => /\bERROR\b|\bError:/u.test(line)) ??
    lines.at(-1) ??
    "no output";
  return reason.replace(/^\[[\d:.]+\]\s*/u, "").slice(0, 800);
}
