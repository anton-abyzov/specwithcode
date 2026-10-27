import { afterEach, describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real fleet key file for the link.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { AuthOrchestrationReadScope } from "@specweave-studio/contracts";

import { join } from "../nodePath.ts";
import type { FleetTarget } from "../studioFleet.ts";
import { revokeWorkerAccessByLabel } from "../studioFleetJoin.ts";
import {
  CONNECT_ORIGIN,
  fakeMachine,
  ORIGIN,
  studioToken,
  target,
} from "./fleetMachine.testkit.ts";
import { loadOrCreateFleetProofKey, tokenProofThumbprint } from "./fleetProofKey.ts";
import { makeFleetLink } from "./fleetTransport.ts";
import {
  mintWorkerGrant,
  renewWorkerGrant,
  revokeWorkerSessions,
  sessionIdOfToken,
  WorkerGrantMintError,
  WorkerGrantRenewError,
  workerClientName,
} from "./workerGrantMint.ts";

const mint = (
  machine: ReturnType<typeof fakeMachine>,
  extra: { pairingCode?: string; target?: FleetTarget } = {},
) =>
  mintWorkerGrant({
    fetcher: machine.fetcher,
    target: extra.target ?? target,
    access: "auto",
    clientName: workerClientName("env-m4"),
    pairingCode: extra.pairingCode,
    now: () => Date.parse("2026-10-12T00:00:00.000Z"),
  });

const failureReason = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof WorkerGrantMintError || error instanceof WorkerGrantRenewError
      ? error.reason
      : "unexpected";
  }
  return "resolved";
};

const tokenFor = (sid: string) =>
  `${Buffer.from(JSON.stringify({ v: 1, sid })).toString("base64url")}.sig`;
const renew = (machine: ReturnType<typeof fakeMachine>, selected = target) =>
  renewWorkerGrant({
    fetcher: machine.fetcher,
    target: selected,
    accessToken: tokenFor("sid-1"),
    coordinatorEnvironmentId: "env-m4",
  });

describe("conditional worker grant renewal", () => {
  it("pins identity before sending credentials and keeps the same session without OAuth mint", async () => {
    const machine = fakeMachine();
    const result = await renew(machine);
    expect(sessionIdOfToken(result.accessToken)).toBe("sid-1");
    expect(result.resource).toBe(`${ORIGIN}/mcp`);
    expect(machine.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/.well-known/studio/environment",
      "/.well-known/oauth-protected-resource/mcp",
      "/api/auth/worker-grants/renew",
    ]);
    expect(machine.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(machine.issued()).toBe(0);
  });

  it("refuses identity and management scope mismatches before sending credentials", async () => {
    const machine = fakeMachine({ environmentId: "env-other" });
    expect(await failureReason(renew(machine))).toBe("identity_mismatch");
    expect(machine.calls.every((call) => call.authorization === null)).toBe(true);
    const insufficient = fakeMachine();
    expect(
      await failureReason(renew(insufficient, { ...target, scopes: [AuthOrchestrationReadScope] })),
    ).toBe("pairing_unavailable");
    expect(insufficient.calls).toHaveLength(0);
  });

  it.each([
    { status: 409, code: "grant_revoked", reason: "revoked" },
    { status: 409, code: "grant_missing", reason: "missing" },
    { status: 400, code: "grant_invalid", reason: "invalid" },
    { status: 401, code: "grant_revoked", reason: "pairing_unavailable" },
    { status: 403, code: "grant_revoked", reason: "pairing_unavailable" },
    { status: 404, code: "grant_revoked", reason: "unsupported" },
    { status: 500, code: "grant_revoked", reason: "unreachable" },
  ])(
    "distinguishes HTTP $status/$code from authoritative revocation",
    async ({ status, code, reason }) => {
      const machine = fakeMachine({ renewalStatus: status, renewalCode: code });
      expect(await failureReason(renew(machine))).toBe(reason);
      expect(machine.calls.some((call) => call.url.includes("/oauth/mcp/"))).toBe(false);
    },
  );

  it.each([
    { accessToken: tokenFor("different-session"), expiresAt: "2070-01-01T00:00:00.000Z" },
    { accessToken: tokenFor("sid-1"), expiresAt: "invalid" },
    { accessToken: tokenFor("sid-1"), expiresAt: "2020-01-01T00:00:00.000Z" },
  ])("rejects a malformed or replacement renewal response", async (response) => {
    const base = fakeMachine();
    const machine = {
      ...base,
      fetcher: (async (input, init) => {
        if (String(input).endsWith("worker-grants/renew"))
          return new Response(JSON.stringify(response), { status: 200 });
        return base.fetcher(input, init);
      }) as typeof fetch,
    };
    expect(await failureReason(renew(machine))).toBe("unreachable");
  });
});

