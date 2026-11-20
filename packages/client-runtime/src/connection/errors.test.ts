import {
  EnvironmentAuthInvalidError,
  EnvironmentRateLimitedError,
} from "@specweave-studio/contracts";
import {
  RelayAuthInvalidError,
  RelayEnvironmentEndpointTimedOutError,
} from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  mapManagedRelayError,
  mapRemoteDpopEnvironmentError,
  mapRemoteEnvironmentError,
} from "./errors.ts";
import { DPOP_RETRY_HINT, DPOP_UNKNOWN_HINT } from "../relay/errorPresentation.ts";
import {
  ManagedRelayDpopKeyLoadError,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestProofCreationError,
  ManagedRelayRequestTimeoutError,
  ManagedRelayTokenProofCreationError,
} from "../relay/managedRelay.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

describe("mapManagedRelayError", () => {
  it("marks only the refusals a new sign-in fixes (1417, AC-13)", () => {
    const refusal = (
      reason:
        | "missing_bearer"
        | "invalid_bearer"
        | "invalid_dpop"
        | "not_authorized"
        | "device_removed",
    ) => {
      const relayError = new RelayAuthInvalidError({
        code: "auth_invalid",
        reason,
        traceId: "trace-auth",
      });
      return mapManagedRelayError(
        new ManagedRelayRequestFailedError({
          action: "connect relay environment",
          cause: relayError,
          relayError,
        }),
      );
    };
    for (const reason of ["missing_bearer", "invalid_bearer", "device_removed"] as const)
      expect(refusal(reason), reason).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        connectSessionRefused: true,
      });
    for (const reason of ["invalid_dpop", "not_authorized"] as const) {
      const mapped = refusal(reason);
      expect(mapped, reason).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
      });
      expect("connectSessionRefused" in mapped, reason).toBe(false);
    }
  });

  it("never marks a proof this device could not make", () => {
    const failures = [
      new ManagedRelayDpopKeyLoadError({ keyStore: "indexed-db", cause: new Error("locked") }),
      new ManagedRelayTokenProofCreationError({
        method: "POST",
        url: "https://relay.example.test/v1/token",
        cause: new Error("sign failed"),
      }),
      new ManagedRelayRequestProofCreationError({
        method: "GET",
        url: "https://relay.example.test/v1/environments",
        cause: new Error("sign failed"),
      }),
    ];
    for (const failure of failures) {
      const mapped = mapManagedRelayError(failure);
      expect(mapped).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
      expect("connectSessionRefused" in mapped).toBe(false);
    }
  });

  it("keeps a timeout reported by the relay distinct from a local network failure", () => {
    const relayError = new RelayEnvironmentEndpointTimedOutError({
      code: "environment_endpoint_timed_out",
      traceId: "trace-server-timeout",
    });
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: relayError,
        relayError,
      }),
    );
    expect(mapped).toMatchObject({
      reason: "timeout",
      detail: "Relay timed out while contacting the environment endpoint.",
      traceId: "trace-server-timeout",
    });
  });

  it("marks only a relay request with no answer as relay unreachable, with the network hint", () => {
    const noAnswer = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }),
    );
    expect(noAnswer).toMatchObject({ reason: "relay-unavailable", relayUnreachable: true });
    expect(noAnswer.message).toContain(NETWORK_BLOCKING_HINT);

    const timedOut = mapManagedRelayError(
      new ManagedRelayRequestTimeoutError({
        activity: "Relay environment connection",
        timeoutMs: 10_000,
        traceId: null,
      }),
    );
    expect(timedOut).toMatchObject({ reason: "timeout", relayUnreachable: true });
    expect(timedOut.message).toContain(NETWORK_BLOCKING_HINT);
  });

  it("does not blame this device's network when the relay answered about the machine", () => {
    const silentService = new RelayEnvironmentEndpointTimedOutError({
      code: "environment_endpoint_timed_out",
      traceId: "trace-silent",
    });
    const answered = [
      mapManagedRelayError(
        new ManagedRelayRequestFailedError({
          action: "connect relay environment",
          cause: silentService,
          relayError: silentService,
        }),
      ),
      // A status the relay sent, such as its own deadline (HTTP 504), with no decoded error.
      mapManagedRelayError(
        new ManagedRelayRequestFailedError({
          action: "connect relay environment",
          cause: new Error("HTTP 504"),
        }),
      ),
    ];
    for (const mapped of answered) {
      expect(mapped.message).not.toContain(NETWORK_BLOCKING_HINT);
      expect(mapped._tag === "ConnectionTransientError" && mapped.relayUnreachable).toBeFalsy();
    }
  });

  it("presents clock skew as one possible cause for a generic DPoP error", () => {
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("request failed"),
        relayError: new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_dpop",
          traceId: "trace-1",
        }),
        traceId: "trace-1",
      }),
    );

    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
      traceId: "trace-1",
    });
  });

  it("uses a neutral hint when the relay identifies a non-clock DPoP error", () => {
    const mapped = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("request failed"),
        relayError: new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: "invalid_dpop",
          dpopFailureReason: "key_mismatch",
          traceId: "trace-1",
        }),
      }),
    );

    expect(mapped.message).toBe(`Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`);
  });
});

