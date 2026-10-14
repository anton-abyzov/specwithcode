// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native crypto independently verifies the grant writer's PKCE challenge.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import { expect } from "vite-plus/test";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
} from "@specweave-studio/contracts";

import type { FleetTarget } from "../studioFleet.ts";
import {
  WORKER_GRANT_REDIRECT_URI,
  workerClientName,
  sessionIdOfToken,
} from "./workerGrantMint.ts";

export const ORIGIN = "https://m1.example.ts.net";
export const target: FleetTarget = {
  id: "m1",
  label: "M1",
  environmentId: EnvironmentId.make("env-m1"),
  url: ORIGIN,
  managementToken: "management-secret",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthAccessWriteScope],
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly redirect: RequestInit["redirect"];
  readonly authorization: string | null;
  readonly body: string | null;
}

/** A stand-in for another machine's auth endpoints, strict where the real one is. */
export function fakeMachine(
  overrides: {
    readonly environmentId?: string;
    readonly resource?: string;
    readonly protectedResourceStatus?: number;
    readonly tokenStatus?: number;
    readonly decisionIss?: string;
    readonly decisionState?: string;
    readonly rejectCode?: boolean;
    /** Issue tokens shaped like Studio's, whose claims name the session. */
    readonly sessionTokens?: boolean;
    /** A management token without `access:read` gets 403 listing sessions. */
    readonly clientsStatus?: number;
    readonly renewalStatus?: number;
    readonly renewalCode?: string;
  } = {},
) {
  const calls: Call[] = [];
  const pending = new Map<string, { challenge: string; access: string }>();
  const revokedPairings: string[] = [];
  const revokedSessions: string[] = [];
  let issued = 0;
  let renewed = 0;
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      authorization: headers.get("authorization"),
      body,
    });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.origin !== ORIGIN) return json(404, {});
    switch (url.pathname) {
      case "/.well-known/studio/environment":
        return json(200, {
          environmentId: overrides.environmentId ?? "env-m1",
          label: "M1",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.2.11",
          capabilities: { repositoryIdentity: true },
        });
      case "/.well-known/oauth-protected-resource/mcp":
        return overrides.protectedResourceStatus === 404
          ? json(404, {})
          : json(200, {
              resource: overrides.resource ?? `${ORIGIN}/mcp`,
              authorization_servers: [ORIGIN],
            });
      case "/api/auth/pairing-token": {
        if (headers.get("authorization") !== "Bearer management-secret") return json(401, {});
        const request = JSON.parse(body ?? "{}");
        expect(request.scopes).toEqual([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
        return json(200, {
          id: "pairing-1",
          credential: "PAIRCODE",
          expiresAt: DateTime.formatIso(
            DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + 300_000),
          ),
        });
      }
      case "/api/auth/pairing-links/revoke":
        revokedPairings.push(JSON.parse(body ?? "{}").id);
        return json(200, { revoked: true });
      case "/oauth/mcp/register": {
        const request = JSON.parse(body ?? "{}");
        expect(request.redirect_uris).toEqual([WORKER_GRANT_REDIRECT_URI]);
        return json(201, { client_id: `client.${request.client_name}` });
      }
      case "/oauth/mcp/decision": {
        const { authorization, decision } = JSON.parse(body ?? "{}");
        expect(authorization.code_challenge_method).toBe("S256");
        expect(authorization.resource).toBe(`${ORIGIN}/mcp`);
        if (overrides.rejectCode || decision.code !== "PAIRCODE")
          return json(400, { _tag: "AuthMcpApprovalError", message: "The code is unknown." });
        pending.set("CODE-1", { challenge: authorization.code_challenge, access: decision.access });
        const redirect = new URL(authorization.redirect_uri);
        redirect.searchParams.set("code", "CODE-1");
        redirect.searchParams.set("state", overrides.decisionState ?? authorization.state);
        redirect.searchParams.set("iss", overrides.decisionIss ?? ORIGIN);
        return json(200, { redirectTo: redirect.toString() });
      }
      case "/oauth/mcp/token": {
        expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        const form = new URLSearchParams(body ?? "");
        const found = pending.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const digest = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
        if (overrides.tokenStatus !== undefined) return json(overrides.tokenStatus, {});
        if (!found || digest !== found.challenge)
          return json(400, { error: "invalid_grant", error_description: "bad" });
        issued += 1;
        return json(200, {
          access_token: overrides.sessionTokens
            ? `${Buffer.from(JSON.stringify({ v: 1, sid: `sid-${issued}` })).toString("base64url")}.sig`
            : `mcp-token-${found.access}-${issued}`,
          token_type: "Bearer",
          expires_in: 30 * 24 * 3600,
          scope: "orchestration:read orchestration:operate",
        });
      }
      case "/api/auth/clients":
        if (overrides.clientsStatus !== undefined)
          return json(overrides.clientsStatus, { code: "insufficient_scope" });
        return json(200, [
          {
            sessionId: "old",
            subject: "mcp-client",
            issuedAt: "2026-09-01T00:00:00.000Z",
            client: { label: workerClientName("env-m4"), deviceType: "bot" },
          },
          {
            sessionId: "new",
            subject: "mcp-client",
            issuedAt: "2026-10-01T00:00:00.000Z",
            client: { label: workerClientName("env-m4"), deviceType: "bot" },
          },
          {
            sessionId: "someone-else",
            subject: "mcp-client",
            issuedAt: "2026-10-02T00:00:00.000Z",
            client: { label: "Claude Code", deviceType: "bot" },
          },
        ]);
      case "/api/auth/clients/revoke":
        revokedSessions.push(JSON.parse(body ?? "{}").sessionId);
        return json(200, { revoked: true });
      case "/api/auth/worker-grants/renew": {
        if (headers.get("authorization") !== "Bearer management-secret") return json(401, {});
        const request = JSON.parse(body ?? "{}");
        expect(request.coordinatorEnvironmentId).toBe("env-m4");
        expect(request.environmentId).toBe("env-m1");
        if (overrides.renewalStatus !== undefined)
          return json(overrides.renewalStatus, { code: overrides.renewalCode });
        const sid = sessionIdOfToken(request.accessToken);
        if (!sid) return json(400, { code: "grant_invalid" });
        if (revokedSessions.includes(sid)) return json(409, { code: "grant_revoked" });
        renewed += 1;
        return json(200, {
          accessToken: `${Buffer.from(JSON.stringify({ v: 1, sid, renewal: renewed })).toString("base64url")}.sig`,
          expiresAt: "2070-01-01T00:00:00.000Z",
        });
      }
      default:
        return json(404, {});
    }
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    revokedPairings,
    revokedSessions,
    issued: () => issued,
    renewed: () => renewed,
  };
}
