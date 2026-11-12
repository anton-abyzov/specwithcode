import type { DpopFailureReason } from "@specweave-studio/contracts";
import type {
  RelayEnvironmentStatusResponse,
  RelayProtectedError,
} from "@specweave-studio/contracts/relay";

export const DPOP_CLOCK_HINT =
  "Hint: Check that automatic date and time is enabled on both devices, then try again.";

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT =
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.";

export const DPOP_RETRY_HINT = "Hint: Try again. If the problem continues, copy the trace ID.";

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Relay rejected the cloud session token.";
        case "invalid_dpop":
          return dpopFailureMessage("Relay rejected the DPoP proof.", error.dpopFailureReason);
        case "not_authorized":
          return "Relay rejected the authenticated request.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `Relay rejected the environment link proof (${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "Relay has no active link for this environment. The environment server may not have re-established its link yet.";
      }
      return error.reason
        ? `Relay rejected the environment connection request (${error.reason}).`
        : "Relay rejected the environment connection request.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `Relay could not reach the environment endpoint (${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "Relay timed out while contacting the environment endpoint.";
    case "RelayEnvironmentLinkFailedError":
      return `Relay could not link the environment (${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).`;
    case "RelayEnvironmentLinkLimitExceededError":
      return error.reason === "service_capacity"
        ? "SpecWithCode Connect is at capacity and is not accepting new machines right now. Machines already linked keep working. Try again later."
        : `Relay refused the link: this account already has its maximum of ${error.maxTunnels} managed tunnels. Unlink an environment to free one up.`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "Relay rejected an expired agent activity publish proof.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `Relay rejected the agent activity publish proof (${error.reason}).`;
    case "RelayInternalError":
      return `Relay encountered an internal error (${error.reason}).`;
  }
}

/**
 * Why deregistering a machine did not finish, in words for the person who
 * pressed the button. Reads a failure by its shape, so the phone and the
 * desktop say the same thing. The caller reads the list again either way: the
 * account can lose the machine before a later step fails.
 */
export function deregisterFailureMessage(cause: unknown): string {
  const failure =
    typeof cause === "object" && cause !== null
      ? (cause as {
          readonly _tag?: unknown;
          readonly transportFailed?: unknown;
          readonly relayError?: RelayProtectedError | undefined;
        })
      : {};
  const tag = typeof failure._tag === "string" ? failure._tag : "";
  if (tag === "ManagedRelayRequestTimeoutError") {
    return "SpecWithCode Connect did not answer in time. Check this device's connection and try again.";
  }
  if (tag === "ManagedRelayRequestFailedError") {
    const relayError = failure.relayError;
    if (relayError?._tag === "RelayInternalError") {
      switch (relayError.reason) {
        case "upstream_unavailable":
          return "The machine was taken off your account, but SpecWithCode Connect could not finish cleaning up after it. Your other machines are not affected.";
        case "database_unavailable":
        case "persistence_failed":
          return "SpecWithCode Connect could not save the change. Try again in a minute.";
        case "internal_error":
          return "SpecWithCode Connect ran into a problem. Try again in a minute.";
      }
    }
    if (relayError?._tag === "RelayAuthInvalidError") {
      switch (relayError.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Your SpecWithCode Connect sign-in has run out. Sign out, sign in again, then try again.";
        case "invalid_dpop":
          return dpopFailureMessage(
            "SpecWithCode Connect did not accept this device's proof of identity.",
            relayError.dpopFailureReason,
          );
        case "not_authorized":
          return "This account may not deregister that machine. Sign in with the account that linked it.";
      }
    }
    if (failure.transportFailed === true) {
      return "This device could not reach SpecWithCode Connect. Check the connection and try again.";
    }
    return "SpecWithCode Connect sent an answer this app did not expect. Try again in a minute.";
  }
  if (tag.startsWith("ManagedRelay")) {
    return "This device could not sign the request. Sign out, sign in again, then try again.";
  }
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "Deregistering failed, and the reason is not known.";
}

// A host with a current build gets a new tunnel on its own within minutes of
// coming back, which clears this reason. While it is still reported, the host
// is either still off or running a build too old to do that.
export const RELAY_TUNNEL_RELEASED_MESSAGE =
  "Offline for a while, so its SpecWithCode Connect tunnel was removed. Start SpecWithCode on that computer and update it to the latest version to reconnect.";

/** User-facing text for an offline status, or null when the relay gave no known reason. */
export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return RELAY_TUNNEL_RELEASED_MESSAGE;
    case undefined:
      return null;
  }
}
