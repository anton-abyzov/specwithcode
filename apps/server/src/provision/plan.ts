/** Turns probes into the item list: what is fine, what changes, what is the user's step. */
import type {
  ProvisionItem,
  ProvisionItemId,
  ProvisionItemStatus,
} from "@specweave-studio/contracts";

import { ChecksumMismatchError } from "./host.ts";
import {
  CLAUDE_VERSION,
  codexDownload,
  compareVersions,
  GH_VERSION,
  GIT_MIN_VERSION,
  NODE_VERSION,
  TAILSCALE_MIN_VERSION,
} from "./manifest.ts";
import {
  type Ctx,
  PATH_DROP_IN,
  type Probe,
  type Probes,
  SYSTEMD_UNIT,
  isLinux,
} from "./context.ts";
import { probeAll } from "./probe.ts";

export const SOURCES: Record<ProvisionItemId, string> = {
  git: "the distribution's signed apt repository (Apple's command line tools on macOS)",
  gh: `github.com/cli/cli release v${GH_VERSION}, SHA-256 pinned`,
  "git-credentials":
    "git config --get-urlmatch credential.helper https://github.com; gh auth setup-git",
  node: `nodejs.org v${NODE_VERSION}, SHA-256 pinned (the build install.sh uses)`,
  claude: `downloads.claude.ai ${CLAUDE_VERSION}, SHA-256 pinned`,
  codex: "github.com/openai/codex release, SHA-256 and size pinned",
  tailscale:
    "Tailscale's signed package repository (pinned key file SHA-256); on macOS its Developer ID package",
  server: "this release's GitHub assets, checked against SHA256SUMS (never npm)",
  service: "specwithcode service install",
  "service-path": "the PATH the service's server reads at start",
  linger: "loginctl enable-linger",
  "legacy-names": "the specweave-studio command and service names",
};

export const LABELS: Record<ProvisionItemId, string> = {
  git: "git",
  gh: "GitHub CLI (gh)",
  "git-credentials": "git credentials for github.com",
  node: "Node.js 22",
  claude: "Claude Code",
  codex: "Codex",
  tailscale: "Tailscale (optional)",
  server: "SpecWithCode server",
  service: "Background service",
  "service-path": "Agent commands on the service PATH",
  linger: "Service keeps running after logout",
  "legacy-names": "Legacy specweave-studio names",
};

export function item(
  id: ProvisionItemId,
  wanted: string,
  found: string | null,
  status: ProvisionItemStatus,
  detail: string | null = null,
  command: string | null = null,
): ProvisionItem {
  return { id, label: LABELS[id], wanted, found, status, source: SOURCES[id], detail, command };
}

/** ok, kept-newer or planned for a pinned version; never planned when a newer one is there. */
export function versioned(
  id: ProvisionItemId,
  wanted: string,
  found: string | null,
  ours: boolean | null | undefined,
  detail?: string | null,
  path?: string | null,
): ProvisionItem {
  const order = compareVersions(found, wanted);
  if (found !== null && order === 0) return item(id, wanted, found, "ok", detail ?? null);
  if (found !== null && order > 0)
    return item(
      id,
      wanted,
      found,
      "kept-newer",
      detail ?? `A newer ${found} is installed; it is kept.`,
    );
  if (ours === false)
    return item(
      id,
      wanted,
      found,
      "user-action",
      path
        ? `${path} was not installed by provisioning; a second copy would only shadow it, so it is left alone.`
        : `The ${id} command was not installed by provisioning, so it is left alone.`,
      path && /\/(homebrew|Cellar|linuxbrew)\//u.test(path)
        ? `brew upgrade ${id}`
        : `Update ${id} to ${wanted} or later where it was installed${path ? ` (${path})` : ""}, or remove it and run specwithcode provision again.`,
    );
  return item(
    id,
    wanted,
    found,
    "planned",
    found ? `Upgrades ${found} to ${wanted}.` : `Installs ${wanted}.`,
  );
}

export const TAILSCALE_NOT_NEEDED =
  "Not needed: this machine is reached through SpecWithCode Connect. Install Tailscale only if you also want a direct tailnet route.";

/**
 * Tailscale is optional: an installed one is only checked, and a missing one
 * is installed only when nothing else reaches this machine (no managed
 * SpecWithCode Connect link) or --with-tailscale asks for it.
 */
