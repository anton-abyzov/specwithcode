import type { DesktopAppSwapGate, StudioServiceUpdateState } from "@specweave-studio/contracts";
import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";
import * as Schema from "effect/Schema";

/**
 * When the app may swap itself for a downloaded release.
 *
 * The app and the local service update through two installers: Squirrel.Mac
 * swaps the app bundle, the update agent replaces the service. On M4,
 * 2026-10-20, the app downloaded 1.0.64 at 7:40 PM EDT and Squirrel staged it
 * for install-on-quit; the app quit and came back on 1.0.64 at 10:15 PM, while
 * the agent refused every run because the service used a deleted database log.
 * The app then ran 1.0.64 against a 1.0.62 service.
 *
 * The rule: the service activates first. A downloaded app release is staged
 * for install-on-quit, or installed by a restart, only once the local service
 * runs that release or a newer one. The app keeps running and connecting to
 * the older service meanwhile (basic use continues across skew); only the app
 * swap waits. A machine without a managed local service, or a build that does
 * not report one, has nothing to wait for, and neither do dev or nightly builds.
 *
 * One escape hatch (0988): a service that needs a manual step
 * (`manual-required`) will not catch up on its own, so the app stops waiting
 * for it rather than stay on the old release with nothing to press.
 *
 * Another: a press that installs the app alone because the service's agent
 * lacks the release (its request failed for want of it) opens the gate, as
 * long as the agent's state agrees it has no such release and nothing is
 * pending. Otherwise the app could not update at all until the agent's feed
 * caught up, with install-on-quit off too.
 */
export interface LocalServiceSnapshot {
  /** The agent's state, or null when this build cannot read one. */
  readonly state:
    | (Pick<StudioServiceUpdateState, "status" | "installedVersion" | "message"> &
        Partial<
          Pick<
            StudioServiceUpdateState,
            "availableVersion" | "downloadedVersion" | "pendingInstall"
          >
        >)
    | null;
  /** Version the attached, installed service reported when the app attached to it. */
  readonly runningVersion: string | null;
}

