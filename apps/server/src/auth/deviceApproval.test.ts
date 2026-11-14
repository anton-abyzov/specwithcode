import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@specweave-studio/contracts";
import { RpcScopeAuthorization } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import * as DeviceBoundTransfers from "../fleet/deviceBoundTransfers.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { countsAsCredentialGuess, countsAsDeviceRefusal } from "./CredentialFailureLimiter.ts";
import { makeTestDpopKey, type TestDpopKey } from "./dpopProof.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerMachine = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-device-gate-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const TAILNET_HOST = "box.example.ts.net";
const CONNECT_HOST = "prod-0123456789abcdef.spec-weave.com";

/** A request as it reaches the server behind its https proxy, on the tailnet or over Connect. */
const request = (
  path: string,
  headers: Record<string, string>,
  via: "tailnet" | "connect" = "connect",
) =>
  HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1${path}`, {
      headers: {
        host: via === "connect" ? CONNECT_HOST : TAILNET_HOST,
        "x-forwarded-proto": "https",
        ...(via === "connect" ? { "cf-connecting-ip": "203.0.113.9" } : {}),
        ...headers,
      },
    }),
  );

const dpopRequest = (key: TestDpopKey, token: string, path = "/api/auth/session") =>
  request(path, {
    authorization: `DPoP ${token}`,
    dpop: key.proof({ method: "GET", url: `https://${CONNECT_HOST}${path}`, accessToken: token }),
  });

const asInvalidCredential = (error: unknown) => {
  if (!Schema.is(EnvironmentAuth.ServerAuthInvalidCredentialError)(error))
    throw new Error("expected an invalid credential refusal");
  return error;
};

const connectSession = (key: TestDpopKey, label = "New iPhone") =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.issueSession({
      subject: "cloud-connect",
      proofKeyThumbprint: key.thumbprint,
      scopes: AuthStandardClientScopes,
      label,
    });
  });

type Machine = Layer.Success<ReturnType<typeof layerMachine>> | Scope.Scope;

const withMachine = <A, E>(test: Effect.Effect<A, E, Machine>) =>
  Effect.scoped(
    Effect.gen(function* () {
      // DPoP proofs carry wall-clock time.
      // @effect-diagnostics-next-line globalDateInEffect:off
      yield* TestClock.setTime(Date.now());
      // The store is read at start, before any session exists here.
      yield* (yield* ConnectDeviceTrust.ConnectDeviceTrust).snapshot;
      return yield* test;
    }).pipe(Effect.provide(layerMachine())),
  );

it.effect(
  "an unapproved Connect device is refused on HTTP, WebSocket ticket and session state with its code",
  () =>
    withMachine(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
        const key = makeTestDpopKey();
        const session = yield* connectSession(key);

        const refused = yield* auth
          .authenticateHttpRequest(dpopRequest(key, session.token))
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "ServerAuthInvalidCredentialError",
          deviceRefusal: "device_not_approved",
        });
        const code = asInvalidCredential(refused).deviceApprovalCode!;
        expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
        expect(asInvalidCredential(refused).teamRulesMessage).toBe(
          `Open SpecWithCode on this machine and type this code: ${code}`,
        );
        // A waiting device is no credential guess, but it counts on its own budget.
        expect(countsAsCredentialGuess(refused)).toBe(false);
        expect(countsAsDeviceRefusal(refused)).toBe(true);

        expect(yield* auth.getSessionState(dpopRequest(key, session.token))).toMatchObject({
          authenticated: false,
          refusal: "device_not_approved",
          approvalCode: code,
          message: `Open SpecWithCode on this machine and type this code: ${code}`,
        });

        // The ticket session keeps the device key, so the gate still sees the device.
        const ticket = yield* auth.issueWebSocketTicket({ sessionId: session.sessionId });
        const viaTicket = yield* auth
          .authenticateWebSocketUpgrade(request(`/ws?wsTicket=${ticket.ticket}`, {}))
          .pipe(Effect.flip);
        expect(viaTicket).toMatchObject({ deviceRefusal: "device_not_approved" });

        // Its own code does not let the asking device approve itself.
        expect(
          yield* trust.approve({
            code,
            approvedBy: "New iPhone",
            approverKey: ConnectDeviceTrust.deviceKeyOfThumbprint(key.thumbprint),
          }),
        ).toEqual({ status: "self" });

        // Approved on the machine: the next attempt, with the same credential, gets in.
        expect(
          (yield* trust.approve({ code, approvedBy: "this machine", approverKey: null })).status,
        ).toBe("approved");
        const accepted = yield* auth.authenticateHttpRequest(dpopRequest(key, session.token));
        expect(accepted.proofKeyThumbprint).toBe(key.thumbprint);
        const ticketAgain = yield* auth.issueWebSocketTicket({ sessionId: session.sessionId });
        const socket = yield* auth.authenticateWebSocketUpgrade(
          request(`/ws?wsTicket=${ticketAgain.ticket}`, {}),
        );
        expect(socket.proofKeyThumbprint).toBe(key.thumbprint);
      }),
    ),
);

