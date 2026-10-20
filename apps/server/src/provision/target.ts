/**
 * Which machines `specwithcode provision` supports, checked before anything is
 * installed. Anything else is refused with the reason and the nearest
 * supported option. The list is what the provisioning tests ran on plus the
 * targets the spec commits to; docs/user/add-a-machine.md repeats it.
 */
import type { ProvisionTarget } from "@specweave-studio/contracts";

import type { ProvisionPlatformKey } from "./manifest.ts";

export interface TargetFacts {
  readonly platform: string;
  readonly arch: string;
  /** The text of /etc/os-release on Linux. */
  readonly osRelease: string | null;
  /** `sw_vers -productVersion` on macOS. */
  readonly macosVersion: string | null;
  readonly libc: "glibc" | "musl" | "darwin" | "unknown";
  readonly systemd: boolean;
  /** Set inside WSL, where a Linux distribution runs under Windows. */
  readonly wsl: boolean;
}

/** Linux distributions with an apt repository for Tailscale and glibc builds of every package. */
export const SUPPORTED_LINUX: ReadonlyArray<{
  readonly id: "ubuntu" | "debian";
  readonly version: string;
  readonly codename: string;
  readonly label: string;
}> = [
  { id: "ubuntu", version: "22.04", codename: "jammy", label: "Ubuntu 22.04 LTS" },
  { id: "ubuntu", version: "24.04", codename: "noble", label: "Ubuntu 24.04 LTS" },
  { id: "ubuntu", version: "26.04", codename: "resolute", label: "Ubuntu 26.04 LTS" },
  { id: "debian", version: "12", codename: "bookworm", label: "Debian 12" },
];
export const MIN_MACOS_MAJOR = 14;
export const SUPPORTED_SUMMARY =
  "Ubuntu 22.04, 24.04 or 26.04 LTS or Debian 12 (x64 or arm64, glibc, systemd), or macOS 14 or later on Apple silicon";
const NEAREST_LINUX = "Ubuntu 24.04 LTS on x64 or arm64";

export function parseOsRelease(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
  }
  return values;
}

export interface CheckedTarget extends ProvisionTarget {
  readonly key: ProvisionPlatformKey | null;
  /** For Tailscale's apt repository. */
  readonly distro: "ubuntu" | "debian" | null;
  readonly codename: string | null;
}

export function checkTarget(facts: TargetFacts): CheckedTarget {
  const arch = facts.arch;
  const base = {
    platform: facts.platform,
    arch,
    libc: facts.libc,
    distro: null,
    codename: null,
  } as const;
  const refuse = (
    fields: Pick<ProvisionTarget, "osId" | "osVersion" | "prettyName" | "init">,
    reason: string,
    nearest: string,
  ): CheckedTarget => ({
    ...base,
    ...fields,
    supported: false,
    reason,
    nearest,
    key: null,
  });

  if (facts.platform === "darwin") {
    const version = facts.macosVersion ?? "unknown";
    const fields = {
      osId: "macos",
      osVersion: version,
      prettyName: `macOS ${version}`,
      init: "launchd",
    } as const;
    if (arch !== "arm64")
      return refuse(
        fields,
        "SpecWithCode has no build for Intel Macs.",
        "a Mac with Apple silicon on macOS 14 or later",
      );
    const major = Number.parseInt(version.split(".")[0] ?? "", 10);
    if (!Number.isFinite(major) || major < MIN_MACOS_MAJOR)
      return refuse(
        fields,
        `macOS ${version} is older than macOS ${MIN_MACOS_MAJOR}.`,
        `update to macOS ${MIN_MACOS_MAJOR} or later`,
      );
    return {
      ...base,
      ...fields,
      supported: true,
      reason: null,
      nearest: null,
      key: "darwin-arm64",
    };
  }

  if (facts.platform !== "linux") {
    return refuse(
      { osId: facts.platform, osVersion: "unknown", prettyName: facts.platform, init: "none" },
      facts.platform === "win32"
        ? "Windows provisioning is not part of this command; it belongs to the Windows app."
        : `SpecWithCode publishes no build for ${facts.platform}.`,
      NEAREST_LINUX,
    );
  }

  const release = parseOsRelease(facts.osRelease ?? "");
  const osId = release.ID ?? "unknown";
  const osVersion = release.VERSION_ID ?? "unknown";
  const fields = {
    osId,
    osVersion,
    prettyName: release.PRETTY_NAME ?? `${osId} ${osVersion}`,
    init: facts.systemd ? "systemd" : "none",
  } as const;
  if (arch !== "x64" && arch !== "arm64")
    return refuse(
      fields,
      `The ${facts.arch} architecture has no SpecWithCode build.`,
      NEAREST_LINUX,
    );
  if (facts.libc === "musl")
    return refuse(
      fields,
      "This system uses musl (for example Alpine); SpecWithCode needs glibc.",
      NEAREST_LINUX,
    );
  if (!facts.systemd)
    return refuse(
      fields,
      facts.wsl
        ? "systemd is not running in this WSL distribution; the background service needs it."
        : "systemd is not running; the background service needs systemd user services.",
      facts.wsl
        ? "turn on systemd in /etc/wsl.conf ([boot] systemd=true), or Ubuntu 24.04 LTS"
        : NEAREST_LINUX,
    );
  const supported = SUPPORTED_LINUX.find(
    (entry) => entry.id === osId && entry.version === osVersion,
  );
  if (!supported) {
    return refuse(
      fields,
      `${fields.prettyName} is not a supported distribution (${SUPPORTED_SUMMARY}).`,
      osId === "debian" ? "Debian 12" : NEAREST_LINUX,
    );
  }
  return {
    ...base,
    ...fields,
    supported: true,
    reason: null,
    nearest: null,
    key: `linux-${arch}`,
    distro: supported.id,
    codename: supported.codename,
  };
}