/** The local service is managed here, but its version could not be read. */
export class LocalServiceProbeError extends Schema.TaggedError<LocalServiceProbeError>()(
  "LocalServiceProbeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const isProbeError = Schema.is(LocalServiceProbeError);

export function sameActivation(
  left: DesktopAppSwapGate | undefined,
  right: DesktopAppSwapGate,
): boolean {
  return (
    left !== undefined &&
    left.gate === right.gate &&
    left.reason === right.reason &&
    left.targetVersion === right.targetVersion &&
    left.serviceVersion === right.serviceVersion &&
    left.serviceStatus === right.serviceStatus &&
    left.serviceMessage === right.serviceMessage
  );
}

function isRelease(version: string | null | undefined): version is string {
  const parsed = version ? parseSemver(version) : null;
  return parsed !== null && parsed.prerelease.length === 0;
}

/** The newer of two service versions; a value that is not a release counts as unknown. */
export function newestServiceVersion(
  ...versions: ReadonlyArray<string | null | undefined>
): string | null {
  let newest: string | null = null;
  for (const version of versions) {
    if (!isRelease(version)) continue;
    if (newest === null || compareSemverVersions(newest, version) < 0) newest = version;
  }
  return newest;
}

// The agent has the release, is fetching or installing it, or is about to look.
const AGENT_BUSY: ReadonlySet<StudioServiceUpdateState["status"]> = new Set([
  "starting",
  "available",
  "downloading",
  "downloaded",
  "waiting-for-quiet",
  "installing",
]);

/** The agent's state shows it has no release at or above `targetVersion`, and nothing pending. */
function agentLacksRelease(
  state: NonNullable<LocalServiceSnapshot["state"]>,
  targetVersion: string,
): boolean {
  if (AGENT_BUSY.has(state.status)) return false;
  if ((state.pendingInstall ?? null) !== null) return false;
  const offered = newestServiceVersion(state.availableVersion, state.downloadedVersion);
  return offered === null || compareSemverVersions(offered, targetVersion) < 0;
}

/**
 * `snapshot` is null when no probe is registered (no local service support in
 * this build), and a LocalServiceProbeError when the probe could not read the service.
 */
export function evaluateAppActivation(input: {
  readonly targetVersion: string | null;
  readonly snapshot: LocalServiceSnapshot | LocalServiceProbeError | null;
  /** A press installs the app alone: the renderer saw the agent fail for want of the release. */
  readonly serviceLacksRelease?: boolean;
}): DesktopAppSwapGate {
  const { targetVersion, snapshot } = input;
  const open = (
    reason: DesktopAppSwapGate["reason"],
    serviceVersion: string | null = null,
  ): DesktopAppSwapGate => ({
    gate: "open",
    reason,
    targetVersion,
    serviceVersion,
    serviceStatus: null,
    serviceMessage: null,
  });
  if (snapshot === null) return open("no-local-service");
  if (isProbeError(snapshot)) {
    return {
      gate: "closed",
      reason: "service-unknown",
      targetVersion,
      serviceVersion: null,
      serviceStatus: null,
      serviceMessage: snapshot.message,
    };
  }
  if (snapshot.state === null || snapshot.state.status === "not-managed") {
    return open("no-local-service");
  }
  const serviceVersion = newestServiceVersion(
    snapshot.runningVersion,
    snapshot.state.installedVersion,
  );
  if (!isRelease(targetVersion)) return open("not-a-release", serviceVersion);
  const status = snapshot.state.status;
  const message = snapshot.state.message ?? null;
  if (serviceVersion === null) {
    return {
      gate: "closed",
      reason: "service-unknown",
      targetVersion,
      serviceVersion: null,
      serviceStatus: status,
      serviceMessage: message,
    };
  }
  if (compareSemverVersions(serviceVersion, targetVersion) >= 0) {
    return { ...open("service-current", serviceVersion), serviceStatus: status };
  }
  if (status === "manual-required") {
    return {
      ...open("service-manual", serviceVersion),
      serviceStatus: status,
      serviceMessage: message,
    };
  }
  if (input.serviceLacksRelease === true && agentLacksRelease(snapshot.state, targetVersion)) {
    return {
      ...open("service-lacks-release", serviceVersion),
      serviceStatus: status,
      serviceMessage: message,
    };
  }
  return {
    gate: "closed",
    reason: "service-behind",
    targetVersion,
    serviceVersion,
    serviceStatus: status,
    serviceMessage: message,
  };
}

/**
 * Squirrel.Mac stages a download for install-on-quit only when
 * autoInstallOnAppQuit is set at the moment the download finishes
 * (electron-updater MacUpdater.updateDownloaded), and a staged update installs
 * on any quit. So the flag follows the gate for the version being fetched.
 */
export function installOnQuitAllowed(
  preference: boolean,
  activation: Pick<DesktopAppSwapGate, "gate">,
): boolean {
  return preference && activation.gate === "open";
}

function withPeriod(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** One line for logs and the update state's message. */
export function describeAppActivation(activation: DesktopAppSwapGate): string | null {
  if (activation.gate === "open") return null;
  const target = activation.targetVersion ?? "the update";
  if (activation.reason === "service-unknown") {
    return `SpecWithCode ${target} waits to install: the version of the SpecWithCode service on this Mac could not be read${
      activation.serviceMessage ? ` (${activation.serviceMessage})` : ""
    }.`;
  }
  const blocked =
    activation.serviceStatus === "error" || activation.serviceStatus === "manual-required";
  return `SpecWithCode ${target} installs after the SpecWithCode service on this Mac, which runs ${
    activation.serviceVersion
  }${blocked && activation.serviceMessage ? ` and cannot update yet: ${withPeriod(activation.serviceMessage)}` : "."}`;
}
