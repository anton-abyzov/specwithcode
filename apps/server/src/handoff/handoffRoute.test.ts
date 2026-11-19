/**
 * The machine-to-machine handoff route: which callers get in, and the limits
 * it hands the receiver from the worker credential on the request.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  type AuthMcpClientAccess,
  EnvironmentId,
  HANDOFF_MAX_BUNDLE_BYTES,
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
import { LinkedMemoryPeerReceiver } from "../project/LinkedMemoryPeers.ts";
import { LinkedPeerReceiver } from "../project/LinkedPeerRoute.ts";
import { ExtrasReceiver } from "./ExtrasReceiver.ts";
import { HandoffReceiver, type ReceiverCaller } from "./HandoffReceiver.ts";
import * as HandoffRoute from "./handoffRoute.ts";
import {
  encodeFrame,
  HANDOFF_FRAME_META_MAX_BYTES,
  HANDOFF_PEER_PREFIX,
  LINKED_SYNC_PEER_MAX_BYTES,
} from "./handoffWire.ts";
import { LINKED_SYNC_PROTOCOL_VERSION } from "./linkedSyncWire.ts";

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
  const extras: Array<{ readonly meta: unknown; readonly bundle: Uint8Array | null }> = [];
  const takeovers: Array<unknown> = [];
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
        Layer.mock(LinkedMemoryPeerReceiver)({}),
        Layer.mock(LinkedPeerReceiver)({
          digest: (caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return {} as never;
            }),
          members: (caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return { replayed: false, changed: true };
            }),
        }),
        Layer.mock(ExtrasReceiver)({
          negotiate: (caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return { known: [] };
            }),
          replicate: (caller, meta, bundle) =>
            Effect.sync(() => {
              callers.push(caller);
              extras.push({ meta, bundle: bundle === null ? null : new Uint8Array(bundle) });
              return {
                machineLabel: "Mini",
                branch: `swc/from-M4/${meta.leaf}`,
                landed: "created",
              };
            }),
        }),
        Layer.mock(HandoffReceiver)({
          negotiate: (caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return { known: [] };
            }),
          takeover: (caller, request) =>
            Effect.sync(() => {
              callers.push(caller);
              takeovers.push(request);
              return {
                threadId: ThreadId.make("thread-continued"),
                machineLabel: "Mini",
                modelSelection: null,
                resumed: false,
                notice: null,
              };
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
  const post = (path: string, bearer: string, body: string, length = body.length) =>
    handler(
      new Request(`http://minis.local${HANDOFF_PEER_PREFIX}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(length),
          authorization: `Bearer ${bearer}`,
        },
        body,
      }),
    );
  /** A framed body (metadata, then the bundle's bytes), as `extras-replicate` takes it. */
  const frame = (path: string, bearer: string, body: Uint8Array, length = body.byteLength) =>
    handler(
      new Request(`http://minis.local${HANDOFF_PEER_PREFIX}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(length),
          authorization: `Bearer ${bearer}`,
        },
        body: body as never,
      }),
    );
  return { negotiate, post, frame, callers, extras, takeovers, dispose };
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

  it("hands linked sync to its receiver with the caller its grant names", async () => {
    const app = api();
    try {
      const body = JSON.stringify({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        logicalProjectId: "logical:1",
        projectId: "project-minis",
      });
      expect((await app.post("linked-digest", "limited", body)).status).toBe(200);
      expect(app.callers[0]?.sourceEnvironmentId).toBe(m4);
    } finally {
      await app.dispose();
    }
  });

  it("hands a coordinator's member list to its receiver", async () => {
    const app = api();
    try {
      const member = {
        environmentId: m4,
        projectId: "project-m4",
        coordinatorThreadId: "project-coordinator:project-m4",
      };
      const body = JSON.stringify({
        protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
        logicalProjectId: "logical:1",
        projectId: "project-minis",
        from: member,
        fromEpoch: 0,
        members: [member],
      });
      const answer = await app.post("linked-members", "limited", body);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ replayed: false, changed: true });
      expect(app.callers[0]?.sourceEnvironmentId).toBe(m4);
    } finally {
      await app.dispose();
    }
  });

  it("refuses an oversize linked payload before reading it", async () => {
    const app = api();
    try {
      const answer = await app.post(
        "linked-replica",
        "limited",
        "{}",
        LINKED_SYNC_PEER_MAX_BYTES + 1,
      );
      expect(answer.status).toBe(413);
      expect(await answer.json()).toMatchObject({ code: "too_large" });
      expect(app.callers).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

  it("T24R1-04: takes a review's takeover on its own path, with the caller its grant names", async () => {
    const app = api();
    try {
      const request = {
        sourceEnvironmentId: m4,
        sourceThreadId: "thread-m4",
        epoch: 2,
        sequence: 1,
        reason: "handoff",
        modelSelection: null,
        review: true,
      };
      const answer = await app.post("review-takeover", "limited", JSON.stringify(request));
      expect(answer.status).toBe(200);
      expect(app.callers[0]?.sourceEnvironmentId).toBe(m4);
      expect(app.takeovers).toEqual([request]);
    } finally {
      await app.dispose();
    }
  });

  it("answers an unknown path the way older machines do, so a driver can tell them apart", async () => {
    const app = api();
    try {
      const answer = await app.post("linked-something-newer", "limited", "{}");
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: "not_found", code: "not_found" });
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

  const extraMeta = {
    sourceEnvironmentId: m4,
    sourceLabel: "M4",
    sourceProjectId: ProjectId.make("project-m4"),
    repositoryPath: "repositories/lib",
    operationId: "0a1b2c3d-1111-4222-8333-444455556666",
    leaf: "feature",
    commit: "a".repeat(40),
  };

  it("hands a framed extra to its receiver: the metadata, and the bundle's bytes untouched", async () => {
    const app = api();
    try {
      const bundle = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
      const answer = await app.frame("extras-replicate", "limited", encodeFrame(extraMeta, bundle));
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({
        machineLabel: "Mini",
        branch: "swc/from-M4/feature",
        landed: "created",
      });
      expect(app.callers[0]).toMatchObject({ sourceEnvironmentId: m4 });
      expect(app.extras[0]!.meta).toEqual(extraMeta);
      expect(Buffer.from(app.extras[0]!.bundle!).equals(Buffer.from(bundle))).toBe(true);
      // A commit the other machine already holds comes with no bundle at all.
      expect(
        (await app.frame("extras-replicate", "limited", encodeFrame(extraMeta, null))).status,
      ).toBe(200);
      expect(app.extras[1]!.bundle?.byteLength ?? 0).toBe(0);
    } finally {
      await app.dispose();
    }
  });

  it("refuses an extra over the body limit before reading it, and a frame it cannot read", async () => {
    const app = api();
    try {
      const small = encodeFrame(extraMeta, new Uint8Array([1, 2, 3]));
      const oversize = await app.frame(
        "extras-replicate",
        "limited",
        small,
        HANDOFF_MAX_BUNDLE_BYTES + HANDOFF_FRAME_META_MAX_BYTES + 5,
      );
      expect(oversize.status).toBe(413);
      expect(await oversize.json()).toMatchObject({ code: "too_large" });
      const invalid = async (body: Uint8Array) => {
        const answer = await app.frame("extras-replicate", "limited", body);
        expect(answer.status).toBe(400);
        expect(await answer.json()).toMatchObject({ code: "invalid" });
      };
      // Shorter than its own length field, a length past its end, and metadata that is not JSON.
      await invalid(new Uint8Array([0, 0, 1]));
      await invalid(Uint8Array.from([0, 0, 1, 0, ...small.subarray(4, 40)]));
      await invalid(Uint8Array.from([0, 0, 0, 3, 110, 111, 33]));
      // Metadata that is not this message: no commit, a commit that is no object name,
      // a field too long. (Where the path leads is the receiver's check, as for a hand off.)
      const { commit: _commit, ...withoutCommit } = extraMeta;
      await invalid(encodeFrame(withoutCommit, null));
      await invalid(encodeFrame({ ...extraMeta, commit: "main" }, null));
      await invalid(encodeFrame({ ...extraMeta, leaf: "x".repeat(256) }, null));
      expect(app.extras).toEqual([]);
      // A revoked grant never reaches the receiver either.
      expect((await app.frame("extras-replicate", "revoked", small)).status).toBe(403);
      expect(app.callers).toEqual([]);
    } finally {
      await app.dispose();
    }
  });
});
