import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { isOwnApp, personDeviceCandidate, personDeviceOf } from "./personDevice.ts";

const THUMBPRINT = "0vC2F1sT6mE8Yt7j3cQk9bZx5uPa4LdR1nWg0HsXyAe";
const KEY = `jkt:${THUMBPRINT}`;
const approved =
  (...keys: ReadonlyArray<string>) =>
  (key: string) =>
    Effect.succeed(keys.includes(key));

const connect = {
  subject: "cloud-connect",
  proofKeyThumbprint: THUMBPRINT,
  principal: { kind: "device" },
  clientLabel: "Work laptop",
  clientDeviceType: "desktop",
  deviceKey: KEY,
} as const;

const request = (
  peer: string | undefined,
  headers: Record<string, string> = {},
): HttpServerRequest.HttpServerRequest =>
  ({
    headers,
    remoteAddress: peer === undefined ? Option.none() : Option.some(peer),
    source: {},
  }) as unknown as HttpServerRequest.HttpServerRequest;

describe("personDeviceOf", () => {
  it.effect("admits a Connect sign-in whose own key is approved", () =>
    Effect.gen(function* () {
      const outcome = yield* personDeviceOf(connect, approved(KEY));
      expect(outcome).toMatchObject({
        device: { key: KEY, thumbprint: THUMBPRINT, kind: "connect", label: "Work laptop" },
      });
    }),
  );

  it.effect("admits a phone link that proved an approved key", () =>
    Effect.gen(function* () {
      const outcome = yield* personDeviceOf(
        { subject: "phone-link:hub1:abc", proofKeyThumbprint: THUMBPRINT },
        approved(KEY),
      );
      expect(outcome).toMatchObject({ device: { key: KEY, kind: "phone" } });
    }),
  );

  const refused: ReadonlyArray<readonly [string, Parameters<typeof personDeviceOf>[0], string]> = [
    ["a Connect key that is not on the list", { ...connect, deviceKey: undefined }, "not_approved"],
    [
      "a Connect session with no key",
      { subject: "cloud-connect", principal: { kind: "device" } },
      "no_device_key",
    ],
    ["a phone link with no key", { subject: "phone-link:hub1:abc" }, "no_device_key"],
    [
      "a management key",
      { subject: "fleet-invitation", principal: { kind: "coordinator" } },
      "coordinator",
    ],
    [
      "a coordinator principal on a Connect subject",
      { ...connect, principal: { kind: "coordinator" } },
      "coordinator",
    ],
    ["an MCP client", { subject: "mcp-client", deviceKey: KEY }, "not_a_device_sign_in"],
    ["the local command line", { subject: "local-cli-owner" }, "not_a_device_sign_in"],
    [
      "a pairing code",
      { subject: "one-time-token", principal: { kind: "device" }, proofKeyThumbprint: THUMBPRINT },
      "not_a_device_sign_in",
    ],
    ["the startup link", { subject: "administrative-bootstrap" }, "not_a_device_sign_in"],
    ["a dev token", { subject: "reusable-dev-token" }, "not_a_device_sign_in"],
    ["a child dev token", { subject: "reusable-dev-token-child" }, "not_a_device_sign_in"],
    [
      "this machine's own app",
      { subject: "desktop-bootstrap", principal: { kind: "device" } },
      "not_a_device_sign_in",
    ],
    [
      "a session minted for a device by another credential",
      { ...connect, boundDevice: { key: KEY, approval: "a1" } },
      "acts_for_another",
    ],
    [
      "a session whose device key is not its own",
      { ...connect, deviceKey: "jkt:someone-else" },
      "acts_for_another",
    ],
    ["a bot", { ...connect, clientDeviceType: "bot" }, "bot"],
  ];

  for (const [name, session, reason] of refused)
    it.effect(`refuses ${name}`, () =>
      Effect.gen(function* () {
        // Everything is on the list here, so only the session's own shape refuses it.
        const everything = reason === "not_approved" ? approved() : () => Effect.succeed(true);
        expect(yield* personDeviceOf(session, everything)).toEqual({ refusal: reason });
      }),
    );

  it("asks the list only about the session's own key", () => {
    expect(personDeviceCandidate(connect)).toMatchObject({ device: { key: KEY } });
  });
});

describe("isOwnApp", () => {
  const app = {
    subject: "desktop-bootstrap",
    scopes: ["access:write", "orchestration:operate"],
    principal: { kind: "device" },
    clientDeviceType: "desktop",
  } as const;

  it("admits the app's session over loopback", () => {
    expect(isOwnApp(app, request("127.0.0.1"), [])).toBe(true);
    expect(isOwnApp(app, request("::1"), [])).toBe(true);
  });

  it("refuses the app's subject from anywhere else", () => {
    expect(isOwnApp(app, request("203.0.113.9"), [])).toBe(false);
    expect(isOwnApp(app, request(undefined), [])).toBe(false);
    expect(isOwnApp(app, request("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }), [])).toBe(
      false,
    );
    expect(isOwnApp(app, request("127.0.0.1", { "cf-connecting-ip": "203.0.113.9" }), [])).toBe(
      false,
    );
    expect(isOwnApp(app, request("127.0.0.1", { "tailscale-user-login": "a@b" }), [])).toBe(false);
  });

  const others: ReadonlyArray<readonly [string, Parameters<typeof isOwnApp>[0]]> = [
    ["the startup link", { ...app, subject: "administrative-bootstrap" }],
    ["a dev token", { ...app, subject: "reusable-dev-token" }],
    ["the local command line", { ...app, subject: "local-cli-owner" }],
    ["a pairing code", { ...app, subject: "one-time-token" }],
    ["a Connect device", { ...app, subject: "cloud-connect" }],
    [
      "a management key",
      { ...app, subject: "fleet-invitation", principal: { kind: "coordinator" } },
    ],
    ["an MCP client", { ...app, subject: "mcp-client" }],
    ["a bot that borrowed the app's subject", { ...app, clientDeviceType: "bot" }],
    ["a session without access:write", { ...app, scopes: ["orchestration:operate"] }],
    ["a session bound to a device", { ...app, boundDevice: { key: "jkt:x", approval: "a" } }],
    ["a session acting for a device", { ...app, deviceKey: "jkt:x" }],
    ["a coordinator with the app's subject", { ...app, principal: { kind: "coordinator" } }],
  ];
  for (const [name, session] of others)
    it(`refuses ${name}`, () => {
      expect(isOwnApp(session, request("127.0.0.1"), [])).toBe(false);
    });
});
