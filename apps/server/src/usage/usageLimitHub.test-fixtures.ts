// @effect-diagnostics nodeBuiltinImport:off - this fixture owns a loopback-only HTTP peer.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

export type HubAccount = {
  id: string;
  auth_index: string;
  provider: string;
  disabled?: boolean;
  email?: string;
  id_token?: { chatgpt_account_id?: string; chatgpt_plan_type?: string };
};
type HubBody = {
  auth_index?: string;
  method?: string;
  url?: string;
  header?: Record<string, string>;
  data?: string;
};
export type HubRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: HubBody | undefined;
};
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Real HTTP transport; upstream URLs are inspected as data and never fetched. */
export const makeHub = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-10-09T00:00:00Z"));
  const requests: HubRequest[] = [];
  const violations: string[] = [];
  let heldList:
    | { entered: ReturnType<typeof latch>; release: ReturnType<typeof latch> }
    | undefined;
  const state = {
    accounts: [
      {
        id: "codex.json",
        auth_index: "codex-index",
        provider: "codex",
        email: "synthetic@example.test",
        id_token: { chatgpt_account_id: "synthetic-account", chatgpt_plan_type: "pro" },
      },
      { id: "claude.json", auth_index: "claude-index", provider: "claude" },
    ] as HubAccount[],
    authStatus: 200,
    authMalformed: false,
    usageStatus: {} as Record<string, number>,
    malformedUsage: new Set<string>(),
    creditsStatus: 200,
    cooldownStatus: 200,
    consumeCode: "reset",
    spent: false,
  };
  const server = NodeHttp.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as HubBody) : undefined;
      const path = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        path,
        authorization: req.headers.authorization,
        body,
      });
      if (req.headers.authorization !== "Bearer synthetic-management-key") {
        violations.push("Unexpected management authentication");
        res.writeHead(401).end();
        return;
      }
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (path === "/v0/management/auth-files" && req.method === "GET") {
        const files = structuredClone(state.accounts);
        const held = heldList;
        heldList = undefined;
        if (held) {
          held.entered.resolve();
          await held.release.promise;
        }
        if (state.authMalformed) {
          res.writeHead(200).end("invalid json");
          return;
        }
        json({ files }, state.authStatus);
        return;
      }
      if (path === "/v0/management/reset-quota" && req.method === "POST") {
        json({}, state.cooldownStatus);
        return;
      }
      if (path !== "/v0/management/api-call" || req.method !== "POST" || !body) {
        violations.push("Unexpected management route");
        res.writeHead(404).end();
        return;
      }
      if (body.header?.Authorization !== "Bearer $TOKEN$")
        violations.push("Credential substitution escaped the hub boundary");
      const upstream = (value: unknown, status = 200) =>
        json({ status_code: status, body: JSON.stringify(value) });
      if (body.url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume") {
        if (state.consumeCode === "reset" || state.consumeCode === "already_redeemed")
          state.spent = true;
        upstream({ code: state.consumeCode });
        return;
      }
      if (body.url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
        upstream(
          {
            credits: state.spent
              ? []
              : [
                  {
                    id: "later",
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-02-01T00:00:00Z",
                  },
                  {
                    id: "first",
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-01-01T00:00:00Z",
                  },
                  {
                    id: "expired",
                    status: "available",
                    reset_type: "codex_rate_limits",
                    expires_at: "2000-01-01T00:00:00Z",
                  },
                  {
                    id: "used",
                    status: "redeemed",
                    reset_type: "codex_rate_limits",
                    expires_at: "2099-01-01T00:00:00Z",
                  },
                ],
          },
          state.creditsStatus,
        );
        return;
      }
      if (state.malformedUsage.has(body.auth_index ?? "")) {
        json({ status_code: 200, body: "invalid JSON" });
        return;
      }
      if (body.url === "https://chatgpt.com/backend-api/wham/usage") {
        upstream(
          {
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                reset_at: 4070908800,
                limit_window_seconds: 18000,
              },
              secondary_window: { used_percent: 75, reset_at: null, limit_window_seconds: 604800 },
            },
          },
          state.usageStatus[body.auth_index ?? ""] ?? 200,
        );
        return;
      }
      if (body.url?.startsWith("https://api.anthropic.com/api/oauth/usage")) {
        const query = new URL(body.url).searchParams;
        if (query.get("cedar_ember") !== "1" || query.get("skip_spend") !== "1")
          violations.push("Claude usage query lost the CLI's banked-reset parameters");
        upstream(
          {
            five_hour: { utilization: 15, resets_at: "2099-01-01T00:00:00Z" },
            seven_day: { utilization: 40, resets_at: null },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 50,
                resets_at: null,
                scope: { model: { display_name: "Synthetic model" } },
              },
              { kind: "ignored", percent: 70 },
            ],
          },
          state.usageStatus[body.auth_index ?? ""] ?? 200,
        );
        return;
      }
      violations.push("Unexpected upstream descriptor");
      res.writeHead(400).end();
    } catch {
      violations.push("Malformed HTTP request");
      res.writeHead(400).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback listener missing");
  return {
    state,
    requests,
    violations,
    config: {
      kind: "cliproxy",
      url: `http://127.0.0.1:${address.port}`,
      managementKey: "synthetic-management-key",
      enabled: true,
    } as const,
    holdNextList: () => {
      if (heldList) throw new Error("A list response is already held");
      const held = { entered: latch(), release: latch() };
      heldList = held;
      return { entered: held.entered.promise, release: held.release.resolve };
    },
  };
});
export const transport = Layer.mergeAll(FetchHttpClient.layer, NodeCrypto.layer);
