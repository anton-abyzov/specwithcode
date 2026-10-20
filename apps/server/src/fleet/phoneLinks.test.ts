// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test reads the link file's mode and contents directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { join } from "../nodePath.ts";
import type { FleetConfig, FleetTarget } from "../studioFleet.ts";
import {
  buildPhoneRoster,
  isPhoneDevice,
  phoneCodeScopes,
  phoneLinkHubSession,
  phoneLinkSubject,
  phoneMintScopes,
  readPhoneLinkStore,
  recordPhoneMint,
  requestPhoneLinks,
  sweepPhoneLinks,
  syncPhoneLinksHere,
  unlinkPhonesFrom,
} from "./phoneLinks.ts";

const NOW = Date.parse("2026-10-20T18:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const HUB = { environmentId: EnvironmentId.make("env-m4"), label: "M4" };
const PHONE_SCOPES = new Set<string>([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);

const machine = (
  id: string,
  overrides: Partial<FleetTarget> & { readonly tokenless?: true } = {},
): FleetTarget => {
  const { tokenless, ...rest } = overrides;
  const target: FleetTarget = {
    id,
    label: id.toUpperCase(),
    environmentId: EnvironmentId.make(`env-${id}`),
    url: `https://${id}.example.ts.net`,
    managementToken: `management-${id}`,
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthAccessWriteScope],
    ...rest,
  };
  if (!tokenless) return target;
  const { managementToken: _dropped, ...withoutToken } = target;
  return withoutToken;
};
const fleet = (...machines: FleetTarget[]): FleetConfig => ({ version: 1, machines });

interface FakeLink {
  sessionId: string;
  hubSessionId: string;
  expiresAt: string;
}
interface FakePeer {
  /** What the machine says it is; another id means someone else answers its URL. */
  environmentId: string;
  online: boolean;
  mintStatus: number;
  mintExpiresAt: string;
  mintRoutes: Array<{ kind: string; httpBaseUrl: string }>;
  links: FakeLink[];
}
interface Call {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** Several machines behind one fetch, each with the phone endpoints a current server has. */
function fakeFleet(targets: ReadonlyArray<FleetTarget>) {
  const peers = new Map<string, FakePeer>();
  for (const target of targets)
    peers.set(new URL(target.url).origin, {
      environmentId: target.environmentId,
      online: true,
      mintStatus: 200,
      mintExpiresAt: iso(NOW + 600_000),
      mintRoutes: [{ kind: "lan", httpBaseUrl: `http://192.168.1.${peers.size + 10}:8319` }],
      links: [],
    });
  const calls: Call[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: url.toString(), authorization: headers.get("authorization"), body });
    const peer = peers.get(url.origin);
    if (!peer || !peer.online) throw new TypeError("fetch failed");
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    switch (url.pathname) {
      case "/.well-known/studio/environment":
        return json(200, {
          environmentId: peer.environmentId,
          label: "Peer",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "1.0.63",
          capabilities: { repositoryIdentity: true },
        });
      case "/api/studio/fleet/phone/mint":
        if (peer.mintStatus !== 200) return json(peer.mintStatus, {});
        return json(200, {
          code: `CODE-${peer.environmentId}`,
          expiresAt: peer.mintExpiresAt,
          routes: peer.mintRoutes,
        });
      case "/api/studio/fleet/phone/links": {
        const active = new Set<string>(body.activeHubSessionIds);
        const kept = peer.links.filter((link) => active.has(link.hubSessionId));
        const revoked = peer.links.length - kept.length;
        peer.links = kept;
        return json(200, { links: kept, revoked });
      }
      default:
        return json(404, {});
    }
  }) as typeof fetch;
  const peer = (target: FleetTarget) => peers.get(new URL(target.url).origin)!;
  const posts = (path: string) => calls.filter((call) => new URL(call.url).pathname === path);
  return { fetcher, calls, peer, posts };
}

let stateDir: string;
beforeEach(async () => {
  stateDir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "phone-links-"));
});
afterEach(async () => {
  await NodeFSP.rm(stateDir, { recursive: true, force: true });
});

