import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Config from "../config.ts";
import * as Auth from "./EnvironmentAuth.ts";
import * as DeviceSignInHttp from "./deviceSignInHttp.ts";
import * as AuthHttp from "./http.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.deviceSignIn) {}

const ORIGIN = "http://localhost:8319";
const SESSIONS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer owner": AuthAdministrativeScopes,
  "Bearer reader": [AuthOrchestrationReadScope],
};

async function api(options: { readonly desktopOnly?: boolean } = {}) {
  const issued: Array<{ scopes: ReadonlyArray<AuthEnvironmentScope>; subject?: string }> = [];
  const revoked: Array<string> = [];
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(DeviceSignInHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: (request) => {
          const scopes = SESSIONS[request.headers.authorization ?? ""];
          return scopes
            ? Effect.succeed({
                sessionId: AuthSessionId.make("synthetic-session"),
                subject: "fixture",
                method: "bearer-access-token" as const,
                scopes,
              })
            : Effect.fail(new Auth.ServerAuthMissingCredentialError({}));
        },
        createPairingLink: (input) =>
          Effect.sync(() => {
            issued.push({
              scopes: input?.scopes ?? [],
              ...(input?.subject ? { subject: input.subject } : {}),
            });
            const now = DateTime.makeUnsafe(Date.now());
            return {
              id: `link-${issued.length}`,
              credential: `ONE-TIME-${issued.length}`,
              scopes: input?.scopes ?? [],
              subject: input?.subject ?? "one-time-token",
              createdAt: now,
              expiresAt: DateTime.add(now, { minutes: 2 }),
            };
          }),
        revokePairingLink: (id) => Effect.sync(() => (revoked.push(id), true)),
        getDescriptor: () =>
          Effect.succeed({
            policy: options.desktopOnly ? "desktop-managed-local" : "loopback-browser",
            bootstrapMethods: options.desktopOnly ? ["desktop-bootstrap"] : ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
            serverUpdateScope: AuthAdministrativeScopes[0]!,
          } as never),
      }),
    ),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "device-sign-in-http-" })),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const call = (
    path: string,
    body: object | undefined,
    headers: Record<string, string> = { origin: ORIGIN },
  ) =>
    handler(
      new Request(`${ORIGIN}/api/auth/device-sign-in/${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const owner = { authorization: "Bearer owner", origin: ORIGIN };
  return { call, owner, issued, revoked, dispose };
}

describe("device sign-in HTTP", () => {
  it("lets an owner who types the code approve a waiting browser, which then collects a standard one-time credential", async () => {
    const app = await api();
    try {
      const start = await app.call(
        "start",
        {},
        {
          origin: ORIGIN,
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1",
        },
      );
      expect(start.status).toBe(200);
      const started = (await start.json()) as {
        requestId: string;
        pollToken: string;
        code: string;
      };
      expect(start.headers.get("cache-control")).toBe("no-store");

      const pendingPoll = await app.call("poll", {
        requestId: started.requestId,
        pollToken: started.pollToken,
      });
      expect(await pendingPoll.json()).toEqual({ status: "pending" });

      const wrong = started.code === "222222" ? "333333" : "222222";
      expect(
        await (await app.call("approve", { code: wrong, confirm: false }, app.owner)).json(),
      ).toEqual({
        status: "not-found",
      });
      expect(app.issued).toEqual([]);

      const typed = `${started.code.slice(0, 3)}-${started.code.slice(3).toLowerCase()}`;
      const looked = await app.call("approve", { code: typed, confirm: false }, app.owner);
      expect(await looked.json()).toEqual({
        status: "found",
        device: expect.objectContaining({ deviceType: "mobile", browser: "Safari", os: "iOS" }),
      });
      expect(app.issued).toEqual([]);
      const approve = await app.call("approve", { code: typed, confirm: true }, app.owner);
      expect(await approve.json()).toEqual({
        status: "approved",
        device: expect.objectContaining({ deviceType: "mobile", browser: "Safari", os: "iOS" }),
      });
      expect(app.issued).toEqual([
        { scopes: AuthStandardClientScopes, subject: "device-approval" },
      ]);
      expect(app.issued[0]?.scopes).not.toContain(AuthAccessWriteScope);

      const approved = await app.call("poll", {
        requestId: started.requestId,
        pollToken: started.pollToken,
      });
      expect(await approved.json()).toEqual({ status: "approved", credential: "ONE-TIME-1" });
      const again = await app.call("poll", {
        requestId: started.requestId,
        pollToken: started.pollToken,
      });
      expect(await again.json()).toEqual({ status: "expired" });
      expect(
        await (await app.call("approve", { code: started.code, confirm: true }, app.owner)).json(),
      ).toEqual({
        status: "not-found",
      });
    } finally {
      await app.dispose();
    }
  });

  it("refuses cross-site pages, rebinding hosts and sessions without access:write", async () => {
    const app = await api();
    try {
      expect((await app.call("start", {}, { origin: "https://evil.invalid" })).status).toBe(403);
      expect(
        (await app.call("start", {}, { origin: ORIGIN, "sec-fetch-site": "cross-site" })).status,
      ).toBe(403);
      expect((await app.call("start", {}, {})).status).toBe(403);
      expect((await app.call("start", { label: "x" })).status).toBe(400);
      // A DNS-rebinding page sends its own domain as both Origin and Host.
      expect(
        (
          await app.call(
            "start",
            {},
            { origin: "http://rebind.example.com:8319", host: "rebind.example.com:8319" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.call(
            "start",
            {},
            {
              origin: "https://m4.tail1234.ts.net",
              host: "m4.tail1234.ts.net",
              "x-forwarded-proto": "https",
            },
          )
        ).status,
      ).toBe(200);

      const started = (await (await app.call("start", {})).json()) as {
        requestId: string;
        pollToken: string;
        code: string;
      };
      expect(
        (
          await app.call(
            "poll",
            { requestId: started.requestId, pollToken: started.pollToken },
            { origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect(
        (await app.call("approve", { code: started.code, confirm: true }, { origin: ORIGIN }))
          .status,
      ).toBe(401);
      expect(
        (
          await app.call(
            "approve",
            { code: started.code, confirm: true },
            { authorization: "Bearer reader", origin: ORIGIN },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.call(
            "approve",
            { code: started.code, confirm: true },
            { authorization: "Bearer owner", origin: "https://evil.invalid" },
          )
        ).status,
      ).toBe(403);
      expect((await app.call("approve", { code: "x", confirm: true }, app.owner)).status).toBe(400);
      expect(app.issued).toEqual([]);
      expect(
        await (
          await app.call("poll", { requestId: started.requestId, pollToken: started.pollToken })
        ).json(),
      ).toEqual({ status: "pending" });
    } finally {
      await app.dispose();
    }
  });

  it("caps waiting requests from one address", async () => {
    const app = await api();
    try {
      for (let index = 0; index < 3; index += 1)
        expect((await app.call("start", {})).status).toBe(200);
      expect((await app.call("start", {})).status).toBe(409);
    } finally {
      await app.dispose();
    }
  });

  it("refuses to start when the machine only accepts its own desktop app", async () => {
    const app = await api({ desktopOnly: true });
    try {
      expect((await app.call("start", {})).status).toBe(403);
    } finally {
      await app.dispose();
    }
  });
});

describe("device sign-in request checks", () => {
  it("trusts a forwarded client address only from a local proxy", () => {
    // A client-supplied entry sits to the left of the one the proxy appended.
    expect(DeviceSignInHttp.deviceSignInSource("127.0.0.1", "6.6.6.6, 100.64.0.9")).toBe(
      "100.64.0.9",
    );
    expect(DeviceSignInHttp.deviceSignInSource("::1", "100.64.0.9")).toBe("100.64.0.9");
    expect(DeviceSignInHttp.deviceSignInSource("192.168.1.20", "1.2.3.4")).toBe("192.168.1.20");
    expect(DeviceSignInHttp.deviceSignInSource("127.0.0.1", undefined)).toBe("127.0.0.1");
  });

  it("accepts hosts no public DNS name can fake", () => {
    const allowed = (host: string, trusted: ReadonlyArray<string> = []) =>
      DeviceSignInHttp.deviceSignInHostAllowed(host, trusted);
    expect(allowed("localhost:8319")).toBe(true);
    expect(allowed("studio.localhost:8319")).toBe(true);
    expect(allowed("192.168.1.20:8319")).toBe(true);
    expect(allowed("[fd7a:115c:a1e0::1]:8319")).toBe(true);
    expect(allowed("m4")).toBe(true);
    expect(allowed("m4.local:8319")).toBe(true);
    expect(allowed("m4.tail1234.ts.net")).toBe(true);
    expect(allowed("rebind.example.com:8319")).toBe(false);
    expect(allowed("studio.example.com", ["https://studio.example.com"])).toBe(true);
    expect(allowed("")).toBe(false);
  });
});
