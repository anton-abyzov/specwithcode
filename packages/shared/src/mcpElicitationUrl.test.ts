import { describe, expect, it } from "vite-plus/test";

import {
  checkMcpElicitationUrl,
  MCP_ELICITATION_URL_MAX_LENGTH,
  registrableDomainOf,
} from "./mcpElicitationUrl.ts";

const link = (raw: string) => {
  const checked = checkMcpElicitationUrl(raw);
  if (!checked.ok) throw new Error(`refused: ${checked.reason}`);
  return checked.link;
};

describe("checkMcpElicitationUrl", () => {
  it("keeps an https link exactly as the server sent it", () => {
    const raw = "https://GitHub.com/login/device?code=AB%2FCD#step-2";
    const checked = link(raw);
    expect(checked.url).toBe(raw);
    expect(checked.scheme).toBe("https");
    expect(checked.host).toBe("github.com");
    expect(checked.registrableDomain).toBe("github.com");
    expect(checked.warnings).toEqual([]);
  });

  it("refuses links that are not http or https", () => {
    for (const raw of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "vscode://open",
      "ftp://example.com/",
      "mailto:a@example.com",
    ])
      expect(checkMcpElicitationUrl(raw)).toEqual({ ok: false, reason: "scheme" });
  });

  it("refuses user info, even empty, before the host", () => {
    for (const raw of [
      "https://github.com@evil.example/login",
      "https://user:pass@example.com/",
      "https://@example.com/",
      "https://good.example\\@evil.example/",
    ])
      expect(checkMcpElicitationUrl(raw)).toEqual({ ok: false, reason: "user-info" });
    // An @ after the host is part of the path or query, not user info.
    expect(link("https://example.com/users/@me?to=a@b.example").registrableDomain).toBe(
      "example.com",
    );
  });

  it("refuses what does not parse, and links that are too long", () => {
    for (const raw of ["", "not a url", "https://", 42, null])
      expect(checkMcpElicitationUrl(raw)).toEqual({ ok: false, reason: "unparseable" });
    expect(
      checkMcpElicitationUrl(`https://example.com/${"a".repeat(MCP_ELICITATION_URL_MAX_LENGTH)}`),
    ).toEqual({ ok: false, reason: "too-long" });
  });

  it("warns on Punycode and shows the decoded host", () => {
    // A Cyrillic "а" in "аpple.com": the parser turns it into Punycode.
    const checked = link("https://аpple.com/sign-in");
    expect(checked.host).toBe("xn--pple-43d.com");
    expect(checked.displayHost).toBe("аpple.com");
    expect(checked.warnings).toEqual(["punycode", "mixed-script"]);
    expect(link("https://xn--bcher-kva.example/").displayHost).toBe("bücher.example");
    // An all-Cyrillic host is Punycode but does not mix scripts.
    expect(link("https://пример.рф/").warnings).toEqual(["punycode"]);
  });

  it("does not count Japanese or Korean as mixed scripts", () => {
    expect(link("https://東京タワー.jp/").warnings).toEqual(["punycode"]);
  });

  it("warns on plain http except for a loopback host", () => {
    expect(link("http://example.com/").warnings).toEqual(["not-https"]);
    for (const raw of [
      "http://localhost:8080/callback",
      "http://127.0.0.1:3000/",
      "http://[::1]:8000/",
      "http://app.localhost/",
    ])
      expect(link(raw).warnings).toEqual([]);
  });

  it("finds the registrable domain", () => {
    expect(registrableDomainOf("a.b.example.com")).toBe("example.com");
    expect(registrableDomainOf("login.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomainOf("evil.github.io")).toBe("evil.github.io");
    expect(registrableDomainOf("example.com.")).toBe("example.com");
    expect(registrableDomainOf("localhost")).toBe("localhost");
    expect(registrableDomainOf("192.168.1.10")).toBe("192.168.1.10");
    expect(registrableDomainOf("[::1]")).toBe("[::1]");
    expect(link("https://accounts.google.com.evil.example/").registrableDomain).toBe(
      "evil.example",
    );
  });
});