describe("mapRemoteDpopEnvironmentError", () => {
  it("keeps relay descriptor auth failures distinct from DPoP proof failures", () => {
    const error = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-descriptor",
    });
    expect(mapRemoteEnvironmentError(error).message).toBe("The environment credential is invalid.");
    expect(mapRemoteDpopEnvironmentError(error).message).toBe(
      `The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it.each([
    new RemoteEnvironmentAuthFetchError({
      message: "Failed to fetch remote environment endpoint.",
      cause: new TypeError("Failed to fetch"),
    }),
    new RemoteEnvironmentAuthTimeoutError("https://environment.example.test", 10_000),
  ])("does not blame this device's network when the machine's address fails: $_tag", (error) => {
    // The relay already answered; a silent or restarting service fails the
    // same way a blocked network would.
    const mapped = mapRemoteDpopEnvironmentError(error);
    expect(mapped).toMatchObject({ _tag: "ConnectionTransientError", detail: error.message });
    expect(mapped.message).not.toContain(NETWORK_BLOCKING_HINT);
    expect(mapped._tag === "ConnectionTransientError" && mapped.relayUnreachable).toBeFalsy();
  });

  it("does not present a generic environment auth error as confirmed clock skew", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );

    expect(mapped.message).toBe(`The environment credential is invalid. ${DPOP_UNKNOWN_HINT}`);
  });

  it("uses a neutral hint for a non-clock DPoP error from a new server", () => {
    const mapped = mapRemoteDpopEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        dpopFailureReason: "key_mismatch",
        traceId: "trace-1",
      }),
    );

    expect(mapped.message).toBe(`The environment credential is invalid. ${DPOP_RETRY_HINT}`);
  });
});

it("preserves the required device reapproval reason for direct and relay connections", () => {
  const error = new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason: "device_reapproval_required",
    traceId: "trace-reapprove",
  });
  for (const mapped of [mapRemoteEnvironmentError(error), mapRemoteDpopEnvironmentError(error)]) {
    expect(mapped.message).toContain("Approve this device again");
    // Says so as data, so a fleet machine can be paired again on its own.
    expect(mapped._tag === "ConnectionBlockedError" && mapped.reapprovalRequired).toBe(true);
  }
  const invalid = mapRemoteEnvironmentError(
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-invalid",
    }),
  );
  expect(invalid._tag === "ConnectionBlockedError" && invalid.reapprovalRequired).toBeFalsy();
});

describe("mapRemoteEnvironmentError rate limits", () => {
  it("keeps retry-after so the supervisor waits it out", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentRateLimitedError({ code: "rate_limited", retryAfterSeconds: 173 }),
    );
    expect(mapped).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "rate-limited",
      retryAfterMs: 173_000,
    });
  });
});

describe("a machine waiting to approve this device (1327)", () => {
  const refused = new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason: "invalid_credential",
    teamRulesMessage: "Open SpecWithCode on m4 and type this code: K7QX2M",
    refusal: "device_not_approved",
    approvalCode: "K7QX2M",
    traceId: "trace-device",
  });

  it("keeps retrying with the code and the words, on any route, never asking to pair again", () => {
    for (const mapped of [
      mapRemoteEnvironmentError(refused),
      mapRemoteDpopEnvironmentError(refused),
    ]) {
      expect(mapped).toMatchObject({
        _tag: "ConnectionTransientError",
        detail: "Open SpecWithCode on m4 and type this code: K7QX2M",
        deviceApprovalCode: "K7QX2M",
        retryAfterMs: 4_000,
      });
      expect(mapped).not.toHaveProperty("reapprovalRequired");
    }
  });
});
