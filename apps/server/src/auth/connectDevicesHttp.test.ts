// @effect-diagnostics-next-line nodeBuiltinImport:off - hashes a fixture the way the app does.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a real socket, so the peer is real.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@specweave-studio/contracts";
import { DESKTOP_OWNER_PROOF_HEADER } from "@specweave-studio/shared/httpObservability";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { deviceApprover, layer as connectDevicesLayer } from "./connectDevicesHttp.ts";
import { desktopOwnerProofMatches, desktopOwnerProofOf, isMachineOwner } from "./deviceApprover.ts";
import * as DeviceSignInHttp from "./deviceSignInHttp.ts";
import { makeTestDpopKey, type TestDpopKey } from "./dpopProof.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

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

// Later over HTTP (1447). The wiring is the one deviceApproval.test.ts uses for the other routes.

const layerMachine = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-device-later-" })),
    Layer.provideMerge(NodeServices.layer),
  );

class DeviceControlApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.connectDevices)
  .add(EnvironmentHttpApi.groups.deviceSignIn) {}

/** The real routes on a real loopback socket of a private test machine. */
const layerDeviceControl = () =>
  HttpRouter.serve(
    HttpApiBuilder.layer(DeviceControlApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(connectDevicesLayer),
      Layer.provide(DeviceSignInHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(layerMachine()),
    Layer.provideMerge(
      NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
    ),
  );

interface Wire {
  readonly base: string;
  readonly post: (
    path: string,
    body: object,
    headers?: Record<string, string>,
  ) => Effect.Effect<{ readonly status: number; readonly text: string }>;
  readonly exchange: (credential: string) => Effect.Effect<string>;
}

const makeWire = Effect.gen(function* () {
  const address = (yield* HttpServer.HttpServer).address;
  if (!("port" in address)) throw new Error("expected a TCP test server");
  const base = `http://127.0.0.1:${address.port}`;
  const post: Wire["post"] = (path, body, headers = {}) =>
    Effect.promise(async () => {
      // @effect-diagnostics-next-line globalFetchInEffect:off -- a real client on a real socket.
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    });
  const exchange: Wire["exchange"] = (credential) =>
    Effect.promise(async () => {
      // @effect-diagnostics-next-line globalFetchInEffect:off -- a real client on a real socket.
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          client_label: "Test client",
          client_device_type: "desktop",
        }),
      });
      const result = (await response.json()) as { readonly access_token?: string };
      if (result.access_token === undefined) throw new Error(`exchange: ${response.status}`);
      return result.access_token;
    });
  return { base, post, exchange } satisfies Wire;
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const CONNECT_HOST = "prod-0123456789abcdef.spec-weave.com";

/** A signed request as it reaches the server over Connect, behind its https proxy. */
const dpopRequest = (key: TestDpopKey, token: string, path = "/api/auth/session") =>
  HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1${path}`, {
      headers: {
        host: CONNECT_HOST,
        "x-forwarded-proto": "https",
        "cf-connecting-ip": "203.0.113.9",
        authorization: `DPoP ${token}`,
        dpop: key.proof({
          method: "GET",
          url: `https://${CONNECT_HOST}${path}`,
          accessToken: token,
        }),
      },
    }),
  );

const isInvalidCredential = Schema.is(EnvironmentAuth.ServerAuthInvalidCredentialError);
const asInvalidCredential = (error: unknown) => {
  if (!isInvalidCredential(error))
    throw new Error("expected an invalid credential refusal");
  return error;
};

/** A new phone waiting on this machine, and the code it shows. */
const waitingPhone = (label = "Waiting phone") =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const key = makeTestDpopKey();
    const session = yield* auth.issueSession({
      subject: "cloud-connect",
      proofKeyThumbprint: key.thumbprint,
      scopes: AuthStandardClientScopes,
      label,
    });
    const code = asInvalidCredential(
      yield* auth.authenticateHttpRequest(dpopRequest(key, session.token)).pipe(Effect.flip),
    ).deviceApprovalCode!;
    return { key, session, code };
  });

/** This machine's owner, through the startup link: an approver that is no listed device. */
const ownerHeaders = (wire: Wire) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return bearer(yield* wire.exchange((yield* auth.issueStartupPairingCredential()).credential));
  });

interface Listed {
  readonly devices: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly pending: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly device: string;
  }>;
  readonly later?: ReadonlyArray<string>;
}

const LATER = "/api/auth/connect-devices/later";

const listed = (wire: Wire, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const list = yield* wire.post("/api/auth/connect-devices/list", {}, headers);
    expect(list.status).toBe(200);
    return { text: list.text, snapshot: JSON.parse(list.text) as Listed };
  });

it.live("Later puts a waiting device off for every window and changes no access (1447)", () =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    yield* trust.snapshot;
    const wire = yield* makeWire;
    const owner = yield* ownerHeaders(wire);
    const phone = yield* waitingPhone("Waiting phone");
    const waiting = (yield* trust.snapshot).pending[0]!;
    expect((yield* listed(wire, owner)).snapshot.later).toEqual([]);

    const later = yield* wire.post(LATER, { requests: [waiting.id] }, owner);
    expect(later.status).toBe(200);
    expect(JSON.parse(later.text)).toEqual({ done: true });
    expect(later.text).not.toContain(phone.code);

    // Hidden, not denied: the request still waits, and nothing was approved.
    const after = yield* listed(wire, owner);
    expect(after.text).not.toContain(phone.code);
    expect(after.snapshot.later).toEqual([waiting.device]);
    expect(after.snapshot.pending.map((entry) => entry.id)).toEqual([waiting.id]);
    expect(after.snapshot.devices).toEqual([]);
    expect(
      yield* trust.isApproved(ConnectDeviceTrust.deviceKeyOfThumbprint(phone.key.thumbprint)),
    ).toBe(false);
    expect(
      yield* trust.isTurnedAway(ConnectDeviceTrust.deviceKeyOfThumbprint(phone.key.thumbprint)),
    ).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerDeviceControl())),
);