export function tailscaleItem(ctx: Ctx, p: Probes): ProvisionItem {
  const linux = isLinux(ctx.target);
  const wanted = `>= ${TAILSCALE_MIN_VERSION}`;
  const found = p.tailscale.found;
  if (compareVersions(found, TAILSCALE_MIN_VERSION) >= 0)
    return item("tailscale", wanted, found, "ok", `State: ${p.tailscale.state ?? "unknown"}.`);
  if (found !== null)
    return item(
      "tailscale",
      wanted,
      found,
      "user-action",
      "An older Tailscale is installed; provisioning leaves it to its own updates.",
      linux
        ? "sudo apt-get install --only-upgrade tailscale"
        : "Update Tailscale from its menu or the App Store.",
    );
  // A command that answers with no readable version is still an install; never install over it.
  if (p.tailscale.path !== null)
    return item(
      "tailscale",
      wanted,
      null,
      "ok",
      `Installed at ${p.tailscale.path}; its version could not be read. State: ${p.tailscale.state ?? "unknown"}.`,
    );
  const choice = ctx.options.tailscale ?? "auto";
  if (choice === "skip")
    return item(
      "tailscale",
      wanted,
      null,
      "skipped",
      p.connect === "managed" ? TAILSCALE_NOT_NEEDED : "Skipped by request.",
    );
  if (choice === "auto" && p.connect === "managed")
    return item("tailscale", wanted, null, "skipped", TAILSCALE_NOT_NEEDED);
  return item(
    "tailscale",
    wanted,
    null,
    "planned",
    "Installs Tailscale (root step); signing in stays your step.",
  );
}

export const SETUP_GIT_COMMAND = "gh auth setup-git --hostname github.com";

/**
 * git needs a credential helper for https://github.com to clone a private repo;
 * a gh sign-in alone is not enough. When gh is signed in and none is set,
 * `gh auth setup-git` points git at gh. It is not a sign-in and copies no token:
 * signing in stays the user's step.
 */
export function gitCredentialsItem(p: Probes): ProvisionItem {
  const wanted = "a credential helper";
  const helper = p.credentialHelper;
  const gh = p.providers.find((entry) => entry.id === "gh");
  if (helper.status === "configured")
    return item(
      "git-credentials",
      wanted,
      helper.helper,
      "ok",
      helper.usesGh ? "git uses your gh sign-in for github.com." : null,
    );
  if (helper.status === "unknown")
    return item(
      "git-credentials",
      wanted,
      null,
      "skipped",
      p.git.path
        ? "git did not answer; checked again on the next run."
        : "Checked once git is installed.",
    );
  if (gh?.found && gh.signedIn)
    return item(
      "git-credentials",
      wanted,
      null,
      "planned",
      "gh is signed in but git has no credential helper for github.com, so git clone of private repos would fail. Runs gh auth setup-git.",
    );
  return item(
    "git-credentials",
    wanted,
    null,
    "user-action",
    gh?.found
      ? "gh is not signed in and git has no credential helper for github.com, so git clone of private repos will fail. Sign in to GitHub; provisioning then runs gh auth setup-git."
      : "git has no credential helper for github.com, so git clone of private repos will fail. Install and sign in to gh; provisioning then runs gh auth setup-git.",
  );
}

