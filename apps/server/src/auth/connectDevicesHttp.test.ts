// @effect-diagnostics-next-line nodeBuiltinImport:off - hashes a fixture the way the app does.
import { createHash } from "node:crypto";

import { expect, it } from "@effect/vitest";
import { AuthAccessWriteScope } from "@specweave-studio/contracts";
import { DESKTOP_OWNER_PROOF_HEADER } from "@specweave-studio/shared/httpObservability";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { deviceApprover } from "./connectDevicesHttp.ts";
import { desktopOwnerProofMatches, desktopOwnerProofOf, isMachineOwner } from "./deviceApprover.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const approvedKeys = new Set(["jkt:approved-laptop", "link:phone-link:prod:approved"]);
const isApproved = (key: string) => Effect.succeed(approvedKeys.has(key));
const writes = new Set<string>([AuthAccessWriteScope]);
const owner = { kind: "owner", name: "this machine", key: null };

it.effect("only this machine's owner or an approved device may approve (B-02)", () =>
  Effect.gen(function* () {
    // The app this machine runs, the startup link, and development tokens.
    for (const subject of [
      "desktop-bootstrap",
      EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
      "reusable-dev-token",
      "reusable-dev-token-child",
    ])
      expect(
        yield* deviceApprover({ subject, scopes: writes, clientDeviceType: "desktop" }, isApproved),
      ).toEqual(owner);
    // A browser that opened the startup link reports its own kind.
    expect(
      yield* deviceApprover(
        {
          subject: EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
          scopes: writes,
          clientDeviceType: "mobile",
        },
        isApproved,
      ),
    ).toEqual(owner);

    // A local session that can only read may not change the list.
    expect(
      yield* deviceApprover({ subject: "desktop-bootstrap", scopes: new Set() }, isApproved),
    ).toBeNull();

    // A Connect device this machine approved, named by its own label.
    expect(
      yield* deviceApprover(
        {
          subject: "cloud-connect",
          scopes: writes,
          proofKeyThumbprint: "approved-laptop",
          clientLabel: "Work laptop",
        },
        isApproved,
      ),
    ).toEqual({ kind: "device", name: "Work laptop", key: "jkt:approved-laptop" });
    // With standard scopes too: an approved phone holds no `access:write`.
    expect(
      yield* deviceApprover(
        {
          subject: "cloud-connect",
          scopes: new Set(),
          proofKeyThumbprint: "approved-laptop",
          clientLabel: "Work laptop",
        },
        isApproved,
      ),
    ).toEqual({ kind: "device", name: "Work laptop", key: "jkt:approved-laptop" });

    // The device that is asking can not approve anything, its own code included.
    expect(
      yield* deviceApprover(
        {
          subject: "cloud-connect",
          scopes: writes,
          proofKeyThumbprint: "waiting-phone",
          clientLabel: "Test phone",
        },
        isApproved,
      ),
    ).toBeNull();
    // A Connect session without a proof key can not be told apart from another, so no.
    expect(yield* deviceApprover({ subject: "cloud-connect", scopes: writes }, isApproved)).toBe(
      null,
    );

    // Machines are not people: coordinators, workers and agents never approve devices.
    for (const subject of [
      EnvironmentAuth.MCP_CLIENT_SUBJECT,
      EnvironmentAuth.FLEET_INVITATION_SUBJECT,
    ])
      expect(yield* deviceApprover({ subject, scopes: writes }, isApproved)).toBeNull();
    expect(
      yield* deviceApprover(
        { subject: "desktop-bootstrap", scopes: writes, principal: { kind: "coordinator" } },
        isApproved,
      ),
    ).toBeNull();
  }),
);