it.effect("worker grants, fleet tokens and local sessions pass, even with a damaged list", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.writeFileString(
        path.join(config.stateDir, "connect-devices.json"),
        "damaged",
      );
      // Built after the damage, as on the next start.
      const damaged = yield* ConnectDeviceTrust.make;
      const machine = yield* EnvironmentAuth.make.pipe(
        Effect.provideService(ConnectDeviceTrust.ConnectDeviceTrust, damaged),
      );

      const local = yield* auth.issueSession({ subject: "local-cli-owner" });
      expect(
        (yield* machine.authenticateHttpRequest(
          request("/api/x", { authorization: `Bearer ${local.token}` }, "tailnet"),
        )).subject,
      ).toBe("local-cli-owner");

      const fleet = yield* auth.issueSession({
        subject: EnvironmentAuth.FLEET_INVITATION_SUBJECT,
        principal: { kind: "coordinator", environmentId: "m5" as never },
      });
      expect(
        (yield* machine.authenticateHttpRequest(
          request("/api/x", { authorization: `Bearer ${fleet.token}` }, "tailnet"),
        )).subject,
      ).toBe(EnvironmentAuth.FLEET_INVITATION_SUBJECT);

      // A coordinator's worker grant over Connect (remote threads and MCP run on it).
      const workerKey = makeTestDpopKey();
      const grant = yield* auth.issueMcpClientSession({
        principal: { kind: "coordinator", environmentId: "m5" as never },
        label: "worker for m5",
        access: "auto",
        client: { deviceType: "bot" },
        proofKeyThumbprint: workerKey.thumbprint,
      });
      const mcp = yield* machine.authenticateMcpClient(
        request("/mcp", {
          authorization: `DPoP ${grant.token}`,
          dpop: workerKey.proof({
            method: "GET",
            url: `https://${CONNECT_HOST}/mcp`,
            accessToken: grant.token,
          }),
        }),
      );
      expect(mcp.access).toBe("auto");

      const phoneKey = makeTestDpopKey();
      const phone = yield* connectSession(phoneKey);
      const refused = yield* machine
        .authenticateHttpRequest(dpopRequest(phoneKey, phone.token))
        .pipe(Effect.flip);
      expect(asInvalidCredential(refused).teamRulesMessage).toContain("damaged");
    }),
  ),
);

it.effect("an approved phone and a worker grant keep working while a new phone waits", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const approvedKey = makeTestDpopKey();
      const approvedPhone = yield* connectSession(approvedKey, "Anton's iPhone");
      const code = yield* auth
        .authenticateHttpRequest(dpopRequest(approvedKey, approvedPhone.token))
        .pipe(Effect.flip)
        .pipe(Effect.map(asInvalidCredential));
      yield* trust.approve({
        code: code.deviceApprovalCode!,
        approvedBy: "this machine",
        approverKey: null,
      });

      // A hub-linked phone that carries no key here waits too, as its own device.
      const linked = yield* auth.issueSession({
        subject: "phone-link:hub-env:hub-session-2",
        principal: { kind: "device", id: "linked-ipad" },
        scopes: AuthStandardClientScopes,
        label: "iPad via m4",
      });
      const linkedRefused = yield* auth
        .authenticateHttpRequest(
          request("/api/x", { authorization: `Bearer ${linked.token}` }, "tailnet"),
        )
        .pipe(Effect.flip);
      expect(linkedRefused).toMatchObject({ deviceRefusal: "device_not_approved" });

      const newKey = makeTestDpopKey();
      const newPhone = yield* connectSession(newKey);
      expect(
        yield* auth.authenticateHttpRequest(dpopRequest(newKey, newPhone.token)).pipe(Effect.flip),
      ).toMatchObject({ deviceRefusal: "device_not_approved" });

      expect(
        (yield* auth.authenticateHttpRequest(dpopRequest(approvedKey, approvedPhone.token)))
          .subject,
      ).toBe("cloud-connect");
      const workerKey = makeTestDpopKey();
      const grant = yield* auth.issueMcpClientSession({
        principal: { kind: "coordinator", environmentId: "m5" as never },
        label: "worker for m5",
        access: "auto",
        client: { deviceType: "bot" },
        proofKeyThumbprint: workerKey.thumbprint,
      });
      expect(
        (yield* auth.authenticateMcpClient(
          request("/mcp", {
            authorization: `DPoP ${grant.token}`,
            dpop: workerKey.proof({
              method: "GET",
              url: `https://${CONNECT_HOST}/mcp`,
              accessToken: grant.token,
            }),
          }),
        )).label,
      ).toBe("worker for m5");
    }),
  ),
);

