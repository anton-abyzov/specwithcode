import { describe, expect, it } from "vite-plus/test";

import { isManagedEndpointHost, parseFleetOrigin } from "./fleetOrigin.ts";

const baseDomain = "spec-weave.com";
const parse = (value: string) => parseFleetOrigin(value, { baseDomain });

describe("parseFleetOrigin", () => {
  it("accepts a tailnet origin on any port and a managed Connect origin", () => {
    expect(parse("https://m4.tail1234.ts.net:8443")).toEqual({
      origin: "https://m4.tail1234.ts.net:8443",
      transport: "tailnet",
    });
    expect(parse("https://M4.Tail1234.ts.net/")).toEqual({
      origin: "https://m4.tail1234.ts.net",
      transport: "tailnet",
    });
    expect(parse("https://prod-0123456789abcdef.spec-weave.com")).toEqual({
      origin: "https://prod-0123456789abcdef.spec-weave.com",
      transport: "connect",
    });
    expect(parse("https://prod-0123456789abcdef.spec-weave.com:443/")).toEqual({
      origin: "https://prod-0123456789abcdef.spec-weave.com",
      transport: "connect",
    });
  });

  it.each([
    "https://relay.spec-weave.com",
    "https://www.spec-weave.com",
    "https://spec-weave.com",
    "https://prod-0123456789abcdef.spec-weave.com.evil.com",
    "https://prod-0123456789abcdef.evilspec-weave.com",
    "https://evil-spec-weave.com",
    "https://a.prod-0123456789abcdef.spec-weave.com",
    "https://prod-0123456789abcdeg.spec-weave.com",
    "https://prod-0123456789abcdef.spec-weave.com.",
    "http://prod-0123456789abcdef.spec-weave.com",
    "http://m4.tail1234.ts.net",
    "https://prod-0123456789abcdef.spec-weave.com:8443",
    "https://prod-0123456789abcdef.spec-weave.com/path",
    "https://prod-0123456789abcdef.spec-weave.com/?q=1",
    "https://prod-0123456789abcdef.spec-weave.com/?",
    "https://prod-0123456789abcdef.spec-weave.com/#x",
    "https://user:pw@prod-0123456789abcdef.spec-weave.com",
    "https://user@m4.tail1234.ts.net",
    "https://m4.tail1234.ts.net/path",
    "https://x.ts.net.spec-weave.com",
    "https://m4.tail1234.ts.net.evil.com",
    "https://127.0.0.1",
    "not a url",
  ])("rejects %s", (value) => {
    expect(parse(value)).toBeNull();
  });

  it("follows the configured base domain", () => {
    expect(
      parseFleetOrigin("https://prod-0123456789abcdef.example.org", { baseDomain: "example.org" })
        ?.transport,
    ).toBe("connect");
    expect(parse("https://prod-0123456789abcdef.example.org")).toBeNull();
  });
});

describe("isManagedEndpointHost", () => {
  it("matches only managed hosts on the default port", () => {
    expect(isManagedEndpointHost("prod-0123456789abcdef.spec-weave.com", { baseDomain })).toBe(
      true,
    );
    expect(isManagedEndpointHost("PROD-0123456789abcdef.spec-weave.com:443", { baseDomain })).toBe(
      true,
    );
    expect(isManagedEndpointHost("prod-0123456789abcdef.spec-weave.com:8443", { baseDomain })).toBe(
      false,
    );
    expect(isManagedEndpointHost("m4.tail1234.ts.net", { baseDomain })).toBe(false);
    expect(isManagedEndpointHost("relay.spec-weave.com", { baseDomain })).toBe(false);
    expect(isManagedEndpointHost(undefined, { baseDomain })).toBe(false);
  });
});
