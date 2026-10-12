import { describe, expect, it } from "vite-plus/test";

import { accountInitial, pickSignInAddress } from "./signInAddress";

describe("pickSignInAddress", () => {
  it("prefers the HTTPS address this page is open at", () => {
    expect(
      pickSignInAddress({
        pageUrl: "https://m4.example.ts.net/settings/general",
        directEndpoints: [{ httpBaseUrl: "https://other.example.ts.net:8443/" }],
        advertisedEndpoints: [],
      }),
    ).toBe("https://m4.example.ts.net/pair");
  });

  it("falls back to the server's Tailscale HTTPS route from the desktop app or localhost", () => {
    expect(
      pickSignInAddress({
        pageUrl: "studio://app/index.html",
        directEndpoints: [
          { httpBaseUrl: "http://192.168.1.20:8319/" },
          { httpBaseUrl: "https://m4.example.ts.net/" },
        ],
        advertisedEndpoints: [],
      }),
    ).toBe("https://m4.example.ts.net/pair");
    expect(
      pickSignInAddress({
        pageUrl: "https://localhost:8319/",
        directEndpoints: [],
        advertisedEndpoints: [{ httpBaseUrl: "https://m4.example.ts.net:8443/" }],
      }),
    ).toBe("https://m4.example.ts.net:8443/pair");
  });

  it("offers no address when only plain HTTP or loopback is reachable", () => {
    expect(
      pickSignInAddress({
        pageUrl: "http://127.0.0.1:8319/",
        directEndpoints: [{ httpBaseUrl: "http://100.64.0.2:8319/" }],
        advertisedEndpoints: [{ httpBaseUrl: "not a url" }],
      }),
    ).toBeNull();
  });
});

describe("accountInitial", () => {
  it("takes the first letter or digit", () => {
    expect(accountInitial("anton@example.com")).toBe("A");
    expect(accountInitial("  m4")).toBe("M");
    expect(accountInitial("—")).toBe("?");
  });
});
