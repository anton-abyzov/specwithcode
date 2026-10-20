/**
 * The steps that need root, written as one short script the user can read and
 * run with one `sudo` line. It only installs from signed sources: the
 * distribution's apt repository, Tailscale's apt repository behind a key file
 * whose SHA-256 the script checks again, or Tailscale's macOS package after its
 * Developer ID is checked. No password ever passes through the app.
 */
import {
  TAILSCALE_KEYRING_PATH,
  TAILSCALE_KEYRING_SHA256,
  TAILSCALE_MAC_SIGNER,
  tailscaleAptLine,
} from "./manifest.ts";

export interface RootPlan {
  readonly platform: "linux" | "darwin";
  readonly user: string;
  readonly generatedAt: string;
  readonly aptPackages: ReadonlyArray<string>;
  /** Linux: the downloaded, checked key file; macOS: the downloaded package. */
  readonly tailscale: null | {
    readonly file: string;
    readonly distro?: "ubuntu" | "debian";
    readonly codename?: string;
  };
  readonly enableLinger: boolean;
}

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function rootPlanIsEmpty(plan: RootPlan): boolean {
  return plan.aptPackages.length === 0 && plan.tailscale === null && !plan.enableLinger;
}

export function renderRootScript(plan: RootPlan): string {
  const lines = [
    "#!/bin/sh",
    `# SpecWithCode provision: the steps that need root, written ${plan.generatedAt} for ${plan.user}.`,
    "# Read it before you run it. It installs only from signed sources and changes nothing else.",
    "set -eu",
  ];
  if (plan.platform === "linux") {
    const apt = "apt-get -o DPkg::Lock::Timeout=600 -y";
    const needsApt = plan.aptPackages.length > 0 || plan.tailscale !== null;
    if (needsApt) lines.push("export DEBIAN_FRONTEND=noninteractive");
    if (plan.tailscale && plan.tailscale.distro && plan.tailscale.codename) {
      lines.push(
        "# Tailscale's package repository; its key file must match the pinned SHA-256.",
        `printf '%s  %s\\n' ${TAILSCALE_KEYRING_SHA256} ${shellQuote(plan.tailscale.file)} | sha256sum -c -`,
        `install -m 0644 ${shellQuote(plan.tailscale.file)} ${TAILSCALE_KEYRING_PATH}`,
        `printf '%s\\n' ${shellQuote(tailscaleAptLine(plan.tailscale.distro, plan.tailscale.codename))} > /etc/apt/sources.list.d/tailscale.list`,
      );
    }
    if (needsApt) {
      const packages = [...plan.aptPackages, ...(plan.tailscale ? ["tailscale"] : [])];
      lines.push(`${apt} update`, `${apt} install --no-install-recommends ${packages.join(" ")}`);
    }
    if (plan.tailscale) lines.push("systemctl enable --now tailscaled");
    if (plan.enableLinger)
      lines.push(
        "# Keeps the SpecWithCode user service running after you log out.",
        `loginctl enable-linger ${shellQuote(plan.user)}`,
      );
  } else if (plan.tailscale) {
    lines.push(
      "# Tailscale's own package, accepted only with Tailscale's Developer ID.",
      `pkgutil --check-signature ${shellQuote(plan.tailscale.file)} | grep -q ${shellQuote(TAILSCALE_MAC_SIGNER)}`,
      `installer -pkg ${shellQuote(plan.tailscale.file)} -target /`,
    );
  }
  lines.push("echo 'SpecWithCode provision: root steps finished.'", "");
  return lines.join("\n");
}
