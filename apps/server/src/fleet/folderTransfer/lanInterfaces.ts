// @effect-diagnostics nodeBuiltinImport:off - reads this machine's interfaces and routes; changes nothing.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { admitLanHost, insidePrefix } from "./lanWire.ts";

/**
 * Which of this machine's addresses may carry a folder copy on the local
 * network (1334 S-7, AC-12, AC-31). An address counts only when it is an
 * admitted private literal on an interface that is up, not loopback, and
 * physical by what the operating system says, never by its name alone.
 *
 * Every question that cannot be answered (a command that fails, an interface
 * type that cannot be read, two interfaces claiming one prefix) is answered
 * "no": there is then no local-network path and the copy runs on Connect.
 * Nothing here adds a firewall rule, maps a port or asks for elevation.
 */
export interface LanInterface {
  readonly name: string;
  readonly address: string;
  readonly prefix: number;
}

export interface LanPolicy {
  /** Whether a literal may be offered, bound or dialled. */
  readonly admit: (host: string) => boolean;
  /** This machine's eligible addresses, each on a physical interface. */
  readonly eligible: () => Promise<ReadonlyArray<LanInterface>>;
  /** The interface the routing table sends `host` out of, or null when unknown. */
  readonly routeInterface: (host: string) => Promise<string | null>;
  /** A cheap fingerprint of the address picture; a change ends live generations. */
  readonly signature: () => string;
}

/** Names that are never physical, whatever else the system says. */
const NEVER =
  /^(lo|utun|tun|tap|wg|bridge|br-|docker|veth|vmnet|vmenet|awdl|llw|anpi|ap\d|gif|stf|virbr|vboxnet|zt|tailscale|ppp|ipsec|vEthernet)/i;

const run = (command: string, args: ReadonlyArray<string>): Promise<string | null> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout: 3_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });

/** Interface names the operating system reports as Ethernet or Wi-Fi hardware; null when unreadable. */
async function physicalNames(platform: NodeJS.Platform): Promise<ReadonlySet<string> | null> {
  if (platform === "darwin") {
    const out = await run("/usr/sbin/networksetup", ["-listallhardwareports"]);
    if (out === null) return null;
    const names = new Set<string>();
    let port = "";
    for (const line of out.split("\n")) {
      const hardware = /^Hardware Port:\s*(.+)$/.exec(line.trim());
      if (hardware) port = hardware[1]!;
      const device = /^Device:\s*(\S+)$/.exec(line.trim());
      if (device && /ethernet|wi-fi|lan|thunderbolt \d|usb/i.test(port) && !/bridge/i.test(port))
        names.add(device[1]!);
    }
    return names;
  }
  if (platform === "linux") {
    const names = new Set<string>();
    for (const name of Object.keys(NodeOS.networkInterfaces())) {
      // A real device sits behind the interface; virtual ones have no `device` link.
      const real = await NodeFSP.stat(NodePath.join("/sys/class/net", name, "device")).then(
        () => true,
        () => false,
      );
      if (real) names.add(name);
    }
    return names;
  }
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      // IfType 6 is Ethernet and 71 is Wi-Fi; HardwareInterface excludes virtual adapters.
      "Get-NetAdapter -Physical | Where-Object { $_.HardwareInterface -and ($_.InterfaceType -eq 6 -or $_.InterfaceType -eq 71) -and $_.Status -eq 'Up' } | ForEach-Object { $_.Name }",
    ]);
    if (out === null) return null;
    return new Set(
      out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return null;
}

const prefixOf = (cidr: string | null): number | null => {
  const value = Number(cidr?.split("/")[1]);
  return Number.isInteger(value) ? value : null;
};

async function routeOf(platform: NodeJS.Platform, host: string): Promise<string | null> {
  if (!admitLanHost(host)) return null;
  const v6 = host.includes(":");
  if (platform === "darwin") {
    const out = await run("/sbin/route", ["-n", "get", ...(v6 ? ["-inet6"] : []), host]);
    // A route through a gateway is not directly attached.
    if (out === null || /^\s*gateway:/m.test(out)) return null;
    return /^\s*interface:\s*(\S+)/m.exec(out)?.[1] ?? null;
  }
  if (platform === "linux") {
    const out = await run("ip", [v6 ? "-6" : "-4", "route", "get", host]);
    if (out === null || /\svia\s/.test(out)) return null;
    return /\sdev\s+(\S+)/.exec(out)?.[1] ?? null;
  }
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$r = Find-NetRoute -RemoteIPAddress '${host}' | Select-Object -Last 1; if ($r.NextHop -eq '0.0.0.0' -or $r.NextHop -eq '::') { $r.InterfaceAlias }`,
    ]);
    const name = out?.trim();
    return name ? name : null;
  }
  return null;
}

export function systemLanSignature(): string {
  const parts: Array<string> = [];
  for (const [name, entries] of Object.entries(NodeOS.networkInterfaces()))
    for (const entry of entries ?? [])
      if (!entry.internal && admitLanHost(entry.address)) parts.push(`${name}|${entry.cidr}`);
  return parts.sort().join(",");
}

/** The policy the app runs with. Tests build their own; there is no environment switch. */
export function systemLanPolicy(platform: NodeJS.Platform = process.platform): LanPolicy {
  return {
    admit: admitLanHost,
    signature: systemLanSignature,
    routeInterface: (host) => routeOf(platform, host),
    eligible: async () => {
      const physical = await physicalNames(platform);
      if (physical === null) return [];
      const found: Array<LanInterface> = [];
      for (const [name, entries] of Object.entries(NodeOS.networkInterfaces())) {
        if (NEVER.test(name) || !physical.has(name)) continue;
        for (const entry of entries ?? []) {
          const prefix = prefixOf(entry.cidr);
          if (entry.internal || prefix === null || !admitLanHost(entry.address)) continue;
          found.push({ name, address: entry.address, prefix });
        }
      }
      // Two interfaces claiming one prefix: the picture is ambiguous, so neither is used.
      return found.filter(
        (one) =>
          !found.some(
            (other) =>
              other !== one &&
              other.name !== one.name &&
              insidePrefix(one.address, Math.min(one.prefix, other.prefix), other.address),
          ),
      );
    },
  };
}

/**
 * The eligible interface a peer's address is directly attached to: inside that
 * interface's own on-link prefix, and routed out of that same interface. A
 * private address reached through a tunnel or a default route is not local.
 */
export async function directlyAttached(
  policy: LanPolicy,
  host: string,
): Promise<LanInterface | null> {
  if (!policy.admit(host)) return null;
  const matches = (await policy.eligible()).filter((entry) =>
    insidePrefix(entry.address, entry.prefix, host),
  );
  if (matches.length !== 1) return null;
  const route = await policy.routeInterface(host);
  return route !== null && route === matches[0]!.name ? matches[0]! : null;
}