describe("phone link scopes and subjects", () => {
  it("gives a phone code only distinct client scopes the asking machine holds, with read access", () => {
    const caller = new Set<string>([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthAccessWriteScope,
    ]);
    expect(phoneCodeScopes([AuthOrchestrationReadScope], caller)).toEqual([
      AuthOrchestrationReadScope,
    ]);
    expect(phoneCodeScopes([], caller)).toBeNull();
    expect(phoneCodeScopes([AuthOrchestrationReadScope, AuthOrchestrationReadScope], caller)).toBe(
      null,
    );
    // Access management is never a phone scope, even when the asking machine holds it.
    expect(phoneCodeScopes([AuthOrchestrationReadScope, AuthAccessWriteScope], caller)).toBeNull();
    expect(phoneCodeScopes([AuthOrchestrationOperateScope], caller)).toBeNull();
    expect(
      phoneCodeScopes(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        new Set([AuthOrchestrationReadScope]),
      ),
    ).toBeNull();
  });

  it("asks a machine only for what the phone holds here and the machine allows", () => {
    expect(
      phoneMintScopes(PHONE_SCOPES, machine("minis", { scopes: [AuthOrchestrationReadScope] })),
    ).toEqual([AuthOrchestrationReadScope]);
    expect(phoneMintScopes(new Set([AuthOrchestrationReadScope]), machine("minis"))).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });

  it("reads the hub session back only from that hub's subjects", () => {
    const subject = phoneLinkSubject("env-m4", "session-1");
    expect(phoneLinkHubSession(subject, "env-m4")).toBe("session-1");
    expect(phoneLinkHubSession(subject, "env-m3")).toBeNull();
    expect(phoneLinkHubSession("phone-link:env-m4:", "env-m4")).toBeNull();
    expect(phoneLinkHubSession("owner", "env-m4")).toBeNull();
    expect(isPhoneDevice("mobile")).toBe(true);
    expect(isPhoneDevice("tablet")).toBe(true);
    expect(isPhoneDevice("desktop")).toBe(false);
    expect(isPhoneDevice(undefined)).toBe(false);
  });
});

