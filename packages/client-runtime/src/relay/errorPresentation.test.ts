import {
  RelayAuthInvalidError,
  RelayEnvironmentLinkLimitExceededError,
  RelayInternalError,
} from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  deregisterFailureMessage,
  relayProtectedErrorMessage,
} from "./errorPresentation.ts";

describe("relayProtectedErrorMessage", () => {
  it("presents clock skew as one possible cause when the relay omits the reason", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it("keeps the clock hint for a relay that confirms a time-window failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "time_window",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(DPOP_CLOCK_HINT);
  });

  it("does not blame the clock when the relay identifies another proof failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "key_mismatch",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`,
    );
  });

  it("preserves the existing message for other authentication failures", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe("Relay rejected the cloud session token.");
  });

  it.each([
    { reason: undefined, expected: "maximum of 3 managed tunnels" },
    { reason: "account_limit" as const, expected: "maximum of 3 managed tunnels" },
    { reason: "service_capacity" as const, expected: "at capacity" },
  ])("presents the $reason link limit", ({ reason, expected }) => {
    const error = new RelayEnvironmentLinkLimitExceededError({
      code: "environment_link_limit_exceeded",
      maxTunnels: 3,
      ...(reason === undefined ? {} : { reason }),
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(expected);
  });
});

describe("deregisterFailureMessage", () => {
  const failed = (parts: Record<string, unknown> = {}) => ({
    _tag: "ManagedRelayRequestFailedError",
    action: "unlink the environment",
    ...parts,
  });
  const internal = (reason: RelayInternalError["reason"]) =>
    failed({
      relayError: new RelayInternalError({ code: "internal_error", reason, traceId: "trace-1" }),
    });
  const auth = (reason: RelayAuthInvalidError["reason"], parts: Record<string, unknown> = {}) =>
    failed({
      relayError: new RelayAuthInvalidError({
        code: "auth_invalid",
        reason,
        traceId: "trace-1",
        ...parts,
      }),
    });

  it("says the machine left the account when only the cleanup failed", () => {
    const message = deregisterFailureMessage(internal("upstream_unavailable"));
    expect(message).toContain("taken off your account");
    expect(message).not.toContain("Try again");
  });

  it("asks to try again when the service could not save or broke", () => {
    expect(deregisterFailureMessage(internal("persistence_failed"))).toBe(
      "SpecWithCode Connect could not save the change. Try again in a minute.",
    );
    expect(deregisterFailureMessage(internal("database_unavailable"))).toBe(
      "SpecWithCode Connect could not save the change. Try again in a minute.",
    );
    expect(deregisterFailureMessage(internal("internal_error"))).toBe(
      "SpecWithCode Connect ran into a problem. Try again in a minute.",
    );
  });

  it("tells a run-out sign-in from a refused account and a refused proof", () => {
    expect(deregisterFailureMessage(auth("invalid_bearer"))).toContain("sign-in has run out");
    expect(deregisterFailureMessage(auth("missing_bearer"))).toContain("sign-in has run out");
    expect(deregisterFailureMessage(auth("not_authorized"))).toContain(
      "may not deregister that machine",
    );
    expect(
      deregisterFailureMessage(auth("invalid_dpop", { dpopFailureReason: "time_window" })),
    ).toBe(
      `SpecWithCode Connect did not accept this device's proof of identity. ${DPOP_CLOCK_HINT}`,
    );
  });

  it("names a connection problem, a slow answer and an answer it cannot read", () => {
    expect(deregisterFailureMessage(failed({ transportFailed: true }))).toBe(
      "This device could not reach SpecWithCode Connect. Check the connection and try again.",
    );
    expect(
      deregisterFailureMessage({ _tag: "ManagedRelayRequestTimeoutError", timeoutMs: 15_000 }),
    ).toContain("did not answer in time");
    expect(deregisterFailureMessage(failed())).toContain("did not expect");
  });

  it("covers a request this device could not sign, and anything else", () => {
    expect(deregisterFailureMessage({ _tag: "ManagedRelayDpopKeyLoadError" })).toContain(
      "could not sign the request",
    );
    expect(deregisterFailureMessage(new Error("Disk is full."))).toBe("Disk is full.");
    expect(deregisterFailureMessage(undefined)).toBe(
      "Deregistering failed, and the reason is not known.",
    );
  });
});