it.effect("a removed device's open socket ends within 10 seconds", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const keep = makeTestDpopKey();
      const drop = makeTestDpopKey();
      const sockets = [];
      for (const key of [keep, drop]) {
        const session = yield* connectSession(key);
        const refused = yield* auth
          .authenticateHttpRequest(dpopRequest(key, session.token))
          .pipe(Effect.flip)
          .pipe(Effect.map(asInvalidCredential));
        yield* trust.approve({
          code: refused.deviceApprovalCode!,
          approvedBy: "this machine",
          approverKey: null,
        });
        const open = yield* auth.authenticateHttpRequest(dpopRequest(key, session.token));
        const ended = yield* auth.watchSessionEnd(open);
        sockets.push(yield* Effect.forkChild(ended));
      }
      yield* trust.remove(ConnectDeviceTrust.deviceKeyOfThumbprint(drop.thumbprint));
      yield* TestClock.adjust("6 seconds");
      // Ends (the recheck writes the device's new request to disk first).
      yield* Fiber.join(sockets[1]!);
      // Only that device's socket: the other stays open.
      expect(sockets[0]!.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(sockets[0]!);
    }),
  ),
);

it.effect("a waiting phone's pairing code cannot approve an MCP client around the gate", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const phoneCode = (subject: string) =>
        auth
          .createPairingLink({
            subject,
            scopes: AuthStandardClientScopes,
            ttl: Duration.minutes(5),
          })
          .pipe(Effect.map((link) => link.credential));

      // A phone this machine never approved: its code approves nothing.
      const waiting = yield* auth
        .consumeMcpApprovalCode(yield* phoneCode("phone-link:hub-1:waiting"), "read-only")
        .pipe(Effect.flip);
      expect(waiting).toMatchObject({ reason: "device_not_approved" });

      // An approved phone may; the MCP session it approves stays that phone's.
      const approvedSubject = "phone-link:hub-1:approved";
      const code = asInvalidCredential(
        yield* auth
          .authenticateHttpRequest(
            request("/api/auth/session", {
              authorization: `Bearer ${(yield* auth.issueSession({ subject: approvedSubject, scopes: AuthStandardClientScopes })).token}`,
            }),
          )
          .pipe(Effect.flip),
      ).deviceApprovalCode!;
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      const approval = yield* auth.consumeMcpApprovalCode(
        yield* phoneCode(approvedSubject),
        "read-only",
      );
      expect(approval.deviceKey).toBe(`link:${approvedSubject}`);
      const mcp = yield* auth.issueMcpClientSession({
        ...approval,
        label: "Phone agent",
        access: "read-only",
        client: {},
      });
      const mcpRequest = request("/mcp", { authorization: `Bearer ${mcp.token}` }, "tailnet");
      expect((yield* auth.authenticateMcpClient(mcpRequest)).sessionId).toBe(mcp.sessionId);

      // Removing the phone stops the MCP client it approved.
      yield* trust.remove(`link:${approvedSubject}`);
      const removed = yield* auth.authenticateMcpClient(mcpRequest).pipe(Effect.flip);
      expect(removed).toMatchObject({ deviceRefusal: "device_not_approved" });
      // And a device that is not approved cannot be named as the approver.
      const refused = yield* auth
        .issueMcpClientSession({
          label: "Agent",
          access: "read-only",
          client: {},
          deviceKey: `link:${approvedSubject}`,
        })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("ServerAuthSessionTokenIssueError");
    }),
  ),
);

it.effect("a folder copy a device offered stops when that device is removed", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const operationId = "0f8b6a1c-2d3e-4f50-8a9b-0c1d2e3f4a5b";
      const path = `/${operationId}/hello`;
      // No device behind the request (this machine's own app): nothing is bound.
      expect(yield* DeviceBoundTransfers.bindOfferToRequestDevice(trust, operationId)).toBe(true);
      expect(yield* DeviceBoundTransfers.transferRefusedForDevice(trust, path)).toBe(false);

      const key = makeTestDpopKey();
      const session = yield* connectSession(key, "Laptop");
      const code = asInvalidCredential(
        yield* (yield* EnvironmentAuth.EnvironmentAuth)
          .authenticateHttpRequest(dpopRequest(key, session.token))
          .pipe(Effect.flip),
      ).deviceApprovalCode!;
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      const device = `jkt:${key.thumbprint}`;
      const offer = DeviceBoundTransfers.bindOfferToRequestDevice(trust, operationId).pipe(
        Effect.provideService(ConnectDeviceTrust.RequestDevice, device),
      );
      expect(yield* offer).toBe(true);
      expect(yield* DeviceBoundTransfers.transferRefusedForDevice(trust, path)).toBe(false);

      yield* trust.remove(device);
      expect(yield* DeviceBoundTransfers.transferRefusedForDevice(trust, path)).toBe(true);
      // A removed device cannot offer a new copy either.
      expect(yield* offer).toBe(false);
    }),
  ),
);

it.effect("each RPC on a device's connection knows that device", () =>
  Effect.gen(function* () {
    const middleware = yield* RpcScopeAuthorization.pipe(
      Effect.provide(RpcAuthorization.layer(AuthStandardClientScopes, undefined, "jkt:laptop")),
    );
    const seen = yield* middleware(ConnectDeviceTrust.RequestDevice, {
      rpc: { _tag: "server.getConfig" },
      payload: {},
    } as never);
    expect(seen).toBe("jkt:laptop");
  }),
);
