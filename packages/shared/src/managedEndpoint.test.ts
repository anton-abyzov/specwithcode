// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test recomputes the relay's sha256 slug.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN,
  isManagedEndpointHostname,
  managedEndpointBaseDomainFromRelayUrl,
  managedEndpointHashFor,
  managedEndpointSlug,
  resolveManagedEndpointBaseDomain,
  splitManagedEndpointLabel,
} from "./managedEndpoint.ts";

const base = "spec-weave.com";

describe("isManagedEndpointHostname", () => {
  it("accepts exactly one managed label above the base domain", () => {
    expect(isManagedEndpointHostname("prod-0123456789abcdef.spec-weave.com", base)).toBe(true);
    expect(
      isManagedEndpointHostname(`${"a".repeat(46)}-0123456789abcdef.spec-weave.com`, base),
    ).toBe(true);
    expect(splitManagedEndpointLabel("dev-alice-0123456789abcdef.spec-weave.com", base)).toEqual({
      prefix: "dev-alice",
      hash: "0123456789abcdef",
    });
  });

  it.each([
    "relay.spec-weave.com",
    "relay-staging.spec-weave.com",
    "www.spec-weave.com",
    "spec-weave.com",
    "prod-0123456789abcdef.spec-weave.com.evil.com",
    "prod-0123456789abcdef.evilspec-weave.com",
    "evil-spec-weave.com",
    "a.prod-0123456789abcdef.spec-weave.com",
    "prod-0123456789abcdeg.spec-weave.com",
    "prod-0123456789abcde.spec-weave.com",
    "prod-0123456789abcdef0.spec-weave.com",
    "prod-0123456789ABCDEF.spec-weave.com",
    "PROD-0123456789abcdef.spec-weave.com",
    "prod-0123456789abcdef.spec-weave.com.",
    "-0123456789abcdef.spec-weave.com",
    "prod--0123456789abcdef.spec-weave.com",
    `${"a".repeat(47)}-0123456789abcdef.spec-weave.com`,
    "x.ts.net.spec-weave.com",
  ])("rejects %s", (hostname) => {
    expect(isManagedEndpointHostname(hostname, base)).toBe(false);
  });
});

describe("managed endpoint base domain", () => {
  it("derives the base from the relay URL", () => {
    expect(managedEndpointBaseDomainFromRelayUrl("https://relay.spec-weave.com")).toBe(base);
    expect(managedEndpointBaseDomainFromRelayUrl("https://relay-staging.spec-weave.com/")).toBe(
      base,
    );
    expect(managedEndpointBaseDomainFromRelayUrl("https://api.spec-weave.com")).toBeNull();
    expect(managedEndpointBaseDomainFromRelayUrl("https://relay.com")).toBeNull();
    expect(managedEndpointBaseDomainFromRelayUrl("http://relay.spec-weave.com")).toBeNull();
    expect(managedEndpointBaseDomainFromRelayUrl("not a url")).toBeNull();
  });

  it("refuses a public suffix as the base domain", () => {
    for (const unsafe of ["co.uk", "com.au", "github.io", "ts.net", "workers.dev"])
      expect(
        resolveManagedEndpointBaseDomain({ env: { STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN: unsafe } }),
        unsafe,
      ).toBe(DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN);
    expect(managedEndpointBaseDomainFromRelayUrl("https://relay.co.uk")).toBeNull();
    expect(
      resolveManagedEndpointBaseDomain({
        env: { STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN: "tunnels.example.co.uk" },
      }),
    ).toBe("tunnels.example.co.uk");
  });

  it("prefers a valid env override, then the relay URL, then the default", () => {
    expect(
      resolveManagedEndpointBaseDomain({
        env: { STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN: "Tunnels.Example.com" },
        relayUrl: "https://relay.spec-weave.com",
      }),
    ).toBe("tunnels.example.com");
    expect(
      resolveManagedEndpointBaseDomain({
        env: { STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN: "not valid!" },
        relayUrl: "https://relay-dev.example.org",
      }),
    ).toBe("example.org");
    expect(resolveManagedEndpointBaseDomain({ env: {} })).toBe(
      DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN,
    );
    expect(resolveManagedEndpointBaseDomain({ relayUrl: "https://example.org" })).toBe(
      DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN,
    );
  });
});

describe("managedEndpointHashFor", () => {
  it("matches the relay's sha256 digest prefix", () => {
    const expected = createHash("sha256")
      .update("prod:user_123:env_123")
      .digest("hex")
      .slice(0, 16);
    expect(managedEndpointHashFor("prod", "user_123", "env_123")).toBe(expected);
    const host = `${managedEndpointSlug("prod")}-${expected}.${base}`;
    expect(isManagedEndpointHostname(host, base)).toBe(true);
    expect(managedEndpointSlug("Dev_Alice")).toBe("dev-alice");
  });
});