describe("worker grant minting", () => {
  it("mints a grant with a management-token pairing code and PKCE", async () => {
    const machine = fakeMachine();
    const grant = await mint(machine);
    expect(grant.accessToken).toBe("mcp-token-auto-1");
    expect(grant.resource).toBe(`${ORIGIN}/mcp`);
    expect(grant.expiresAt).toBe("2026-11-11T00:00:00.000Z");
    // Identity is checked before the management token goes anywhere.
    const firstTokenCall = machine.calls.findIndex((call) => call.authorization !== null);
    const identityCall = machine.calls.findIndex((call) =>
      call.url.endsWith("/.well-known/studio/environment"),
    );
    expect(identityCall).toBeGreaterThanOrEqual(0);
    expect(identityCall).toBeLessThan(firstTokenCall);
    // Nothing leaves the configured origin, and no request follows redirects.
    expect(machine.calls.every((call) => call.url.startsWith(`${ORIGIN}/`))).toBe(true);
    expect(machine.calls.every((call) => call.redirect === "error")).toBe(true);
    // The approval answer is parsed, never fetched.
    expect(machine.calls.some((call) => call.url.startsWith("http://127.0.0.1"))).toBe(false);
    // The management token is only sent to the pairing endpoint.
    expect(
      machine.calls
        .filter((call) => call.authorization !== null)
        .map((call) => new URL(call.url).pathname),
    ).toEqual(["/api/auth/pairing-token"]);
  });

  it("uses a pasted pairing code without the management token", async () => {
    const machine = fakeMachine();
    const { managementToken: _dropped, ...withoutToken } = target;
    const grant = await mint(machine, { pairingCode: "PAIRCODE", target: withoutToken });
    expect(grant.accessToken).toBe("mcp-token-auto-1");
    expect(machine.calls.every((call) => call.authorization === null)).toBe(true);
  });

  it("needs a pairing code when no management token is configured", async () => {
    const { managementToken: _dropped, ...withoutToken } = target;
    expect(await failureReason(mint(fakeMachine(), { target: withoutToken }))).toBe(
      "pairing_unavailable",
    );
  });

  it("refuses to mint scopes the fleet entry does not grant", async () => {
    expect(
      await failureReason(
        mint(fakeMachine(), { target: { ...target, scopes: [AuthOrchestrationReadScope] } }),
      ),
    ).toBe("pairing_unavailable");
  });

  it("reports an older Studio and a mismatched route", async () => {
    expect(await failureReason(mint(fakeMachine({ protectedResourceStatus: 404 })))).toBe(
      "unsupported",
    );
    expect(
      await failureReason(mint(fakeMachine({ resource: "https://other.example.ts.net/mcp" }))),
    ).toBe("route_mismatch");
  });

  it("stops at an identity mismatch before sending any credential", async () => {
    const machine = fakeMachine({ environmentId: "env-someone-else" });
    expect(await failureReason(mint(machine))).toBe("identity_mismatch");
    expect(machine.calls.every((call) => call.authorization === null)).toBe(true);
  });

  it("checks the state and issuer of the approval answer", async () => {
    expect(await failureReason(mint(fakeMachine({ decisionState: "forged" })))).toBe(
      "route_mismatch",
    );
    expect(await failureReason(mint(fakeMachine({ decisionIss: "https://evil.ts.net" })))).toBe(
      "route_mismatch",
    );
  });

  it("revokes the unused pairing code when the sign-in fails", async () => {
    const machine = fakeMachine({ tokenStatus: 500 });
    expect(await failureReason(mint(machine))).toBe("pairing_code_rejected");
    expect(machine.revokedPairings).toEqual(["pairing-1"]);
    const rejected = fakeMachine({ rejectCode: true });
    expect(await failureReason(mint(rejected))).toBe("pairing_code_rejected");
    expect(rejected.revokedPairings).toEqual(["pairing-1"]);
  });

  it("revokes this server's older sessions by label and keeps the newest", async () => {
    const machine = fakeMachine();
    const result = await revokeWorkerSessions({
      fetcher: machine.fetcher,
      target,
      clientName: workerClientName("env-m4"),
      keepNewest: true,
    });
    expect(result).toEqual({ revoked: 1, complete: true, swept: true });
    expect(machine.revokedSessions).toEqual(["old"]);
    const all = fakeMachine();
    await revokeWorkerSessions({
      fetcher: all.fetcher,
      target,
      clientName: workerClientName("env-m4"),
      keepNewest: false,
    });
    expect(all.revokedSessions.toSorted()).toEqual(["new", "old"]);
  });

  it("cannot revoke without a management token", async () => {
    const { managementToken: _dropped, ...withoutToken } = target;
    const machine = fakeMachine();
    expect(
      await revokeWorkerSessions({
        fetcher: machine.fetcher,
        target: withoutToken,
        clientName: workerClientName("env-m4"),
        keepNewest: false,
      }),
    ).toEqual({ revoked: 0, complete: false, swept: false });
    expect(machine.calls).toEqual([]);
  });
  it("never throws when the machine drops off mid-revoke", async () => {
    const machine = fakeMachine();
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/auth/clients/revoke")
        throw new TypeError("fetch failed");
      return machine.fetcher(input, init);
    }) as typeof fetch;
    expect(
      await revokeWorkerSessions({
        fetcher,
        target,
        clientName: workerClientName("env-m4"),
        keepNewest: false,
      }),
    ).toEqual({ revoked: 0, complete: false, swept: false });
  });

  it("revokes the sessions it knows by id when the token cannot list sessions", async () => {
    const machine = fakeMachine({ clientsStatus: 403 });
    expect(
      await revokeWorkerSessions({
        fetcher: machine.fetcher,
        target,
        clientName: workerClientName("env-m4"),
        keepNewest: true,
        sessionIds: ["sid-1"],
        keepSessionId: "sid-2",
      }),
    ).toEqual({ revoked: 1, complete: true, swept: false });
    expect(machine.revokedSessions).toEqual(["sid-1"]);
  });

  it("spares the grant just minted and revokes a known session only once", async () => {
    const machine = fakeMachine();
    expect(
      await revokeWorkerSessions({
        fetcher: machine.fetcher,
        target,
        clientName: workerClientName("env-m4"),
        keepNewest: true,
        sessionIds: ["old"],
        keepSessionId: "new",
      }),
    ).toEqual({ revoked: 1, complete: true, swept: true });
    expect(machine.revokedSessions).toEqual(["old"]);
  });

  it("reads the session id from a Studio access token and nothing else", () => {
    const claims = Buffer.from(JSON.stringify({ v: 1, sid: "session-7" })).toString("base64url");
    expect(sessionIdOfToken(`${claims}.signature`)).toBe("session-7");
    expect(sessionIdOfToken("opaque-token")).toBeUndefined();
    expect(sessionIdOfToken(`${claims}.signature.extra`)).toBeUndefined();
    expect(sessionIdOfToken("bm90IGpzb24.signature")).toBeUndefined();
  });
});

