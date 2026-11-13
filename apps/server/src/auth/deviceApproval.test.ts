import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@specweave-studio/contracts";
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
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { countsAsCredentialGuess, countsAsDeviceRefusal } from "./CredentialFailureLimiter.ts";
import { makeTestDpopKey, type TestDpopKey } from "./dpopProof.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
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
      // The store's first read is the update's moment: nothing is live yet.
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
