import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { describe, expect, it } from "vite-plus/test";

import * as Auth from "./auth/EnvironmentAuth.ts";
import * as AuthHttp from "./auth/http.ts";
import * as CloudSessions from "./cloudSessions/CloudSessions.ts";
import * as CloudSessionsHttp from "./cloudSessionsHttp.ts";
import * as Config from "./config.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.cloudSessions) {}

const availability = {
  status: "needs_login" as const,
  cliVersion: "2.1.301",
  authMethod: "none",
  subscriptionType: null,
  reason: "Claude Code is not signed in.",
  fix: "Run `claude auth login` with a Pro, Max or Team account.",
  checkedAt: "2026-10-16T00:00:00.000Z",
};
const session = {
  sessionId: "session_test",
  url: "https://claude.ai/code/session_test",
  title: "Fix the flaky test",
  task: "Fix the flaky test",
  repositoryPath: "/repo",
  branch: "main",
  remoteUrl: "https://github.com/acme/app.git",
  uploaded: false,
  projectId: null,
  createdByThreadId: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  lastSentAt: null,
};

function api(scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const refreshes: Array<boolean> = [];
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(CloudSessionsHttp.layer),
    Layer.provide(
      Layer.mock(CloudSessions.CloudSessions)({
        availability: (options) =>
          Effect.sync(() => {
            refreshes.push(options?.refresh === true);
            return availability;
          }),
        list: () => Effect.succeed({ availability, sessions: [session] }),
        create: (input) =>
          input.task === "boom"
            ? Effect.fail(
                new CloudSessions.CloudSessionError({
                  reason: "invalid_request",
                  detail: "The branch has 2 unpushed commits.",
                }),
              )
            : Effect.succeed({
                session: { ...session, task: input.task, title: input.task },
                teleportCommand: "claude --teleport session_test",
              }),
      }),
    ),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: (request) =>
          request.headers.authorization === "Bearer synthetic-session"
            ? Effect.succeed({
                sessionId: AuthSessionId.make("synthetic-session"),
                subject: "fixture",
                method: "bearer-access-token" as const,
                scopes,
              })
            : Effect.fail(new Auth.ServerAuthMissingCredentialError({})),
      }),
    ),
    Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "studio-cloud-http-" })),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  const authorized = { authorization: "Bearer synthetic-session", origin: "http://localhost:8319" };
  const get = (search = "", headers: Record<string, string> = authorized) =>
    handler(
      new Request(`http://localhost:8319/api/studio/cloud-sessions${search}`, {
        headers: { host: "localhost:8319", ...headers },
      }),
    );
  const post = (body: object, headers: Record<string, string> = authorized) =>
    handler(
      new Request("http://localhost:8319/api/studio/cloud-sessions", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:8319", ...headers },
        body: JSON.stringify(body),
      }),
    );
  return { get, post, dispose, refreshes };
}

describe("cloud sessions HTTP", () => {
  it("lists availability and sessions for a reader, re-checking the CLI only on refresh", async () => {
    const app = api([AuthOrchestrationReadScope]);
    try {
      expect((await app.get("", {})).status).toBe(401);
      const response = await app.get();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as {
        availability: { status: string };
        sessions: Array<{ sessionId: string }>;
      };
      expect(body.availability.status).toBe("needs_login");
      expect(body.sessions.map((entry) => entry.sessionId)).toEqual(["session_test"]);
      expect(app.refreshes).toEqual([]);
      expect((await app.get("?refresh=true")).status).toBe(200);
      expect(app.refreshes).toEqual([true]);
    } finally {
      await app.dispose();
    }
  });

  it("starts a session only for an operator on a same-origin request, and passes the service's words through", async () => {
    const reader = api([AuthOrchestrationReadScope]);
    const operator = api([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);
    try {
      expect((await reader.post({ task: "Fix it" })).status).toBe(403);
      expect(
        (
          await operator.post(
            { task: "Fix it" },
            { authorization: "Bearer synthetic-session", origin: "https://evil.example" },
          )
        ).status,
      ).toBe(403);
      const created = await operator.post({ task: "Fix it" });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({
        session: { sessionId: "session_test", title: "Fix it" },
        teleportCommand: "claude --teleport session_test",
      });
      const refused = await operator.post({ task: "boom" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ message: "The branch has 2 unpushed commits." });
    } finally {
      await reader.dispose();
      await operator.dispose();
    }
  });
});