it.live("Later is refused for a session that may not approve, and keeps nothing", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    yield* trust.snapshot;
    const wire = yield* makeWire;
    const { code } = yield* waitingPhone();
    const requestId = (yield* trust.snapshot).pending[0]!.id;

    // A pair token exchanged for a bearer, and a session issued on the command line.
    const link = yield* auth.createPairingLink({
      subject: "one-time-token",
      scopes: AuthAdministrativeScopes,
      ttl: Duration.minutes(2),
    });
    const paired = yield* wire.exchange(link.credential);
    const issued = yield* auth.issueSession({ scopes: AuthAdministrativeScopes });
    for (const token of [paired, issued.token]) {
      const refused = yield* wire.post(LATER, { requests: [requestId] }, bearer(token));
      expect(refused.status).toBe(403);
      expect(refused.text).not.toContain(code);
    }

    const snapshot = yield* trust.snapshot;
    expect(snapshot.later).toEqual([]);
    expect(snapshot.pending.map((entry) => entry.id)).toEqual([requestId]);
  }).pipe(Effect.scoped, Effect.provide(layerDeviceControl())),
);

it.live("Later for a request that is not waiting answers done and keeps nothing", () =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    yield* trust.snapshot;
    const wire = yield* makeWire;
    const owner = yield* ownerHeaders(wire);
    yield* waitingPhone();
    const waiting = (yield* trust.snapshot).pending[0]!;

    // By request only: the device's own reference puts nothing off either.
    for (const requests of [["not-a-waiting-request"], [waiting.device], []]) {
      const answer = yield* wire.post(LATER, { requests }, owner);
      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.text)).toEqual({ done: true });
    }

    const snapshot = yield* trust.snapshot;
    expect(snapshot.later).toEqual([]);
    expect(snapshot.pending.map((entry) => entry.id)).toEqual([waiting.id]);
  }).pipe(Effect.scoped, Effect.provide(layerDeviceControl())),
);

it.live("Later takes 20 requests of 128 characters at most, and no other key", () =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    yield* trust.snapshot;
    const wire = yield* makeWire;
    const owner = yield* ownerHeaders(wire);
    yield* waitingPhone();
    const waiting = (yield* trust.snapshot).pending[0]!;
    const fill = (count: number) => Array.from({ length: count }, (_, index) => `request-${index}`);

    // Each carries the waiting request, so a body let through would be kept.
    for (const body of [
      { requests: [waiting.id, ...fill(20)] },
      { requests: [waiting.id, "x".repeat(129)] },
      { requests: [waiting.id], device: waiting.device },
      { requests: waiting.id },
      {},
    ]) {
      expect((yield* wire.post(LATER, body, owner)).status).toBe(400);
      expect((yield* trust.snapshot).later).toEqual([]);
    }

    // At the limits it is kept.
    const most = yield* wire.post(
      LATER,
      { requests: [waiting.id, "x".repeat(128), ...fill(18)] },
      owner,
    );
    expect(most.status).toBe(200);
    expect((yield* trust.snapshot).later).toEqual([waiting.device]);
  }).pipe(Effect.scoped, Effect.provide(layerDeviceControl())),
);

it.live("Allow and Deny end Later for that device only", () =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    yield* trust.snapshot;
    const wire = yield* makeWire;
    const owner = yield* ownerHeaders(wire);
    const allowed = yield* waitingPhone("Phone to allow");
    const denied = yield* waitingPhone("Phone to deny");
    const kept = yield* waitingPhone("Phone left waiting");
    const pending = (yield* trust.snapshot).pending;
    const waitingAs = (label: string) => pending.find((entry) => entry.label === label)!;
    const toAllow = waitingAs("Phone to allow");
    const toDeny = waitingAs("Phone to deny");
    const toKeep = waitingAs("Phone left waiting");

    const later = yield* wire.post(LATER, { requests: [toAllow.id, toDeny.id, toKeep.id] }, owner);
    expect(later.status).toBe(200);
    expect((yield* listed(wire, owner)).snapshot.later!.toSorted()).toEqual(
      [toAllow.device, toDeny.device, toKeep.device].toSorted(),
    );

    const approve = yield* wire.post(
      "/api/auth/connect-devices/approve",
      { code: allowed.code },
      owner,
    );
    expect(JSON.parse(approve.text)).toMatchObject({
      status: "approved",
      device: { label: "Phone to allow" },
    });
    expect(approve.text).not.toContain(allowed.code);
    expect((yield* listed(wire, owner)).snapshot.later!.toSorted()).toEqual(
      [toDeny.device, toKeep.device].toSorted(),
    );

    const deny = yield* wire.post(
      "/api/auth/connect-devices/deny",
      { requestId: toDeny.id },
      owner,
    );
    expect(JSON.parse(deny.text)).toEqual({ denied: true });
    const after = yield* listed(wire, owner);
    expect(after.snapshot.later).toEqual([toKeep.device]);
    expect(after.snapshot.pending.map((entry) => entry.id)).toEqual([toKeep.id]);
    expect(after.snapshot.devices.map((device) => device.label)).toEqual(["Phone to allow"]);
    for (const code of [allowed.code, denied.code, kept.code])
      expect(after.text).not.toContain(code);
  }).pipe(Effect.scoped, Effect.provide(layerDeviceControl())),
);