describe("the roster a phone gets from its hub", () => {
  const roster = (
    config: FleetConfig | null,
    fetcher: typeof fetch,
    mint: ReadonlyArray<string> = [],
    minted: string[] = [],
  ) =>
    buildPhoneRoster({
      config,
      fetcher,
      hub: HUB,
      phone: { sessionId: "phone-session", label: "Anton's iPhone", scopes: PHONE_SCOPES },
      mint: new Set(mint),
      recordMint: async (environmentId) => {
        minted.push(environmentId);
      },
      now: NOW,
    });

  it("lists every other machine once, leaving out the hub, and mints only where asked", async () => {
    const minis = machine("minis");
    const m3 = machine("m3");
    const self = machine("m4", { environmentId: HUB.environmentId });
    const { fetcher, posts } = fakeFleet([minis, m3, self]);
    const minted: string[] = [];
    const result = await roster(
      fleet(minis, m3, self, { ...minis, id: "again" }),
      fetcher,
      ["env-minis"],
      minted,
    );
    expect(result.hub).toEqual({ environmentId: "env-m4", label: "M4" });
    expect(result.machines.map((entry) => entry.environmentId)).toEqual(["env-minis", "env-m3"]);
    const [first, second] = result.machines;
    expect(first?.pairing).toEqual({ code: "CODE-env-minis", expiresAt: iso(NOW + 600_000) });
    expect(first?.routes).toEqual([
      { kind: "fleet", httpBaseUrl: "https://minis.example.ts.net" },
      { kind: "lan", httpBaseUrl: "http://192.168.1.10:8319" },
    ]);
    expect(second?.pairing).toBeUndefined();
    expect(second?.problem).toBeUndefined();
    expect(minted).toEqual(["env-minis"]);
    const mint = posts("/api/studio/fleet/phone/mint");
    expect(mint).toHaveLength(1);
    expect(mint[0]?.authorization).toBe("Bearer management-minis");
    expect(mint[0]?.body).toEqual({
      hubEnvironmentId: "env-m4",
      hubSessionId: "phone-session",
      label: "Anton's iPhone via M4",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    });
  });

  it("keeps an unreachable machine listed with its problem", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    peer(minis).online = false;
    const result = await roster(fleet(minis), fetcher, ["env-minis"]);
    expect(result.machines).toEqual([
      {
        environmentId: "env-minis",
        label: "MINIS",
        routes: [{ kind: "fleet", httpBaseUrl: "https://minis.example.ts.net" }],
        problem: "unreachable",
      },
    ]);
  });

  it("never sends the management token to a machine answering with another identity", async () => {
    const minis = machine("minis");
    const { fetcher, peer, posts } = fakeFleet([minis]);
    peer(minis).environmentId = "env-somebody-else";
    const result = await roster(fleet(minis), fetcher, ["env-minis"]);
    expect(result.machines[0]?.problem).toBe("identity_mismatch");
    expect(posts("/api/studio/fleet/phone/mint")).toHaveLength(0);
  });

  it("names an older machine without the phone mint as needing the update", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    peer(minis).mintStatus = 404;
    const result = await roster(fleet(minis), fetcher, ["env-minis"]);
    expect(result.machines[0]?.problem).toBe("update_required");
    expect(result.machines[0]?.pairing).toBeUndefined();
  });

  it("refuses a code it cannot use: no read scope, no token, expired or refused", async () => {
    const readless = machine("minis", { scopes: [AuthOrchestrationOperateScope] });
    const tokenless = machine("m3", { tokenless: true });
    const expired = machine("m1");
    const refused = machine("m2");
    const { fetcher, peer, posts } = fakeFleet([readless, tokenless, expired, refused]);
    peer(expired).mintExpiresAt = iso(NOW - 1);
    peer(refused).mintStatus = 403;
    const minted: string[] = [];
    const result = await roster(
      fleet(readless, tokenless, expired, refused),
      fetcher,
      ["env-minis", "env-m3", "env-m1", "env-m2"],
      minted,
    );
    expect(result.machines.map((entry) => entry.problem)).toEqual([
      "pairing_unavailable",
      "pairing_unavailable",
      "pairing_unavailable",
      "pairing_unavailable",
    ]);
    expect(posts("/api/studio/fleet/phone/mint").map((call) => call.url)).toEqual([
      "https://m1.example.ts.net/api/studio/fleet/phone/mint",
      "https://m2.example.ts.net/api/studio/fleet/phone/mint",
    ]);
    expect(minted).toEqual([]);
  });

  it("drops a returned route that carries credentials or a query", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    peer(minis).mintRoutes = [
      { kind: "lan", httpBaseUrl: "http://user:secret@192.168.1.10:8319" },
      { kind: "tailnet", httpBaseUrl: "https://minis.tail.ts.net?token=x" },
      { kind: "tailnet", httpBaseUrl: "https://minis.tail.ts.net" },
    ];
    const result = await roster(fleet(minis), fetcher, ["env-minis"]);
    expect(result.machines[0]?.routes.map((route) => route.httpBaseUrl)).toEqual([
      "https://minis.example.ts.net",
      "https://minis.tail.ts.net",
    ]);
  });

  it("answers with no machines when there is no fleet", async () => {
    const { fetcher } = fakeFleet([]);
    expect(await roster(null, fetcher)).toEqual({ hub: HUB, machines: [] });
  });
});

describe("a machine answering the hub about its phone links", () => {
  const session = (sessionId: string, subject: string) => ({
    sessionId: AuthSessionId.make(sessionId),
    subject,
    expiresAt: DateTime.makeUnsafe(NOW + 86_400_000),
  });
  const run = (
    sessions: ReadonlyArray<ReturnType<typeof session>>,
    activeHubSessionIds: ReadonlyArray<string>,
  ) => {
    const revoked: string[] = [];
    const auth = {
      listSessions: () => Effect.succeed(sessions),
      revokeSession: (sessionId: string) =>
        Effect.sync(() => {
          revoked.push(sessionId);
          return true;
        }),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
    return syncPhoneLinksHere({ hubEnvironmentId: "env-m4", activeHubSessionIds }).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, auth),
      Effect.map((result) => ({ result, revoked })),
    );
  };

  effectIt.effect("revokes only that hub's links whose hub session ended, and lists the rest", () =>
    Effect.gen(function* () {
      const { result, revoked } = yield* run(
        [
          session("kept", phoneLinkSubject("env-m4", "hub-a")),
          session("ended", phoneLinkSubject("env-m4", "hub-b")),
          session("other-hub", phoneLinkSubject("env-m3", "hub-b")),
          session("owner", "owner"),
        ],
        ["hub-a"],
      );
      expect(revoked).toEqual(["ended"]);
      expect(result).toEqual({
        links: [{ sessionId: "kept", hubSessionId: "hub-a", expiresAt: iso(NOW + 86_400_000) }],
        revoked: 1,
      });
    }),
  );

  effectIt.effect("revokes every link from that hub when it has no active phone", () =>
    Effect.gen(function* () {
      const { result, revoked } = yield* run(
        [
          session("a", phoneLinkSubject("env-m4", "hub-a")),
          session("b", phoneLinkSubject("env-m4", "hub-b")),
        ],
        [],
      );
      expect(revoked).toEqual(["a", "b"]);
      expect(result).toEqual({ links: [], revoked: 2 });
    }),
  );
});

