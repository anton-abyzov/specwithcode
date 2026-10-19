/**
 * The machine-to-add side of a fleet: publish this server on its own
 * Tailscale name and make the `swc-machine-…` line another machine's Add a
 * machine accepts. `specweave-studio fleet invite` and Settings > Connections
 * both end here, so the two never disagree about what the line holds.
 */
import { AuthAccessWriteScope, AuthStandardClientScopes } from "@specweave-studio/contracts";
import type {
  StudioFleetInviteProblem,
  StudioFleetInviteResult,
  StudioFleetTailscaleStatus,
} from "@specweave-studio/contracts/studioFleet";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import {
  openTailscaleApp,
  readTailscaleBackendStatus,
  startTailscaleLogin,
  type TailscaleCommandError,
} from "@specweave-studio/tailscale";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { encodeFleetJoinCode } from "./studioFleetJoin.ts";
import type { PersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { publishOnTailscale, type TailscalePublishError } from "./tailscalePublish.ts";

/** The label the owner sees in this machine's client list for the line's credential. */
export const FLEET_INVITE_SESSION_LABEL = "Fleet management (fleet invite)";

/**
 * What the line's token holds: pairing here can only hand out scopes the token
 * holds, so it carries every scope a connection from the primary may ask for,
 * plus access:write to mint those pairings.
 */
export const FLEET_INVITE_SCOPES = [...AuthStandardClientScopes, AuthAccessWriteScope] as const;

/** A year: the primary uses this token for every pairing on the machine, unattended. */
export const DEFAULT_FLEET_INVITE_TTL = Duration.days(365);

/** The name shown for this machine on the other one, at most 80 characters. */
export const fleetInviteLabel = (requested: string | undefined, own: string): string =>
  (requested?.trim() || own).trim().slice(0, 80).trim();

/**
 * Publishes this server on its Tailscale name, then issues the management
 * session the line carries. Publishing comes first so a failure leaves no
 * credential behind.
 */
export const issueFleetInvitation = Effect.fnUntraced(function* (input: {
  readonly environmentId: string;
  readonly ownLabel: string;
  readonly state: Pick<PersistedServerRuntimeState, "devUrl" | "host" | "port">;
  readonly servePort: number;
  readonly label?: string | undefined;
  readonly ttl?: Duration.Duration | undefined;
}) {
  const served = yield* publishOnTailscale({
    environmentId: input.environmentId,
    state: input.state,
    servePort: input.servePort,
  });
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* environmentAuth.issueSession({
    scopes: [...FLEET_INVITE_SCOPES],
    label: FLEET_INVITE_SESSION_LABEL,
    ttl: input.ttl ?? DEFAULT_FLEET_INVITE_TTL,
  });
  const url = new URL(served.baseUrl).origin;
  const label = fleetInviteLabel(input.label, input.ownLabel) || "Machine";
  const invitation: StudioFleetInviteResult = {
    code: encodeFleetJoinCode({
      url,
      environmentId: input.environmentId,
      label,
      managementToken: issued.token,
    }),
    url,
    label,
    expiresAt: DateTime.formatIso(issued.expiresAt),
    sessionId: issued.sessionId,
  };
  return { invitation, notes: served.notes };
});

/**
 * Plain words for a publish failure, saying what to do. The command-line
 * wording names flags; the app names its own settings instead.
 */
export function fleetInviteProblem(error: TailscalePublishError): {
  readonly reason: StudioFleetInviteProblem;
  readonly message: string;
} {
  switch (error._tag) {
    case "TailscaleUnavailableError": {
      const cause = error.cause as { readonly _tag?: unknown; readonly stderrDiagnostic?: unknown };
      if (cause?._tag === "TailscaleCommandSpawnError")
        return {
          reason: "tailscale_missing",
          message:
            "Tailscale is not installed on this machine. Install it from tailscale.com/download, open it and sign in, then try again.",
        };
      if (cause?.stderrDiagnostic === "not-logged-in")
        return {
          reason: "tailscale_signed_out",
          message:
            "Tailscale is not signed in on this machine. Open Tailscale, sign in to the same tailnet as your main machine, then try again.",
        };
      return {
        reason: "tailscale_unavailable",
        message:
          "Could not reach Tailscale on this machine. Open the Tailscale app and check that it is connected, then try again.",
      };
    }
    case "MagicDnsNameMissingError":
      return {
        reason: "magic_dns_missing",
        message:
          "This machine has no Tailscale name yet. Sign in to Tailscale and turn on MagicDNS in the Tailscale admin console under DNS, then try again.",
      };
    case "ServesOtherEnvironmentError":
      return {
        reason: "serves_other_server",
        message: `HTTPS port ${String(error.servePort)} on this machine's Tailscale name already shows a different SpecWithCode server, and the app will not replace it. Turn off Tailscale HTTPS for that server, or choose another port under Tailscale HTTPS in Settings > Connections, then try again.`,
      };
    case "ServePortOccupiedError":
      return {
        reason: "port_occupied",
        message: `HTTPS port ${String(error.servePort)} on this machine's Tailscale name is already used by another app, and the app will not replace it. Choose another port under Tailscale HTTPS in Settings > Connections, or run \`specwithcode fleet invite --tailscale-serve-port 8443\` in a terminal.`,
      };
    case "TailscaleServeFailedError":
      return {
        reason: "serve_failed",
        message: `Tailscale could not publish this machine on HTTPS port ${String(error.servePort)}. Check that HTTPS certificates are allowed in the Tailscale admin console under DNS > HTTPS Certificates, then try again.`,
      };
    case "DevServerNotProxiableError":
      return {
        reason: "dev_server_not_proxiable",
        message:
          "This development server runs over HTTPS, which Tailscale Serve cannot forward. Run it over plain HTTP to invite it.",
      };
  }
}

/** What `tailscale status --json` said, or why it said nothing. */
export type FleetTailscaleOutcome =
  /** No `tailscale` command and no Tailscale app could be started. */
  | { readonly _tag: "missing" }
  /** Installed, but the app or its daemon did not answer. */
  | { readonly _tag: "unavailable" }
  | {
      readonly _tag: "status";
      readonly backendState: string | null;
      readonly magicDnsName: string | null;
    };

/**
 * The three states the app shows: install Tailscale, sign in to it, or
 * invite. Anything short of `Running` (`NeedsLogin`, `NeedsMachineAuth`,
 * `Stopped`, `Starting`, a daemon that does not answer) needs a sign-in.
 */
export function fleetTailscaleState(
  outcome: FleetTailscaleOutcome,
): Pick<StudioFleetTailscaleStatus, "state" | "backendState" | "magicDns"> {
  switch (outcome._tag) {
    case "missing":
      return { state: "not_installed", backendState: null, magicDns: false };
    case "unavailable":
      return { state: "signed_out", backendState: null, magicDns: false };
    case "status":
      return {
        state: outcome.backendState === "Running" ? "running" : "signed_out",
        backendState: outcome.backendState,
        magicDns: outcome.magicDnsName !== null,
      };
  }
}

const readFleetTailscaleOutcome = readTailscaleBackendStatus.pipe(
  Effect.map((status): FleetTailscaleOutcome => ({
    _tag: "status",
    backendState: status.backendState,
    magicDnsName: status.magicDnsName,
  })),
  Effect.catch((error): Effect.Effect<FleetTailscaleOutcome> =>
    Effect.succeed(
      error._tag === "TailscaleCommandSpawnError" ? { _tag: "missing" } : { _tag: "unavailable" },
    ),
  ),
);

const HOMEBREW_EXECUTABLES = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

/** Tailscale's state here, for the app to show before it offers an invitation. */
export const readFleetTailscaleStatus = Effect.fnUntraced(function* () {
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const outcome = yield* readFleetTailscaleOutcome;
  const homebrew =
    platform === "darwin"
      ? yield* Effect.forEach(HOMEBREW_EXECUTABLES, (path) =>
          fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
        ).pipe(Effect.map((found) => found.some(Boolean)))
      : false;
  return {
    ...fleetTailscaleState(outcome),
    platform,
    homebrew,
  } satisfies StudioFleetTailscaleStatus;
});

/** Plain words for a sign-in that did not start, saying what to do instead. */
export function fleetTailscaleSignInProblem(error: TailscaleCommandError): {
  readonly reason: StudioFleetInviteProblem;
  readonly message: string;
} {
  if (error._tag === "TailscaleCommandSpawnError")
    return {
      reason: "tailscale_missing",
      message:
        "Tailscale is not installed on this machine. Install it from tailscale.com/download, open it and sign in, then try again.",
    };
  if (error._tag === "TailscaleCommandExitError" && error.stderrDiagnostic === "permission-denied")
    return {
      reason: "tailscale_needs_admin",
      message:
        "Tailscale needs an administrator to sign in on this machine. Open the Tailscale app and sign in there, or run `sudo tailscale up` in a terminal yourself.",
    };
  return {
    reason: "tailscale_sign_in_failed",
    message:
      "Tailscale did not start signing in. Open the Tailscale app, sign in there, then come back.",
  };
}

/**
 * Starts the Tailscale app (macOS) and `tailscale up`, returning the sign-in
 * page to open. Never uses sudo, installs nothing and passes no auth key. A
 * daemon the app has only just started gets one more try.
 */
export const startFleetTailscaleSignIn = Effect.fnUntraced(function* () {
  yield* openTailscaleApp;
  return yield* startTailscaleLogin().pipe(
    Effect.catchTags({
      TailscaleCommandExitError: (error) =>
        error.stderrDiagnostic === "permission-denied"
          ? Effect.fail(error)
          : Effect.sleep(Duration.seconds(2)).pipe(Effect.andThen(startTailscaleLogin())),
    }),
  );
});