export function planItems(ctx: Ctx, p: Probes): ProvisionItem[] {
  const linux = isLinux(ctx.target);
  const items: ProvisionItem[] = [];
  const gitOk = compareVersions(p.git.found, GIT_MIN_VERSION) >= 0;
  items.push(
    gitOk
      ? item("git", `>= ${GIT_MIN_VERSION}`, p.git.found, "ok")
      : linux
        ? item(
            "git",
            `>= ${GIT_MIN_VERSION}`,
            p.git.found,
            "planned",
            "Installs git with apt (root step).",
          )
        : item(
            "git",
            `>= ${GIT_MIN_VERSION}`,
            p.git.found,
            "user-action",
            "git comes with Apple's command line tools.",
            "xcode-select --install",
          ),
  );
  items.push(tailscaleItem(ctx, p));
  items.push(
    p.node.found !== null &&
      compareVersions(p.node.found, NODE_VERSION) >= 0 &&
      p.node.found.startsWith("22.")
      ? item(
          "node",
          NODE_VERSION,
          p.node.found,
          p.node.found === NODE_VERSION ? "ok" : "kept-newer",
          `${p.node.detail ?? ""} Other Node.js installs (your shell's node) are left alone.`.trim(),
        )
      : item(
          "node",
          NODE_VERSION,
          p.node.found,
          "planned",
          `Installs a private Node.js ${NODE_VERSION} under the SpecWithCode home; your shell's node is left alone.`,
        ),
  );
  items.push(versioned("gh", GH_VERSION, p.gh.found, p.gh.ours, null, p.gh.path));
  items.push(gitCredentialsItem(p));
  items.push(
    versioned("claude", CLAUDE_VERSION, p.claude.found, p.claude.ours, null, p.claude.path),
  );
  items.push(
    versioned(
      "codex",
      codexDownload(ctx.key).version,
      p.codex.found,
      p.codex.ours,
      null,
      p.codex.path,
    ),
  );

  // The server: the release that ships this command, or --server-version; never a downgrade.
  const serverOrder = compareVersions(p.server.found, ctx.wantedServer);
  const manager = p.manager;
  if (manager) {
    const runs =
      manager.kind === "desktop"
        ? `The desktop app (${manager.label}) runs the server on this Mac.`
        : `The managed launch agent ${manager.label} runs the server on this Mac.`;
    const order = compareVersions(manager.version, ctx.wantedServer);
    items.push(
      manager.version !== null && order >= 0
        ? item("server", ctx.wantedServer, manager.version, order === 0 ? "ok" : "kept-newer", runs)
        : item(
            "server",
            ctx.wantedServer,
            manager.version,
            "user-action",
            `${runs} Provisioning never replaces it.`,
            "Update from SpecWithCode > Settings > About.",
          ),
    );
    items.push(item("service", ctx.wantedServer, manager.version, "ok", runs));
  } else if (p.server.found !== null && serverOrder >= 0)
    items.push(
      item("server", ctx.wantedServer, p.server.found, serverOrder === 0 ? "ok" : "kept-newer"),
    );
  else if (ctx.options.mode === "remote")
    items.push(
      item(
        "server",
        ctx.wantedServer,
        p.server.found,
        "user-action",
        "Remote provisioning never replaces the running server.",
        "specwithcode update",
      ),
    );
  else if (p.server.found !== null && (p.service.active || p.service.managerError !== undefined))
    items.push(
      item(
        "server",
        ctx.wantedServer,
        p.server.found,
        "user-action",
        "The running service is older; update it from the app so running threads are not interrupted.",
        "specwithcode update",
      ),
    );
  else
    items.push(
      item(
        "server",
        ctx.wantedServer,
        p.server.found,
        "planned",
        `Installs SpecWithCode ${ctx.wantedServer} with this release's install.sh.`,
      ),
    );

  if (manager) {
    // Added above with the server.
  } else if (p.service.managerError !== undefined)
    items.push(
      item(
        "service",
        ctx.wantedServer,
        p.service.version,
        "failed",
        `Cannot reach the systemd user manager (${p.service.managerError}), so whether ${SYSTEMD_UNIT} runs is unknown. Nothing was started. Run this as the service user in a login session, or set XDG_RUNTIME_DIR=/run/user/$(id -u).`,
        "systemctl --user status",
      ),
    );
  else if (p.service.installed && p.service.active)
    items.push(
      item("service", ctx.wantedServer, p.service.version, "ok", `${p.service.unit} is running.`),
    );
  else if (ctx.options.mode === "remote")
    items.push(
      item(
        "service",
        ctx.wantedServer,
        p.service.version,
        "user-action",
        "This server runs without its background service.",
        "specwithcode service install",
      ),
    );
  else
    items.push(
      item(
        "service",
        ctx.wantedServer,
        p.service.version,
        "planned",
        p.service.installed
          ? "Starts the installed service."
          : "Installs and starts the background service.",
      ),
    );

  const notInstalled = (["claude", "codex", "gh", "git"] as const).filter((name) => !p[name].path);
  if (p.servicePath.missing.length === 0 && notInstalled.length > 0)
    items.push(
      item(
        "service-path",
        "claude, codex, gh and git found",
        `not installed yet: ${notInstalled.join(", ")}`,
        "ok",
        "Checked again after they are installed.",
      ),
    );
  else if (p.servicePath.missing.length === 0)
    items.push(
      item(
        "service-path",
        "claude, codex, gh and git found",
        "all found",
        "ok",
        p.servicePath.shellUnread
          ? "Found on this shell's PATH; your login shell did not answer within 5 seconds, so the server may fall back to the service PATH."
          : "Found through the login-shell PATH the server reads at start.",
      ),
    );
  else if (!linux)
    items.push(
      item(
        "service-path",
        "claude, codex, gh and git found",
        `missing: ${p.servicePath.missing.join(", ")}`,
        "user-action",
        manager
          ? "The server reads your login shell's PATH at start; add their folders there."
          : "The launch agent's PATH is written when the service is installed.",
        manager ? "Add the missing folders to PATH in ~/.zprofile" : "specwithcode service install",
      ),
    );
  else
    items.push(
      item(
        "service-path",
        "claude, codex, gh and git found",
        `missing: ${p.servicePath.missing.join(", ")}`,
        "planned",
        `Adds their folders to the service PATH (systemd drop-in ${PATH_DROP_IN}).`,
      ),
    );

  if (linux)
    items.push(
      p.linger
        ? item("linger", "on", "on", "ok")
        : item(
            "linger",
            "on",
            "off",
            "planned",
            "Turns on lingering so the service survives logout (root step).",
          ),
    );
  const legacy = p.server.launchers;
  if (manager && !legacy.specwithcode && !legacy["specweave-studio"])
    items.push(
      item(
        "legacy-names",
        "both commands",
        null,
        "ok",
        "The desktop app puts no command on PATH; its service name is unchanged.",
      ),
    );
  else
    items.push(
      legacy.specwithcode &&
        legacy["specweave-studio"] &&
        legacy.specwithcode === legacy["specweave-studio"]
        ? item(
            "legacy-names",
            "both commands",
            "both run",
            "ok",
            `specwithcode and specweave-studio both report ${legacy.specwithcode}; the service unit keeps its name.`,
          )
        : legacy.specwithcode && !legacy["specweave-studio"]
          ? item(
              "legacy-names",
              "both commands",
              "specweave-studio missing",
              "planned",
              "Adds the specweave-studio command beside specwithcode.",
            )
          : item(
              "legacy-names",
              "both commands",
              Object.entries(legacy)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(", ") || null,
              p.server.found === null ? "planned" : "ok",
            ),
    );
  return items;
}