describe("the hub's sweep carries a phone revocation to every machine", () => {
  const sweep = (input: {
    config: FleetConfig;
    fetcher: typeof fetch;
    active: Set<string> | null;
    revokedHere?: string[];
    now?: number;
  }) =>
    sweepPhoneLinks({
      stateDir,
      config: input.config,
      fetcher: input.fetcher,
      hubEnvironmentId: "env-m4",
      activePhoneSessions: async () => input.active,
      revokeHubSession: async (sessionId) => {
        input.active?.delete(sessionId);
        input.revokedHere?.push(sessionId);
        return true;
      },
      now: input.now ?? NOW,
    });

  it("does nothing, and asks no machine, before any phone was linked", async () => {
    const minis = machine("minis");
    const { fetcher, calls } = fakeFleet([minis]);
    expect(await sweep({ config: fleet(minis), fetcher, active: new Set(["hub-a"]) })).toEqual({
      revokedHere: 0,
      revokedThere: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("learns a redeemed link from a pending mint, then revokes it there when the phone is revoked here", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    peer(minis).links = [
      { sessionId: "minis-1", hubSessionId: "hub-a", expiresAt: iso(NOW + 86_400_000) },
    ];
    const active = new Set(["hub-a"]);
    expect(await sweep({ config: fleet(minis), fetcher, active })).toEqual({
      revokedHere: 0,
      revokedThere: 0,
    });
    expect(await readPhoneLinkStore(stateDir)).toEqual({
      version: 1,
      links: [
        {
          environmentId: "env-minis",
          hubSessionId: "hub-a",
          peerSessionId: "minis-1",
          expiresAt: iso(NOW + 86_400_000),
        },
      ],
      pending: [],
    });

    active.delete("hub-a");
    expect(await sweep({ config: fleet(minis), fetcher, active })).toEqual({
      revokedHere: 0,
      revokedThere: 1,
    });
    expect(peer(minis).links).toEqual([]);
    expect((await readPhoneLinkStore(stateDir)).links).toEqual([]);
  });

  it("revokes the phone here and on the other machines when one machine revoked it", async () => {
    const minis = machine("minis");
    const m3 = machine("m3");
    const { fetcher, peer } = fakeFleet([minis, m3]);
    const expiresAt = iso(NOW + 86_400_000);
    for (const [target, sessionId] of [
      [minis, "minis-1"],
      [m3, "m3-1"],
    ] as const) {
      await recordPhoneMint(stateDir, {
        environmentId: target.environmentId,
        hubSessionId: "hub-a",
        now: NOW,
      });
      peer(target).links = [{ sessionId, hubSessionId: "hub-a", expiresAt }];
    }
    const active = new Set(["hub-a", "hub-other"]);
    await sweep({ config: fleet(minis, m3), fetcher, active });

    // The person revokes the phone on Minis.
    peer(minis).links = [];
    const revokedHere: string[] = [];
    expect(await sweep({ config: fleet(minis, m3), fetcher, active, revokedHere })).toEqual({
      revokedHere: 1,
      revokedThere: 1,
    });
    expect(revokedHere).toEqual(["hub-a"]);
    expect(peer(m3).links).toEqual([]);
    expect(active).toEqual(new Set(["hub-other"]));
    expect((await readPhoneLinkStore(stateDir)).links).toEqual([]);
  });

  it("treats a link that vanished near its expiry as expired, not revoked", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    peer(minis).links = [
      { sessionId: "minis-1", hubSessionId: "hub-a", expiresAt: iso(NOW + 60_000) },
    ];
    const active = new Set(["hub-a"]);
    await sweep({ config: fleet(minis), fetcher, active });
    peer(minis).links = [];
    const revokedHere: string[] = [];
    expect(await sweep({ config: fleet(minis), fetcher, active, revokedHere })).toEqual({
      revokedHere: 0,
      revokedThere: 0,
    });
    expect(revokedHere).toEqual([]);
  });

  it("keeps an offline machine's links until it answers, and carries the revocation then", async () => {
    const minis = machine("minis");
    const { fetcher, peer } = fakeFleet([minis]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    peer(minis).links = [
      { sessionId: "minis-1", hubSessionId: "hub-a", expiresAt: iso(NOW + 86_400_000) },
    ];
    const active = new Set(["hub-a"]);
    await sweep({ config: fleet(minis), fetcher, active });

    peer(minis).online = false;
    active.delete("hub-a");
    expect(await sweep({ config: fleet(minis), fetcher, active })).toEqual({
      revokedHere: 0,
      revokedThere: 0,
    });
    expect((await readPhoneLinkStore(stateDir)).links).toHaveLength(1);

    peer(minis).online = true;
    expect(await sweep({ config: fleet(minis), fetcher, active })).toEqual({
      revokedHere: 0,
      revokedThere: 1,
    });
    expect(peer(minis).links).toEqual([]);
  });

  it("does not revoke anything when this machine's phone sessions cannot be read", async () => {
    const minis = machine("minis");
    const { fetcher, calls } = fakeFleet([minis]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    expect(await sweep({ config: fleet(minis), fetcher, active: null })).toEqual({
      revokedHere: 0,
      revokedThere: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("forgets a mint that was never redeemed after an hour", async () => {
    const minis = machine("minis");
    const { fetcher } = fakeFleet([minis]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    const active = new Set(["hub-a"]);
    await sweep({ config: fleet(minis), fetcher, active, now: NOW + 30 * 60_000 });
    expect((await readPhoneLinkStore(stateDir)).pending).toHaveLength(1);
    await sweep({ config: fleet(minis), fetcher, active, now: NOW + 61 * 60_000 });
    expect((await readPhoneLinkStore(stateDir)).pending).toEqual([]);
  });
});

describe("the link file and machine removal", () => {
  it("keeps the link file private to this user and free of secrets", async () => {
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    const path = join(stateDir, "phone-links.json");
    expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);
    const text = await NodeFSP.readFile(path, "utf8");
    expect(text).not.toContain("management");
    expect(text).not.toContain("CODE-");
  });

  it("reads a damaged link file as empty", async () => {
    await NodeFSP.writeFile(join(stateDir, "phone-links.json"), "{not json", { mode: 0o600 });
    expect(await readPhoneLinkStore(stateDir)).toEqual({ version: 1, links: [], pending: [] });
  });

  it("revokes this hub's phone links on a machine before it leaves, and forgets them", async () => {
    const minis = machine("minis");
    const m3 = machine("m3");
    const { fetcher, peer, posts } = fakeFleet([minis, m3]);
    await recordPhoneMint(stateDir, {
      environmentId: "env-minis",
      hubSessionId: "hub-a",
      now: NOW,
    });
    await recordPhoneMint(stateDir, { environmentId: "env-m3", hubSessionId: "hub-a", now: NOW });
    peer(minis).links = [
      { sessionId: "minis-1", hubSessionId: "hub-a", expiresAt: iso(NOW + 86_400_000) },
    ];
    await unlinkPhonesFrom({ stateDir, fetcher, target: minis, hubEnvironmentId: "env-m4" });
    expect(peer(minis).links).toEqual([]);
    expect(posts("/api/studio/fleet/phone/links")[0]?.body).toEqual({
      hubEnvironmentId: "env-m4",
      activeHubSessionIds: [],
    });
    expect(
      (await readPhoneLinkStore(stateDir)).pending.map((entry) => entry.environmentId),
    ).toEqual(["env-m3"]);
  });

  it("asks a machine for its links only after it proves its identity", async () => {
    const minis = machine("minis");
    const { fetcher, peer, posts } = fakeFleet([minis]);
    peer(minis).environmentId = "env-impostor";
    expect(
      await requestPhoneLinks(fetcher, minis, {
        hubEnvironmentId: "env-m4",
        activeHubSessionIds: [],
      }),
    ).toBeNull();
    expect(posts("/api/studio/fleet/phone/links")).toHaveLength(0);
  });
});
