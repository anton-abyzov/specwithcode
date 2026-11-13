import type { ServerSelfUpdateCapability } from "@specweave-studio/contracts";

/** One server that runs an older SpecWithCode than this app, as its update row describes it. */
export interface ServerUpdateWordingInput {
  /** The machine's name, or null when it has none: it is then "the server". */
  readonly machine: string | null;
  readonly serverVersion: string;
  readonly clientVersion: string;
  /** What Update installs there; this app's version unless a newer release is out. */
  readonly targetVersion?: string;
  readonly selfUpdate: ServerSelfUpdateCapability;
  /** The server can continue running threads after its update restart. */
  readonly threadContinuation: boolean;
  /** That server's "Continue threads after restarts" setting. */
  readonly continueThreadsAfterServerUpdate: boolean;
}

/**
 * The idle row: the machine's name on one line, then its version and the
 * version Update installs ("1.0.20 → 1.0.25"). Screen readers hear `label`,
 * which says "to" where the row shows the arrow.
 */
export function serverUpdateRowText(
  input: Pick<
    ServerUpdateWordingInput,
    "machine" | "serverVersion" | "clientVersion" | "targetVersion"
  >,
): {
  readonly name: string;
  readonly serverVersion: string;
  readonly clientVersion: string;
  readonly label: string;
} {
  const name = input.machine ?? "Server";
  const target = input.targetVersion ?? input.clientVersion;
  return {
    name,
    serverVersion: input.serverVersion,
    clientVersion: target,
    label: `${name} ${input.serverVersion} to ${target}`,
  };
}

/**
 * What Update changes on that machine, in full sentences. A boot-service or
 * respawn server downloads exactly this app's release and its launcher
 * restarts it; a desktop-managed server updates the desktop app there from the
 * app's own update feed, so the version is whatever that feed offers.
 */
export function describeServerUpdate(input: ServerUpdateWordingInput): string {
  const where = input.machine ?? "the server";
  // The threads sentence names the step the sentence before it describes.
  const pause = input.selfUpdate === "desktop-managed" ? "relaunch" : "restart";
  const target = input.targetVersion ?? input.clientVersion;
  return [
    target === input.clientVersion
      ? `SpecWithCode on ${where} runs ${input.serverVersion}; this app runs ${input.clientVersion}.`
      : `SpecWithCode on ${where} runs ${input.serverVersion}; the newest release is ${target}.`,
    input.selfUpdate === "desktop-managed"
      ? `Update installs the newest SpecWithCode release on ${where} and relaunches the app there.`
      : input.machine === null
        ? `Update installs ${target} on the server and restarts it.`
        : `Update installs ${target} on ${where} and restarts its server.`,
    input.threadContinuation && input.continueThreadsAfterServerUpdate
      ? `Threads running there continue after the ${pause}.`
      : `Threads running there stop for the ${pause}.`,
    `Nothing else on ${where} changes: no settings, no other software.`,
  ].join(" ");
}
