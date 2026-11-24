/**
 * The handoff route's answers to a sleep or silence start an earlier release sends
 * (1390 AC-36): one refused before the receiver reads it is no answer, never a
 * refusal, so the sender keeps its hold on a first send and on a re-send. Read
 * back here by the sender's own classifier.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  type AuthMcpClientAccess,
  EnvironmentId,
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
import { PersonalShareEngine } from "../project/PersonalShareEngine.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { ExtrasReceiver } from "./ExtrasReceiver.ts";
import { FolderWorkReceiver } from "./HandoffBatch.ts";
import { HandoffReceiver, HandoffRefusal } from "./HandoffReceiver.ts";
import * as Peers from "./handoffPeers.ts";
import * as HandoffRoute from "./handoffRoute.ts";
import { HANDOFF_PEER_PREFIX, type TakeoverRequest, type TakeoverResponse } from "./handoffWire.ts";

const m4 = EnvironmentId.make("env-m4");

const credentials: Record<
  string,
  { readonly access: AuthMcpClientAccess; readonly grant: EffectiveWorkGrant }
> = {
  granted: { access: "full-access", grant: unscopedGrant(m4) },
  revoked: { access: "auto-accept-edits", grant: { ...unscopedGrant(m4), revoked: true } },
};

const response: TakeoverResponse = {
  threadId: ThreadId.make("handoff:continued"),
  machineLabel: "Minis",
  modelSelection: null,
  resumed: true,
  notice: null,
};

/** The route with a receiver that answers `takeover`, and an update hold when `held`. */
function api(options: {
  readonly held?: boolean;
  readonly takeover?: (request: TakeoverRequest) => Effect.Effect<TakeoverResponse, HandoffRefusal>;
}) {
  const taken: Array<TakeoverRequest> = [];
  const token = (headers: Record<string, string | undefined>) =>
    (headers.authorization ?? "").replace(/^Bearer /, "");
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
              Object.values(credentials).find((entry) => entry.access === client?.access)?.grant,
            ),
        }),
        Layer.mock(CoordinatorLeaseReceiver)({ grantRefused: () => Effect.void }),
        Layer.mock(LinkedMemoryPeerReceiver)({}),
        Layer.mock(LinkedPeerReceiver)({}),
        Layer.mock(PersonalShareEngine)({}),
        Layer.mock(ExtrasReceiver)({}),
        Layer.mock(FolderWorkReceiver)({}),
        Layer.mock(HandoffReceiver)({
          negotiate: () => Effect.succeed({ known: [] }),
          takeover: (_caller, request) =>
            Effect.suspend((): Effect.Effect<TakeoverResponse, HandoffRefusal> => {
              taken.push(request);
              return options.takeover?.(request) ?? Effect.succeed(response);
            }),
        }),
        options.held === true
          ? Layer.mock(ServiceUpdateHold.ServiceUpdateHold)({
              isHeld: Effect.succeed(true),
              awaitReleased: Effect.void,
              current: Effect.succeedNone,
              installGated: Effect.succeed(false),
              recordRefusal: () => Effect.void,
              withAdmission: (_action, effect) => effect,
            })
          : Layer.empty,
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
  /** Posts `body` and reads the answer as the sender does: its status, JSON and classification. */
  const post = async (path: string, bearer: string, body: unknown) => {
    const text = JSON.stringify(body);
    const answer = await handler(
      new Request(`http://minis.local${HANDOFF_PEER_PREFIX}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(text.length),
          authorization: `Bearer ${bearer}`,
        },
        body: text,
      }),
    );
    const json = (await answer.json()) as Record<string, unknown>;
    // Read through the module, so a build without the shared classifier fails on assertions.
    const classify = Peers.refusedAnswer as typeof Peers.refusedAnswer | undefined;
    return {
      status: answer.status,
      json,
      read: answer.ok || classify === undefined ? null : classify("Minis", answer.status, json),
    };
  };
  return { post, taken, dispose };
}

const takeover = (reason: TakeoverRequest["reason"]): TakeoverRequest => ({
  sourceEnvironmentId: m4,
  sourceThreadId: ThreadId.make("thread-m4"),
  epoch: 2,
  sequence: 1,
  reason,
  modelSelection: null,
});

/** No answer: none of the refusal fields any release reads as a definite refusal. */
const expectNoAnswer = (answer: {
  readonly status: number;
  readonly json: Record<string, unknown>;
}) => {
  expect(answer.status).toBe(503);
  expect(answer.json).not.toHaveProperty("error");
  expect(answer.json).not.toHaveProperty("code");
  expect(answer.json).not.toHaveProperty("check");
};

const RETIRED = ["sleep", "auto-takeover"] as const;

describe("a sleep or silence start the route refuses unread", () => {
  it.each(RETIRED)("%s: a revoked grant or no credential is no answer", async (reason) => {
    const app = api({});
    try {
      for (const bearer of ["revoked", "unknown"]) {
        const answer = await app.post("takeover", bearer, takeover(reason));
        expectNoAnswer(answer);
        expect(answer.read?.uncertain).toBe(true);
      }
      expect(app.taken).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

  it.each(RETIRED)("%s: a body this release cannot check is no answer", async (reason) => {
    const app = api({});
    try {
      const { sequence: _dropped, ...unchecked } = takeover(reason);
      const answer = await app.post("takeover", "granted", unchecked);
      expectNoAnswer(answer);
      expect(answer.read?.uncertain).toBe(true);
      expect(app.taken).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

  it("while this machine updates, every takeover is no answer", async () => {
    const app = api({ held: true });
    try {
      for (const reason of ["sleep", "machine-handoff"] as const) {
        const answer = await app.post("takeover", "granted", takeover(reason));
        expectNoAnswer(answer);
        expect(answer.read?.uncertain).toBe(true);
      }
      // Guard: any other path keeps its structured answer.
      const other = await app.post("negotiate", "granted", {});
      expect(other.status).toBe(503);
      expect(other.json).toMatchObject({ code: "busy" });
      expect(app.taken).toEqual([]);
    } finally {
      await app.dispose();
    }
  });

  it("guard: a takeover asked by hand keeps its definite refusals", async () => {
    const app = api({});
    try {
      const revoked = await app.post("takeover", "revoked", takeover("machine-handoff"));
      expect(revoked.status).toBe(403);
      expect(revoked.json).toMatchObject({ code: "needs_grant", check: "grant" });
      expect(revoked.read?.uncertain).toBe(false);
      const { sequence: _dropped, ...unchecked } = takeover("machine-handoff");
      expect((await app.post("takeover", "granted", unchecked)).status).toBe(400);
    } finally {
      await app.dispose();
    }
  });
});

describe("the receiver's answer to a sleep or silence start", () => {
  it("one in doubt goes out as no answer; a proven new one as a refusal", async () => {
    const app = api({
      takeover: (request) =>
        Effect.fail(
          request.epoch === 2
            ? new HandoffRefusal({
                status: 503,
                code: "unreachable",
                message: "Minis: an earlier start of this thread here cannot be settled",
                inDoubt: true,
              })
            : new HandoffRefusal({ status: 409, code: "invalid", message: "Minis: retired" }),
        ),
    });
    try {
      const doubt = await app.post("takeover", "granted", takeover("sleep"));
      expectNoAnswer(doubt);
      expect(doubt.read?.uncertain).toBe(true);
      const refused = await app.post("takeover", "granted", { ...takeover("sleep"), epoch: 3 });
      expect(refused.status).toBe(409);
      expect(refused.read).toMatchObject({ code: "invalid", uncertain: false });
      expect(app.taken).toHaveLength(2);
    } finally {
      await app.dispose();
    }
  });

  it("guard: a continuation it proves answers with its thread", async () => {
    const app = api({});
    try {
      const answer = await app.post("takeover", "granted", takeover("auto-takeover"));
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ threadId: response.threadId });
    } finally {
      await app.dispose();
    }
  });
});
