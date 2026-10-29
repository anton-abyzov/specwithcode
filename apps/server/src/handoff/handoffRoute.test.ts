/**
 * The machine-to-machine handoff route: which callers get in, and the limits
 * it hands the receiver from the worker credential on the request.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  type AuthMcpClientAccess,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import { describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerAuthInvalidCredentialError } from "../auth/EnvironmentAuthErrors.ts";
import { type EffectiveWorkGrant, unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { CoordinatorLeaseReceiver } from "../project/CoordinatorLeaseRoute.ts";
import { HandoffReceiver, type ReceiverCaller } from "./HandoffReceiver.ts";
import * as HandoffRoute from "./handoffRoute.ts";
import { HANDOFF_PEER_PREFIX } from "./handoffWire.ts";

const m4 = EnvironmentId.make("env-m4");

/** One worker credential per bearer token: its access and the grant it holds here. */
const credentials: Record<
  string,
  { readonly access: AuthMcpClientAccess; readonly grant: EffectiveWorkGrant }
> = {
  "read-only": { access: "read-only", grant: unscopedGrant(m4) },
  limited: { access: "auto-accept-edits", grant: unscopedGrant(m4) },
  // Kept from before grants: no runtime cap stored until the coordinator calls again.
  legacy: { access: "auto", grant: { ...unscopedGrant(m4), legacy: true } },
  revoked: { access: "full-access", grant: { ...unscopedGrant(m4), revoked: true } },
};

function api() {
  const callers: Array<ReceiverCaller> = [];
  const token = (headers: Record<string, string | undefined>) =>
    (headers.authorization ?? "").replace(/^Bearer /, "");
  // Route handlers read their services per request, so they stay in the output.
  const routes = HandoffRoute.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateMcpClient: (request) => {
            const credential = credentials[token(request.headers)];
            return credential === undefined
              ? Effect.fail(new ServerAuthInvalidCredentialError({ diagnostic: "expired" }))
              : Effect.succeed({
                  sessionId: AuthSessionId.make(`session-${token(request.headers)}`),
                  principal: { kind: "coordinator", environmentId: m4 },
                  label: "worker",
                  access: credential.access,
                } as never);
          },
        }),
        Layer.succeed(WorkGrants.WorkGrants, {
          ...WorkGrants.WorkGrants.defaultValue(),
          enabled: true,
          forClient: (client) =>
            Effect.succeed(
              credentials[
                Object.keys(credentials).find(
                  (key) => credentials[key]!.access === client?.access,
                ) ?? ""
              ]?.grant,
            ),
        }),
        Layer.mock(CoordinatorLeaseReceiver)({ grantRefused: () => Effect.void }),
        Layer.mock(HandoffReceiver)({
          negotiate: (caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return { known: [] };
            }),
        }),
      ),
    ),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const negotiate = (bearer: string) =>
    handler(
      new Request(`http://minis.local${HANDOFF_PEER_PREFIX}/negotiate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          sourceEnvironmentId: m4,
          sourceProjectId: ProjectId.make("project-m4"),
          sourceThreadId: ThreadId.make("thread-m4"),
          repositoryPath: "",
          candidates: [],
        }),
      }),
    );
  return { negotiate, callers, dispose };
}

describe("handoff route", () => {
  it("caps a read-only credential's continuations at approval-required", async () => {
    const app = api();
    try {
      expect((await app.negotiate("read-only")).status).toBe(200);
      expect(app.callers[0]).toMatchObject({
        sourceEnvironmentId: m4,
        runtimeCeiling: "approval-required",
      });
      expect((await app.negotiate("limited")).status).toBe(200);
      expect(app.callers[1]?.runtimeCeiling).toBe("auto-accept-edits");
    } finally {
      await app.dispose();
    }
  });

  it("takes a legacy grant's cap from the credential on the request", async () => {
    const app = api();
    try {
      expect((await app.negotiate("legacy")).status).toBe(200);
      expect(app.callers[0]?.grant?.legacy).toBe(true);
      expect(app.callers[0]?.runtimeCeiling).toBe("auto");
    } finally {
      await app.dispose();
    }
  });

  it("refuses a revoked grant and an expired credential before the receiver", async () => {
    const app = api();
    try {
      const revoked = await app.negotiate("revoked");
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ code: "needs_grant", check: "grant" });
      const expired = await app.negotiate("expired");
      expect(expired.status).toBe(401);
      expect(await expired.json()).toMatchObject({ code: "needs_grant" });
      expect(app.callers).toEqual([]);
    } finally {
      await app.dispose();
    }
  });
});
