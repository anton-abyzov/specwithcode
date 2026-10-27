import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
  type MachineNicknames,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";

import * as Auth from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MachineNicknameSync from "./MachineNicknameSync.ts";

const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer fleet-management": AuthStandardClientScopes,
  "Bearer read-only": [AuthOrchestrationReadScope],
};

const M4 = "env-m4";
const MINI = "env-mini";

const loadSettings = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* ServerSettings.ServerSettingsService;
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  );

/** One SpecWithCode server: its settings and its real nickname route behind a web handler. */
async function server(url: string, environmentId: string) {
  const settings = await loadSettings();
  // Route handlers resolve services per request, so they must stay in the built context.
  const routes = MachineNicknameSync.routeLayer.pipe(
    Layer.provideMerge(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
    Layer.provideMerge(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: (request) => {
          const scopes = TOKENS[request.headers.authorization ?? ""];
          return scopes
            ? Effect.succeed({
                sessionId: AuthSessionId.make("fleet-session"),
                subject: "fleet",
                method: "bearer-access-token" as const,
                scopes,
              })
            : Effect.fail(new Auth.ServerAuthMissingCredentialError({}));
        },
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const store = MachineNicknameSync.settingsStore(settings);
  const rename = (environmentId: string, name: string, updatedAt: string) =>
    Effect.runPromise(
      settings.updateSettings({ machineNicknames: { [environmentId]: { name, updatedAt } } }),
    );
  const nicknames = () => Effect.runPromise(store.read);
  return { url, environmentId, handler, dispose, store, rename, nicknames };
}

type Server = Awaited<ReturnType<typeof server>>;

/** A fleet network: requests reach a server only while it is online. */
function network(servers: ReadonlyArray<Server>) {
  const offline = new Set<string>();
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    const target = servers.find((candidate) => href.startsWith(candidate.url));
    if (!target || offline.has(target.url)) throw new TypeError("fetch failed");
    // Each server answers as itself before any token is sent to it.
    if (new URL(href).pathname === "/.well-known/studio/environment")
      return Response.json({
        environmentId: target.environmentId,
        label: target.environmentId,
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.1.0-test",
        orchestrationProtocolVersion: 2,
        capabilities: { repositoryIdentity: true },
      });
    return target.handler(new Request(href, init));
  }) as typeof globalThis.fetch;
  return { fetcher, offline };
}

const sync = (
  from: Server,
  to: Server,
  fetcher: typeof globalThis.fetch,
  token = "fleet-management",
) =>
  Effect.runPromise(
    MachineNicknameSync.syncMachineNicknames({
      fetcher,
      peers: [
        {
          id: "peer",
          url: to.url,
          environmentId: EnvironmentId.make(to.environmentId),
          managementToken: token,
        },
      ],
      store: from.store,
    }),
  );

const names = (map: MachineNicknames) =>
  Object.fromEntries(Object.entries(map).map(([id, entry]) => [id, entry.name]));

describe("machine nickname sync", () => {
  it("a rename on one server reaches a paired server", async () => {
    const m4 = await server("https://m4.fixture.ts.net", M4);
    const mini = await server("https://mini.fixture.ts.net", MINI);
    try {
      const { fetcher } = network([m4, mini]);
      await m4.rename(MINI, "Mini 1", "2026-10-20T21:00:00.000Z");

      expect(await sync(m4, mini, fetcher)).toEqual(["peer"]);
      expect(names(await mini.nicknames())).toEqual({ [MINI]: "Mini 1" });
      expect(names(await m4.nicknames())).toEqual({ [MINI]: "Mini 1" });
    } finally {
      await Promise.all([m4.dispose(), mini.dispose()]);
    }
  });

  it("the paired server's renames come back on the same exchange, so one-way pairing converges", async () => {
    const m4 = await server("https://m4.fixture.ts.net", M4);
    const mini = await server("https://mini.fixture.ts.net", MINI);
    try {
      const { fetcher } = network([m4, mini]);
      await mini.rename(M4, "Desk", "2026-10-20T21:00:00.000Z");
      await m4.rename(MINI, "Mini 1", "2026-10-20T21:01:00.000Z");

      await sync(m4, mini, fetcher);
      const expected = { [M4]: "Desk", [MINI]: "Mini 1" };
      expect(names(await m4.nicknames())).toEqual(expected);
      expect(names(await mini.nicknames())).toEqual(expected);
    } finally {
      await Promise.all([m4.dispose(), mini.dispose()]);
    }
  });

  it("a rename made while the peer is offline applies when it reconnects", async () => {
    const m4 = await server("https://m4.fixture.ts.net", M4);
    const mini = await server("https://mini.fixture.ts.net", MINI);
    try {
      const { fetcher, offline } = network([m4, mini]);
      offline.add(mini.url);
      await m4.rename(MINI, "Mini 1", "2026-10-20T21:00:00.000Z");

      expect(await sync(m4, mini, fetcher)).toEqual([]);
      expect(await mini.nicknames()).toEqual({});

      offline.delete(mini.url);
      expect(await sync(m4, mini, fetcher)).toEqual(["peer"]);
      expect(names(await mini.nicknames())).toEqual({ [MINI]: "Mini 1" });
    } finally {
      await Promise.all([m4.dispose(), mini.dispose()]);
    }
  });

  it("conflicting renames resolve to the last writer on both servers", async () => {
    const m4 = await server("https://m4.fixture.ts.net", M4);
    const mini = await server("https://mini.fixture.ts.net", MINI);
    try {
      const { fetcher, offline } = network([m4, mini]);
      offline.add(mini.url);
      await m4.rename(MINI, "Older", "2026-10-20T21:00:00.000Z");
      await mini.rename(MINI, "Newer", "2026-10-20T21:05:00.000Z");
      offline.delete(mini.url);

      await sync(m4, mini, fetcher);
      expect(names(await m4.nicknames())).toEqual({ [MINI]: "Newer" });
      expect(names(await mini.nicknames())).toEqual({ [MINI]: "Newer" });

      // The older rename arriving again (a late retry) changes nothing.
      await sync(mini, m4, fetcher);
      expect(names(await m4.nicknames())).toEqual({ [MINI]: "Newer" });
    } finally {
      await Promise.all([m4.dispose(), mini.dispose()]);
    }
  });

  it("refuses callers without settings write and malformed maps", async () => {
    const mini = await server("https://mini.fixture.ts.net", MINI);
    try {
      const post = (authorization: string | undefined, body: unknown) =>
        mini.handler(
          new Request(`${mini.url}${MachineNicknameSync.MACHINE_NICKNAMES_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization ? { authorization } : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      const valid = { nicknames: { [MINI]: { name: "x", updatedAt: "2026-10-20T21:00:00.000Z" } } };

      expect((await post(undefined, valid)).status).toBe(401);
      expect((await post("Bearer read-only", valid)).status).toBe(403);
      expect(
        (
          await post("Bearer fleet-management", {
            nicknames: { [MINI]: { name: "seventeen chars!!", updatedAt: "now" } },
          })
        ).status,
      ).toBe(400);
      expect(await mini.nicknames()).toEqual({});
    } finally {
      await mini.dispose();
    }
  });
});
