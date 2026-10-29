import {
  RelayAuthInvalidError,
  RelayEnvironmentLinkLimitExceededError,
} from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
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