export function verifyItem(
  before: ProvisionItem,
  after: Probe & { found: string | null },
  failure: string,
): ProvisionItem {
  const want = before.wanted.replace(/^>=\s*/u, "");
  const ok =
    before.id === "service-path" ||
    before.id === "legacy-names" ||
    before.id === "linger" ||
    before.id === "service" ||
    before.id === "git-credentials"
      ? after.found !== null
      : compareVersions(after.found, want) >= 0;
  return ok
    ? {
        ...before,
        found: after.found,
        status: "changed",
        detail: after.detail ?? before.detail,
        command: null,
      }
    : { ...before, found: after.found, status: "failed", detail: after.detail ?? failure };
}

export function failItem(before: ProvisionItem, error: unknown): ProvisionItem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...before,
    status: "failed",
    detail: error instanceof ChecksumMismatchError ? message : message.slice(0, 1900),
    command: "specwithcode provision --resume",
  };
}

export async function reprobe(ctx: Ctx, id: ProvisionItemId, probes: Probes): Promise<Probe> {
  const fresh = await probeAll(ctx);
  Object.assign(probes, fresh);
  switch (id) {
    case "service":
      return {
        found: fresh.service.active ? (fresh.service.version ?? "running") : null,
        path: fresh.service.unit,
        detail: fresh.service.active
          ? `${fresh.service.unit} is running.`
          : fresh.service.managerError !== undefined
            ? `Cannot reach the systemd user manager: ${fresh.service.managerError}`
            : "The service is not running.",
      };
    case "service-path":
      return {
        found: fresh.servicePath.missing.length === 0 ? "all found" : null,
        path: null,
        detail:
          fresh.servicePath.missing.length === 0
            ? "The PATH change takes effect when the service next restarts."
            : `Still missing: ${fresh.servicePath.missing.join(", ")}.`,
      };
    case "linger":
      return { found: fresh.linger ? "on" : null, path: null };
    case "legacy-names":
      return { found: fresh.server.launchers["specweave-studio"] ? "both run" : null, path: null };
    case "server":
      return fresh.server;
    case "git-credentials":
      return {
        found: fresh.credentialHelper.helper,
        path: null,
        detail:
          fresh.credentialHelper.status === "configured"
            ? "git clone of private github.com repos now uses your gh sign-in."
            : "git still has no credential helper for github.com.",
      };
    default:
      return fresh[id as "git" | "gh" | "node" | "claude" | "codex" | "tailscale"];
  }
}
