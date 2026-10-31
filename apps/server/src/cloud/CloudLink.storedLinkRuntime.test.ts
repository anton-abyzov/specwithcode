import { describe, expect, it } from "@effect/vitest";

import {
  CloudLinkEndpointUnavailableError,
  isStoredLinkRuntimeNotStarted,
  shouldRetryCloudLink,
} from "./CloudLink.ts";

describe("isStoredLinkRuntimeNotStarted", () => {
  it("stops the startup relink loop when the stored link's relay client is not installed yet", () => {
    const notInstalled = new CloudLinkEndpointUnavailableError({
      reason: "runtime-not-started",
      endpointRuntimeStatus: {
        status: "failed",
        providerKind: "cloudflare_tunnel",
        failure: "not-installed",
      },
    });
    expect(isStoredLinkRuntimeNotStarted(notInstalled)).toBe(true);
  });

  it("leaves unsupported runtimes and unconfirmed origins to the normal rules", () => {
    expect(
      isStoredLinkRuntimeNotStarted(
        new CloudLinkEndpointUnavailableError({
          reason: "runtime-not-started",
          endpointRuntimeStatus: { status: "unsupported", providerKind: "manual" },
        }),
      ),
    ).toBe(false);
    expect(
      isStoredLinkRuntimeNotStarted(
        new CloudLinkEndpointUnavailableError({
          reason: "origin-unconfirmed",
          endpointRuntimeStatus: null,
        }),
      ),
    ).toBe(false);
    expect(isStoredLinkRuntimeNotStarted(new Error("network"))).toBe(false);
    expect(typeof shouldRetryCloudLink).toBe("function");
  });
});
