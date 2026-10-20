/**
 * The pinned package set `specwithcode provision` installs or verifies. It is
 * versioned with the release: each entry names one exact version and either a
 * SHA-256 per platform or a signed package repository with a pinned key.
 * Codex reuses the managed-install pins in CodexInstallation, so the app and
 * provisioning never disagree about the Codex build.
 *
 * Updating a pin: take the version from the vendor's release, its SHA-256 from
 * the vendor's own checksum list (gh_<v>_checksums.txt, Claude Code's
 * manifest.json, GitHub's asset digest), and change only this file.
 */
import { compareSemverVersions } from "@specweave-studio/shared/semver";

import { resolveCodexReleaseAsset } from "../provider/CodexInstallation.ts";

export type ProvisionPlatformKey = "linux-x64" | "linux-arm64" | "darwin-arm64";

export interface PinnedDownload {
  readonly url: string;
  readonly sha256: string;
  /** Upper bound for the download; a larger body is refused. */
  readonly maxBytes: number;
}

/** The same Node.js build and checksums as scripts/install.sh. */
export const NODE_VERSION = "22.20.0";
const NODE_SHA256: Record<ProvisionPlatformKey, string> = {
  "darwin-arm64": "cc04a76a09f79290194c0646f48fec40354d88969bec467789a5d55dd097f949",
  "linux-x64": "eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29",
  "linux-arm64": "4181609e03dcb9880e7e5bf956061ecc0503c77a480c6631d868cb1f65a2c7dd",
};
export const nodeDownload = (key: ProvisionPlatformKey): PinnedDownload & { stem: string } => {
  const [platform, arch] = key.split("-") as [string, string];
  const stem = `node-v${NODE_VERSION}-${platform}-${arch}`;
  return {
    stem,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${stem}.tar.gz`,
    sha256: NODE_SHA256[key],
    maxBytes: 80 * 1024 * 1024,
  };
};

export const GH_VERSION = "2.102.0";
const GH_ASSETS: Record<ProvisionPlatformKey, { file: string; sha256: string }> = {
  "linux-x64": {
    file: `gh_${GH_VERSION}_linux_amd64.tar.gz`,
    sha256: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
  },
  "linux-arm64": {
    file: `gh_${GH_VERSION}_linux_arm64.tar.gz`,
    sha256: "7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484",
  },
  "darwin-arm64": {
    file: `gh_${GH_VERSION}_macOS_arm64.zip`,
    sha256: "da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e",
  },
};
export const ghDownload = (key: ProvisionPlatformKey): PinnedDownload & { file: string } => {
  const asset = GH_ASSETS[key];
  return {
    file: asset.file,
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${asset.file}`,
    sha256: asset.sha256,
    maxBytes: 80 * 1024 * 1024,
  };
};

/** Claude Code's native build, the layout its own installer writes (~/.local/share/claude/versions). */
export const CLAUDE_VERSION = "2.1.304";
const CLAUDE_SHA256: Record<ProvisionPlatformKey, string> = {
  "darwin-arm64": "b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a",
  "linux-x64": "ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912",
  "linux-arm64": "c487117526509ab6d2ee6013e14f181faf68d6d6afe6bb0d4b2b4a9feca5ecb3",
};
export const claudeDownload = (key: ProvisionPlatformKey): PinnedDownload => ({
  url: `https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${key}/claude`,
  sha256: CLAUDE_SHA256[key],
  maxBytes: 400 * 1024 * 1024,
});

export const codexDownload = (key: ProvisionPlatformKey) => {
  const [platform, arch] = key.split("-") as [NodeJS.Platform, string];
  const asset = resolveCodexReleaseAsset(platform, arch);
  if (!asset) throw new Error(`No Codex release is pinned for ${key}.`);
  return { ...asset, maxBytes: asset.archiveBytes };
};

/**
 * Tailscale comes from its signed apt repository on Linux; the key file is the
 * same for every listed distribution (RSA 4096 2596A99EAAB33821893C0A79458CA832957F5868,
 * "Tailscale Inc. (Package repository signing key)").
 */
export const TAILSCALE_MIN_VERSION = "1.80.0";
export const TAILSCALE_KEYRING_SHA256 =
  "3e03dacf222698c60b8e2f990b809ca1b3e104de127767864284e6c228f1fb39";
export const TAILSCALE_KEYRING_PATH = "/usr/share/keyrings/tailscale-archive-keyring.gpg";
export const tailscaleKeyringUrl = (distro: "ubuntu" | "debian", codename: string) =>
  `https://pkgs.tailscale.com/stable/${distro}/${codename}.noarmor.gpg`;
export const tailscaleAptLine = (distro: "ubuntu" | "debian", codename: string) =>
  `deb [signed-by=${TAILSCALE_KEYRING_PATH}] https://pkgs.tailscale.com/stable/${distro} ${codename} main`;
/** macOS: Tailscale's own package, accepted only with Tailscale's Developer ID (as install.sh does). */
export const TAILSCALE_MAC_PKG_URL = "https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg";
export const TAILSCALE_MAC_SIGNER = "Developer ID Installer: Tailscale Inc. (W5364U7YZB)";

/** git comes from the distribution's signed repository (apt) or Apple's command line tools. */
export const GIT_MIN_VERSION = "2.34.0";

/** Returns <0, 0 or >0; unparsable versions compare as older than anything. */
export function compareVersions(left: string | null, right: string): number {
  if (left === null) return -1;
  const normalize = (value: string) => {
    const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(value);
    return match ? `${match[1]}.${match[2]}.${match[3] ?? "0"}` : null;
  };
  const a = normalize(left);
  const b = normalize(right);
  if (a === null) return -1;
  if (b === null) return 1;
  return compareSemverVersions(a, b);
}

/** The first dotted version in a command's output, e.g. "gh version 2.102.0 (2026-09-30)". */
export function parseVersion(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/u.exec(output)?.[1] ?? null;
}
