import { describe, expect, it } from "@effect/vitest";
import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProvider,
  ServerProviders,
  ServerSettings,
} from "@specweave-studio/contracts";
import * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { checkCodexProviderStatus, readCodexProviderMetadata } from "./CodexProvider.ts";
import { withInstanceIdentity } from "./Drivers/instanceIdentity.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

// Synthetic account metadata with the ten fractional digits returned by the
// installed native CLI. No real account, provider process or network is used.
const nativeBalance = "1234.1234567890";
const driverKind = ProviderDriverKind.make("codex");
const instanceId = defaultInstanceIdForDriver(driverKind);

describe("default Codex provider wire snapshot", () => {
  for (const ordinaryUsageAllowed of [true, false]) {
    it.effect(
      `retains Codex and its exact credits when ordinary usage is ${ordinaryUsageAllowed}`,
      () =>
        Effect.gen(function* () {
          const settings = Schema.decodeUnknownSync(ServerSettings)({
            providers: { codex: { enabled: true, binaryPath: "fixture-only-codex" } },
            providerInstances: {},
          });
          const entry = deriveProviderInstanceConfigMap(settings)[instanceId];
          expect(entry?.driver).toBe(driverKind);
          const codexSettings = Schema.decodeUnknownSync(CodexSettings)(entry?.config);
          const rateLimitsResponse = Schema.decodeUnknownSync(
            CodexSchema.V2GetAccountRateLimitsResponse,
          )({
            accountId: "synthetic-native-account",
            ordinaryUsageAllowed,
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: ordinaryUsageAllowed ? 20 : 100, windowDurationMins: 10080 },
              spendControlReached: false,
              rateLimitReachedType: ordinaryUsageAllowed ? null : "rate_limit_reached",
              credits: { hasCredits: true, unlimited: false, balance: nativeBalance },
            },
            rateLimitResetCredits: { availableCount: 3 },
          });
          const client = {
            request: (method: string) => {
              if (method === "account/rateLimits/read") return Effect.succeed(rateLimitsResponse);
              if (method === "config/read") return Effect.succeed({ config: {}, origins: {} });
              if (method === "skills/list" || method === "model/list") {
                return Effect.succeed({ data: [] });
              }
              return Effect.die(new Error(`Unexpected fixture RPC: ${method}`));
            },
          } as Parameters<typeof readCodexProviderMetadata>[0];
          const draft = yield* checkCodexProviderStatus(codexSettings, () =>
            readCodexProviderMetadata(client, { cwd: "/fixture-only-project" }).pipe(
              Effect.map((metadata) => ({
                account: Schema.decodeUnknownSync(CodexSchema.V2GetAccountResponse)({
                  account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
                  requiresOpenaiAuth: true,
                }),
                nativeRouteVerified: metadata.nativeRouteVerified,
                ...(metadata.rateLimits ? { rateLimits: metadata.rateLimits } : {}),
                models: metadata.models,
                skills: [],
                version: "0.160.1",
              })),
            ),
          );
          const snapshot = withInstanceIdentity({
            instanceId,
            driverKind,
            displayName: undefined,
            accentColor: undefined,
            continuationGroupKey: "codex:home:/fixture-only-home",
          })(draft);

          // getConfig uses ForwardCompatibleArray; the original eight-digit
          // balance contract dropped the entire correctly identified provider.
          const wire = JSON.parse(JSON.stringify(snapshot));
          const providers = Schema.decodeUnknownSync(ServerProviders)([wire]);
          expect(providers).toHaveLength(1);
          const strict = Schema.decodeUnknownSync(ServerProvider)(wire);
          const roundtrip = Schema.decodeUnknownSync(ServerProvider)(
            Schema.encodeSync(ServerProvider)(strict),
          );
          expect(providers[0]).toEqual(roundtrip);
          expect(roundtrip.instanceId).toBe("codex");
          expect(roundtrip.driver).toBe("codex");
          expect(roundtrip.auth.status).toBe("authenticated");
          expect(roundtrip.status).toBe("ready");
          expect(roundtrip.usageLimits?.credits?.balance).toBe(nativeBalance);
          expect(roundtrip.usageLimits?.ordinaryUsageAllowed).toBe(ordinaryUsageAllowed);
          expect(roundtrip.usageLimits?.spendControlReached).toBe(false);
          expect(roundtrip.usageLimits?.resetCredits?.availableCount).toBe(3);
          expect(roundtrip.usageLimits?.nativeRouteVerified).toBe(true);
          expect(roundtrip.usageLimits?.quotaPoolId).toMatch(/^codex:sha256:[a-f0-9]{64}$/);
          expect(JSON.stringify(roundtrip)).not.toContain("synthetic-native-account");
        }).pipe(Effect.provide(Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}))),
    );
  }
});
