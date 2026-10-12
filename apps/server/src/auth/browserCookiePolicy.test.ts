import { expect, it } from "@effect/vitest";
import { browserCookieAttributes } from "./browserCookiePolicy.ts";

it.each([
  ["native HTTPS", "https://studio.example.test/api/auth/session", {}, true],
  [
    "private HTTPS proxy",
    "/api/auth/browser-session",
    { host: "127.0.0.1:8319", origin: "https://studio.example.test" },
    true,
  ],
  [
    "HTTPS legacy GET",
    "/api/auth/session",
    { host: "127.0.0.1:8319", referer: "https://studio.example.test/" },
    true,
  ],
  [
    "local legacy GET",
    "/api/auth/session",
    { host: "127.0.0.1:8319", referer: "http://127.0.0.1:8319/" },
    false,
  ],
  [
    "HTTPS Referer blocks HTTP Origin downgrade",
    "/api/auth/session",
    {
      host: "127.0.0.1:8319",
      origin: "http://127.0.0.1:8319",
      referer: "https://studio.example.test/",
    },
    true,
  ],
  [
    "foreign local Host",
    "/api/auth/session",
    { host: "studio.example.test", origin: "http://127.0.0.1:8319" },
    true,
  ],
  ["unknown proxy transport", "/api/auth/session", { host: "127.0.0.1:8319" }, true],
  ["loopback HTTP", "http://127.0.0.1:8319/api/auth/session", {}, false],
  [
    "explicit local browser",
    "/api/auth/browser-session",
    { host: "127.0.0.1:8319", origin: "http://127.0.0.1:8319" },
    false,
  ],
  [
    "IPv6 local browser",
    "/api/auth/browser-session",
    { host: "[::1]:8319", origin: "http://[::1]:8319" },
    false,
  ],
  ["localhost", "http://localhost:8319/api/auth/session", {}, false],
  [
    "different local port",
    "/api/auth/session",
    { host: "127.0.0.1:8319", origin: "http://127.0.0.1:9000" },
    true,
  ],
  [
    "absolute-form host mismatch",
    "http://127.0.0.1/api/auth/session",
    { host: "studio.example.test" },
    true,
  ],
  ["nonloopback HTTP", "http://studio.example.test/api/auth/session", {}, true],
  ["null origin", "http://127.0.0.1/api/auth/session", { origin: "null" }, true],
  ["malformed origin", "http://127.0.0.1/api/auth/session", { origin: "http://[" }, true],
  ["origin path", "http://127.0.0.1/api/auth/session", { origin: "http://127.0.0.1/evil" }, true],
  [
    "credential-bearing origin",
    "/api/auth/session",
    { host: "127.0.0.1", origin: "http://x:y@127.0.0.1" },
    true,
  ],
  ["deceptive hostname", "http://127.0.0.1.example.test/api/auth/session", {}, true],
] as const)("%s retains the intended cookie transport", (_name, originalUrl, headers, secure) => {
  expect(browserCookieAttributes({ originalUrl, headers })).toEqual({
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
  });
});

it.each(["Forwarded", "forwarded", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port"])(
  "%s cannot downgrade HTTPS or establish a local exception",
  (name) => {
    expect(
      browserCookieAttributes({
        originalUrl: "https://studio.example.test/api/auth/session",
        headers: { [name]: "http" },
      }).secure,
    ).toBe(true);
    expect(
      browserCookieAttributes({
        originalUrl: "/api/auth/session",
        headers: { host: "studio.example.test", [name]: "http://127.0.0.1" },
      }).secure,
    ).toBe(true);
    expect(
      browserCookieAttributes({
        originalUrl: "http://127.0.0.1/api/auth/session",
        headers: { [name]: "https" },
      }).secure,
    ).toBe(false);
  },
);
