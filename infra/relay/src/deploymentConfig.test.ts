import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  managedEndpointBaseDomainForZone,
  managedEndpointDigestInput,
  managedEndpointForHostname,
  managedEndpointHostname,
  isManagedEndpointHostname,
  managedEndpointTunnelName,
  managedEndpointTunnelNamePrefix,
  relayOwnsManagedEndpointZone,
  RelayPublicDomainLabelTooLongError,
  RelayTunnelBaseDomainOutsideZoneError,
  relayPublicDomainForStage,
  relayResourceNameForStage,
} from "./deploymentConfig.ts";

const isRelayPublicDomainLabelTooLongError = Schema.is(RelayPublicDomainLabelTooLongError);

describe("relayPublicDomainForStage", () => {
  it("uses the canonical relay hostname for production", () => {
    expect(relayPublicDomainForStage("prod", ".example.com.")).toBe("relay.example.com");
  });

  it("isolates personal stages below the imported zone", () => {
    expect(relayPublicDomainForStage("dev_alice", "example.com")).toBe(
      "relay-dev-alice.example.com",
    );
  });

  it("reports the stage and derived DNS label when the label is too long", () => {
    const stage = `dev_${"x".repeat(60)}`;
    let error: unknown;

    try {
      relayPublicDomainForStage(stage, "example.com");
    } catch (cause) {
      error = cause;
    }

    if (!isRelayPublicDomainLabelTooLongError(error)) {
      throw error;
    }
    expect(error).toMatchObject({
      stage,
      label: `relay-dev-${"x".repeat(60)}`,
      maxLength: 63,
    });
    expect(error.message).toBe(
      `Relay stage '${stage}' produces custom domain label 'relay-dev-${"x".repeat(60)}' (70 characters), exceeding the DNS label limit of 63.`,
    );
  });
});

describe("relayOwnsManagedEndpointZone", () => {
  it("keeps the shared Cloudflare zone owned by production", () => {
    expect(relayOwnsManagedEndpointZone("prod")).toBe(true);
    expect(relayOwnsManagedEndpointZone("dev_alice")).toBe(false);
  });
});

describe("relayResourceNameForStage", () => {
  it("isolates production and personal stages", () => {
    expect(relayResourceNameForStage("studio-code-relay-traces", "prod")).toBe(
      "studio-code-relay-traces-prod",
    );
    expect(relayResourceNameForStage("studio-code-relay-traces", "dev_alice")).toBe(
      "studio-code-relay-traces-dev-alice",
    );
  });
});

describe("managed endpoint names", () => {
  it("uses the stage slug and a stable stage-scoped digest suffix", () => {
    const hash = "ABCDEF0123456789ABCDEF0123456789";

    expect(managedEndpointDigestInput("dev_alice", "user_123", "env_123")).toBe(
      "dev_alice:user_123:env_123",
    );
    expect(managedEndpointHostname("dev_alice", ".example.com.", hash)).toBe(
      "dev-alice-abcdef0123456789.example.com",
    );
    expect(managedEndpointHostname("prod", "studiorelay.com", hash)).toBe(
      "prod-abcdef0123456789.studiorelay.com",
    );
    expect(managedEndpointTunnelName("dev_alice", hash)).toBe(
      "studiorelay-managedendpoint-dev-alice-abcdef0123456789",
    );
    expect(managedEndpointTunnelNamePrefix("dev_alice")).toBe(
      "studiorelay-managedendpoint-dev-alice-",
    );
  });

  it("keeps the DNS label within the provider limit for long stage names", () => {
    const hostname = managedEndpointHostname(
      "dev_" + "x".repeat(100),
      "example.com",
      "a".repeat(64),
    );

    expect(hostname.split(".")[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname).toMatch(/-a{16}\.example\.com$/);
  });

  it("accepts allocated hostnames within the relay zone", () => {
    expect(isManagedEndpointHostname("dev-alice-abcdef0123456789.example.com", "example.com")).toBe(
      true,
    );
    expect(managedEndpointForHostname("dev-alice-abcdef0123456789.example.com")).toEqual({
      httpBaseUrl: "https://dev-alice-abcdef0123456789.example.com/",
      wsBaseUrl: "wss://dev-alice-abcdef0123456789.example.com/ws",
      providerKind: "cloudflare_tunnel",
    });
  });

  it("rejects hostnames outside the relay zone", () => {
    expect(isManagedEndpointHostname("internal.example.net", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("example.com.attacker.test", "example.com")).toBe(false);
    expect(isManagedEndpointHostname("dev-alice.example.com.", "example.com")).toBe(false);
  });
});

describe("managedEndpointBaseDomainForZone", () => {
  it("defaults to the tunnel zone", () => {
    expect(managedEndpointBaseDomainForZone("Example.com.", undefined)).toBe("example.com");
    expect(managedEndpointBaseDomainForZone("example.com", "  ")).toBe("example.com");
  });

  it("accepts a subdomain inside the tunnel zone", () => {
    expect(managedEndpointBaseDomainForZone("example.com", "Tunnels.example.com.")).toBe(
      "tunnels.example.com",
    );
    expect(managedEndpointHostname("prod", "tunnels.example.com", "a".repeat(64))).toMatch(
      /^prod-[a-z0-9]+\.tunnels\.example\.com$/u,
    );
  });

  it("rejects a base domain outside the tunnel zone", () => {
    for (const override of ["tunnels.other.com", "badexample.com", "bad_label.example.com"]) {
      expect(() => managedEndpointBaseDomainForZone("example.com", override)).toThrow(
        RelayTunnelBaseDomainOutsideZoneError,
      );
    }
  });
});
