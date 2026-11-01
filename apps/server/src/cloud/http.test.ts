import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectPhoneRevocation from "./ConnectPhoneRevocation.ts";
import * as ConnectHttp from "./http.ts";

class ConnectTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.connect) {}

// The signed relay routes need no session, so a CloudLink that fails each
// request shows how the transport answers that failure.
type HealthFailure = Effect.Error<
  ReturnType<CloudLink.CloudLink["Service"]["answerHealthRequest"]>
>;

const postSignedRelayRequest = async (input: {
  readonly path: string;
  readonly cloudLink?: Partial<CloudLink.CloudLink["Service"]>;
  readonly phoneRevocation?: Partial<ConnectPhoneRevocation.ConnectPhoneRevocation["Service"]>;
}) => {
  const layerRoutes = HttpApiBuilder.layer(ConnectTestApi).pipe(
    Layer.provide(ConnectHttp.layer),
    Layer.provide(Layer.mock(CloudLink.CloudLink)(input.cloudLink ?? {})),
    Layer.provide(
      Layer.mock(ConnectPhoneRevocation.ConnectPhoneRevocation)(input.phoneRevocation ?? {}),
    ),
    // The session-gated routes are declared too; this request never reaches them.
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerRoutes, {
    disableLogger: true,
  });
  try {
    const response = await handler(
      new Request(`http://127.0.0.1${input.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proof: "proof" }),
      }),
    );
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: (await response.json()) as unknown,
    };
  } finally {
    await dispose();
  }
};

const answerHealthWith = async (failure: HealthFailure) => {
  const { status, body } = await postSignedRelayRequest({
    path: "/api/studio-connect/health",
    cloudLink: { answerHealthRequest: () => Effect.fail(failure) },
  });
  return { status, body };
};

describe("connect routes", () => {
  it.each([
    {
      failure: new CloudLink.CloudLinkProofRejectedError({ request: "health" }),
      status: 401,
      body: { _tag: "EnvironmentHttpUnauthorizedError", message: "Invalid cloud health request." },
    },
    {
      failure: new CloudLink.CloudLinkProofReplayedError({ request: "health" }),
      status: 409,
      body: {
        _tag: "EnvironmentHttpConflictError",
        message: "Cloud health request was already consumed.",
      },
    },
    {
      failure: new CloudLink.CloudLinkInternalError({
        operation: "answer-health",
        cause: new Error("disk full"),
      }),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Could not answer cloud health request.",
      },
    },
    {
      failure: new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({}),
      status: 500,
      body: {
        _tag: "EnvironmentHttpInternalServerError",
        message: "Cloud mint public key is not installed for this environment.",
      },
    },
  ])("answers $failure._tag with HTTP $status", async ({ failure, status, body }) => {
    const response = await answerHealthWith(failure);
    expect(response).toEqual({ status, body });
  });

  it("serves the relay's order to end removed phones' sessions", async () => {
    const proofs: Array<string> = [];
    const response = await postSignedRelayRequest({
      path: "/api/studio-connect/revoke-client-keys",
      phoneRevocation: {
        revokeClientKeys: (request) =>
          Effect.sync(() => {
            proofs.push(request.proof);
            return { revoked: 2 };
          }),
      },
    });
    expect(response).toEqual({ status: 200, cacheControl: "no-store", body: { revoked: 2 } });
    expect(proofs).toEqual(["proof"]);
  });

  it("refuses a revoke order whose proof does not verify", async () => {
    const response = await postSignedRelayRequest({
      path: "/api/studio-connect/revoke-client-keys",
      phoneRevocation: {
        revokeClientKeys: () =>
          Effect.fail(new CloudLink.CloudLinkProofRejectedError({ request: "revoke" })),
      },
    });
    expect(response).toMatchObject({
      status: 401,
      body: { _tag: "EnvironmentHttpUnauthorizedError", message: "Invalid cloud revoke request." },
    });
  });
});