it.effect("a session minted on the command line is never this machine's owner", () =>
  Effect.gen(function* () {
    const minted = [
      // `pair --scope access:write`, exchanged at /oauth/token.
      { subject: "one-time-token", clientDeviceType: "desktop" },
      { subject: "device-approval", clientDeviceType: "desktop" },
      // The CLI's own credential file.
      { subject: "local-cli-credential", clientDeviceType: "bot" },
      // `auth session issue`, with or without a borrowed `--subject`.
      { subject: "local-cli-owner", clientDeviceType: "bot" },
      { subject: "desktop-bootstrap", clientDeviceType: "bot" },
      {
        subject: EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
        clientDeviceType: "bot",
      },
      { subject: "reusable-dev-token", clientDeviceType: "bot" },
    ];
    for (const session of minted) {
      expect(yield* deviceApprover({ ...session, scopes: writes }, isApproved)).toBeNull();
      expect(isMachineOwner({ ...session, scopes: writes })).toBe(false);
    }
  }),
);

it.effect("a session acting for a device is not the owner, even under an owner subject", () =>
  Effect.gen(function* () {
    const base = { subject: "desktop-bootstrap", scopes: writes, clientDeviceType: "desktop" };
    expect(
      yield* deviceApprover({ ...base, boundDevice: { key: "jkt:a", approval: "x" } }, isApproved),
    ).toBeNull();
    expect(yield* deviceApprover({ ...base, deviceKey: "jkt:a" }, isApproved)).toBeNull();
    // The attached app keeps its grant's device principal and still counts.
    expect(yield* deviceApprover({ ...base, principal: { kind: "device" } }, isApproved)).toEqual(
      owner,
    );
  }),
);

const loopback = (headers: Record<string, string>, address = "127.0.0.1") =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1:9/oauth/token", {
      method: "POST",
      headers: { host: "127.0.0.1:9", ...headers },
    }),
  ).modify({ remoteAddress: Option.some(address) });

it("reads the desktop proof only from a direct loopback request", () => {
  const proof = { [DESKTOP_OWNER_PROOF_HEADER]: "proof-value" };
  expect(desktopOwnerProofOf(loopback(proof))).toBe("proof-value");
  expect(desktopOwnerProofOf(loopback(proof, "::1"))).toBe("proof-value");
  expect(desktopOwnerProofOf(loopback({}))).toBeUndefined();

  // Another peer, or anything a proxy on this machine added.
  expect(desktopOwnerProofOf(loopback(proof, "192.0.2.10"))).toBeUndefined();
  // A service bound to this machine's own LAN address sees the app arrive from it.
  expect(desktopOwnerProofOf(loopback(proof, "192.168.1.20"), ["192.168.1.20"])).toBe(
    "proof-value",
  );
  expect(desktopOwnerProofOf(loopback(proof, "192.168.1.21"), ["192.168.1.20"])).toBeUndefined();
  for (const forwarded of [
    { "x-forwarded-for": "203.0.113.9" },
    { "x-forwarded-proto": "https" },
    { "x-forwarded-host": "box.example.ts.net" },
    { forwarded: "for=203.0.113.9" },
    { "x-real-ip": "203.0.113.9" },
    { "tailscale-user-login": "person@example.test" },
    { "cf-connecting-ip": "203.0.113.9" },
    { "cf-ray": "abc" },
  ])
    expect(desktopOwnerProofOf(loopback({ ...proof, ...forwarded }))).toBeUndefined();
  expect(
    desktopOwnerProofOf(loopback({ ...proof, host: "prod-0123456789abcdef.spec-weave.com" })),
  ).toBeUndefined();
  // Nothing this long was ever minted.
  expect(
    desktopOwnerProofOf(loopback({ [DESKTOP_OWNER_PROOF_HEADER]: "x".repeat(4096) })),
  ).toBeUndefined();
});

it("matches the proof against its stored hash", () => {
  const verifier = new Uint8Array(createHash("sha256").update("right-proof").digest());
  expect(desktopOwnerProofMatches("right-proof", verifier)).toBe(true);
  expect(desktopOwnerProofMatches("wrong-proof", verifier)).toBe(false);
  expect(desktopOwnerProofMatches("right-proof", new Uint8Array(3))).toBe(false);
});
