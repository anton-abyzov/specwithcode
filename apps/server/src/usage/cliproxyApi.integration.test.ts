import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { makeHub, transport } from "./usageLimitHub.test-fixtures.ts";

describe("CLIProxyAPI loopback HTTP integration", () => {
  it.effect(
    "authenticates management requests, filters accounts and retains provider quota/credit semantics",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub;
        hub.state.accounts.push(
          { id: "disabled", auth_index: "disabled", provider: "codex", disabled: true },
          { id: "other", auth_index: "other", provider: "unsupported" },
        );
        const api = yield* makeCliproxyApi;
        const accounts = yield* api.readAccounts(hub.config);
        expect(accounts.map((a) => a.id)).toEqual(["codex.json"]);
        expect(accounts[0]?.usageLimits.windows.map((w) => w.usedPercent)).toEqual([20, 75]);
        expect(accounts[0]?.usageLimits.resetCredits).toEqual({
          availableCount: 2,
          nextCreditId: "first",
          nextExpiresAt: "2099-01-01T00:00:00.000Z",
        });
        const calls = hub.requests.filter((r) => r.body?.url);
        expect(calls.every((r) => r.method === "POST" && r.body?.method === "GET")).toBe(true);
        expect(
          calls
            .filter((r) => r.body?.auth_index === "codex-index")
            .every((r) => r.body?.header?.["Chatgpt-Account-Id"] === "synthetic-account"),
        ).toBe(true);
        // Claude sign-ins never leave Claude Code, so the hub is never asked to use one.
        expect(hub.requests.some((r) => r.body?.auth_index === "claude-index")).toBe(false);
        expect(hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "isolates a malformed account and keeps valid quota when the credits endpoint fails",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub;
        const api = yield* makeCliproxyApi;
        hub.state.creditsStatus = 503;
        const accounts = yield* api.readAccounts(hub.config);
        expect(accounts[0]?.usageLimits.windows.map((w) => w.usedPercent)).toEqual([20, 75]);
        expect(accounts[0]?.usageLimits.resetCredits).toBeUndefined();
        expect(hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "reports invalid hub, management HTTP and malformed-list errors without exposing credentials",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub;
        const api = yield* makeCliproxyApi;
        for (const mode of ["http", "json", "url"] as const) {
          hub.state.authStatus = mode === "http" ? 503 : 200;
          hub.state.authMalformed = mode === "json";
          const error = yield* api
            .readAccounts(mode === "url" ? { ...hub.config, url: "invalid" } : hub.config)
            .pipe(Effect.flip);
          expect(error.detail).toBe("The hub could not list accounts.");
          expect(error.message).not.toContain(hub.config.managementKey);
        }
        expect(hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "deduplicates redemption identity and clears cooldown only for successful/idempotent outcomes",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub;
        const api = yield* makeCliproxyApi;
        expect(yield* api.consume(hub.config, "codex.json", "first")).toEqual({ outcome: "reset" });
        hub.state.consumeCode = "already_redeemed";
        expect(yield* api.consume(hub.config, "codex.json", "first")).toEqual({
          outcome: "alreadyRedeemed",
        });
        const redemptions = hub.requests.filter((r) => r.body?.url?.endsWith("/consume"));
        const bodies = redemptions.map((r) => JSON.parse(r.body!.data!));
        expect(bodies[0]).toEqual(bodies[1]);
        expect(bodies[0].credit_id).toBe("first");
        expect(bodies[0].redeem_request_id).toMatch(
          /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        );
        expect(hub.requests.filter((r) => r.path.endsWith("reset-quota"))).toHaveLength(2);
        for (const [code, outcome] of [
          ["nothing_to_reset", "nothingToReset"],
          ["no_credit", "noCredit"],
        ] as const) {
          hub.state.consumeCode = code;
          expect(yield* api.consume(hub.config, "codex.json", "later")).toEqual({ outcome });
        }
        expect(hub.requests.filter((r) => r.path.endsWith("reset-quota"))).toHaveLength(2);
        hub.state.consumeCode = "reset";
        hub.state.cooldownStatus = 503;
        expect(yield* api.consume(hub.config, "codex.json", "later")).toMatchObject({
          outcome: "reset",
          warning: expect.stringContaining("cooldown could not be cleared"),
        });
        expect(hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );

  it.effect(
    "refuses missing, disabled and unsupported accounts and malformed Claude grants before redemption and sanitizes malformed redemption responses",
    () =>
      Effect.gen(function* () {
        const hub = yield* makeHub;
        const api = yield* makeCliproxyApi;
        hub.state.accounts.push({ id: "other", auth_index: "other", provider: "unsupported" });
        hub.state.accounts[0]!.disabled = true;
        hub.state.accounts[1]!.disabled = true;
        for (const id of ["missing", "codex.json", "claude.json", "other"])
          expect((yield* api.consume(hub.config, id, "first").pipe(Effect.flip)).detail).toBe(
            "The hub account is missing or disabled.",
          );
        hub.state.accounts[1]!.disabled = false;
        expect(
          (yield* api.consume(hub.config, "claude.json", "first").pipe(Effect.flip)).detail,
        ).toBe("The hub account is missing or disabled.");
        expect(hub.requests.every((r) => r.path.endsWith("auth-files"))).toBe(true);
        hub.state.accounts[0]!.disabled = false;
        hub.state.consumeCode = "unexpected";
        expect(
          (yield* api.consume(hub.config, "codex.json", "first").pipe(Effect.flip)).detail,
        ).toBe("The hub returned an unexpected reset-credit response.");
        expect(hub.requests.filter((r) => r.path.endsWith("reset-quota"))).toHaveLength(0);
        expect(hub.violations).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(transport)),
  );
});
