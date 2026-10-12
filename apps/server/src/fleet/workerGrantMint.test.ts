import { describe, expect, it } from "vite-plus/test";
import { AuthOrchestrationReadScope } from "@specweave-studio/contracts";

import type { FleetTarget } from "../studioFleet.ts";
import { fakeMachine, ORIGIN, target } from "./fleetMachine.testkit.ts";
import {
  mintWorkerGrant,
  revokeWorkerSessions,
  sessionIdOfToken,
  WorkerGrantMintError,
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
    return error instanceof WorkerGrantMintError ? error.reason : "unexpected";
  }
  return "resolved";
};

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