describe("worker grants over SpecWithCode Connect", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
  });
  /** This machine's fleet key, a management token bound to it, and a link that signs with it. */
  const coordinator = async (machine: ReturnType<typeof fakeMachine>) => {
    const fetcher = machine.fetcher;
    const baseDir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-grant-connect-"));
    dirs.push(baseDir);
    const key = await loadOrCreateFleetProofKey(baseDir);
    const managementToken = studioToken({ sid: "management", jkt: key.thumbprint });
    machine.acceptManagementToken(managementToken);
    return {
      key,
      managementToken,
      link: makeFleetLink({ fetch: fetcher, baseDir }),
      target: { ...target, connectUrl: CONNECT_ORIGIN, managementToken } satisfies FleetTarget,
    };
  };
  const offlineTailnet = (extra: Parameters<typeof fakeMachine>[0] = {}) =>
    fakeMachine({ origins: [ORIGIN, CONNECT_ORIGIN], offline: new Set([ORIGIN]), ...extra });

  it("mints a key-bound grant on the Connect address when the tailnet is down", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { key, link, target: bound, managementToken } = await coordinator(machine);
    machine.calls.length = 0;
    const grant = await mintWorkerGrant({
      link,
      target: { ...bound, managementToken },
      access: "auto",
      clientName: workerClientName("env-m4"),
    });
    expect(grant.origin).toBe(CONNECT_ORIGIN);
    expect(grant.resource).toBe(`${CONNECT_ORIGIN}/mcp`);
    expect(tokenProofThumbprint(grant.accessToken)).toBe(key.thumbprint);
    const sent = machine.calls.filter((call) => call.url.startsWith(CONNECT_ORIGIN));
    // Identity first, then only proof-carrying credentials; never a bearer over Connect.
    expect(new URL(sent[0]!.url).pathname).toBe("/.well-known/studio/environment");
    expect(sent.some((call) => call.authorization?.startsWith("Bearer ") === true)).toBe(false);
    const management = sent.filter((call) => call.authorization !== null);
    expect(management.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/auth/pairing-token",
    ]);
    expect(management[0]!.authorization).toBe(`DPoP ${managementToken}`);
    expect(management[0]!.dpop).toMatch(/^ey/);
    const tokenCall = sent.find((call) => call.url.endsWith("/oauth/mcp/token"));
    expect(tokenCall?.dpop).toMatch(/^ey/);
  });

  it("revokes this machine's grants there on remove, with a key-bound management token", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { link, target: bound, managementToken } = await coordinator(machine);
    expect(await revokeWorkerAccessByLabel(link, bound, "env-m4")).toBe("revoked");
    expect(machine.revokedSessions.toSorted()).toEqual(["new", "old"]);
    const revokes = machine.calls.filter((call) => call.url.endsWith("/api/auth/clients/revoke"));
    expect(revokes.every((call) => call.authorization === `DPoP ${managementToken}`)).toBe(true);
  });

  it("binds the grant on the tailnet only for a machine that also has a Connect address", async () => {
    const machine = fakeMachine({ dpop: true });
    const { key, link } = await coordinator(machine);
    const grant = await mintWorkerGrant({
      link,
      target: { ...target, connectUrl: CONNECT_ORIGIN },
      access: "auto",
      clientName: workerClientName("env-m4"),
    });
    expect(grant.origin).toBe(ORIGIN);
    expect(tokenProofThumbprint(grant.accessToken)).toBe(key.thumbprint);
    // The unbound management token is still a plain bearer on the tailnet.
    expect(
      machine.calls.find((call) => call.url.endsWith("/api/auth/pairing-token"))?.authorization,
    ).toBe("Bearer management-secret");

    // A tailnet-only machine keeps a bearer grant even though a key exists.
    const tailnetOnly = fakeMachine({ dpop: true });
    const { link: plain } = await coordinator(tailnetOnly);
    const bearer = await mintWorkerGrant({
      link: plain,
      target,
      access: "auto",
      clientName: workerClientName("env-m4"),
    });
    expect(tokenProofThumbprint(bearer.accessToken)).toBeUndefined();
    expect(
      tailnetOnly.calls.find((call) => call.url.endsWith("/oauth/mcp/token"))?.dpop,
    ).toBeNull();
  });

  it("refuses a machine without DPoP over Connect before any pairing code exists", async () => {
    const machine = offlineTailnet();
    const { link, target: bound } = await coordinator(machine);
    expect(
      await failureReason(
        mintWorkerGrant({
          link,
          target: bound,
          access: "auto",
          clientName: workerClientName("env-m4"),
        }),
      ),
    ).toBe("unsupported");
    expect(machine.calls.some((call) => call.url.endsWith("/api/auth/pairing-token"))).toBe(false);
  });

  it("never takes an unbound management token to the Connect address", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { link } = await coordinator(machine);
    expect(
      await failureReason(
        mintWorkerGrant({
          link,
          target: { ...target, connectUrl: CONNECT_ORIGIN },
          access: "auto",
          clientName: workerClientName("env-m4"),
        }),
      ),
    ).toBe("pairing_unavailable");
    // Connect is only asked who it is, never sent the token.
    expect(
      machine.calls
        .filter((call) => call.url.startsWith(CONNECT_ORIGIN))
        .map((call) => [new URL(call.url).pathname, call.authorization]),
    ).toEqual([["/.well-known/studio/environment", null]]);
  });

  it("renews a bound grant over Connect and keeps its key", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { key, link, target: bound, managementToken } = await coordinator(machine);
    const grant = studioToken({ sid: "sid-1", jkt: key.thumbprint });
    const renewed = await renewWorkerGrant({
      link,
      target: { ...bound, managementToken },
      accessToken: grant,
      coordinatorEnvironmentId: "env-m4",
    });
    expect(renewed.origin).toBe(CONNECT_ORIGIN);
    expect(sessionIdOfToken(renewed.accessToken)).toBe("sid-1");
    expect(tokenProofThumbprint(renewed.accessToken)).toBe(key.thumbprint);
    const call = machine.calls.find((entry) => entry.url.endsWith("/worker-grants/renew"));
    expect(call?.authorization).toBe(`DPoP ${managementToken}`);
  });

  it("does not send an unbound grant over Connect to renew it", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { link, target: bound } = await coordinator(machine);
    expect(
      await failureReason(
        renewWorkerGrant({
          link,
          target: bound,
          accessToken: tokenFor("sid-1"),
          coordinatorEnvironmentId: "env-m4",
        }),
      ),
    ).toBe("unreachable");
    expect(machine.calls.some((call) => call.url.endsWith("/worker-grants/renew"))).toBe(false);
  });

  it("revokes sessions over Connect with the bound management token", async () => {
    const machine = offlineTailnet({ dpop: true });
    const { link, target: bound } = await coordinator(machine);
    expect(
      await revokeWorkerSessions({
        link,
        target: bound,
        clientName: workerClientName("env-m4"),
        keepNewest: true,
      }),
    ).toEqual({ revoked: 1, complete: true, swept: true });
    expect(machine.revokedSessions).toEqual(["old"]);
  });
});
