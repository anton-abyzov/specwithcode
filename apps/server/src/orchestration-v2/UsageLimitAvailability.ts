// @effect-diagnostics nodeBuiltinImport:off -- Hash opaque local profile identity; never persist a home path.
import { createHash } from "node:crypto";
import type {
  OrchestrationV2LimitAvailability,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Instances from "../provider/ProviderInstanceRegistry.ts";
import * as Capacity from "../studio/Capacity.ts";
import {
  freshObservation,
  nativeQuotaDenied,
  nativeSnapshotAuthorized,
} from "../studio/capacitySnapshot.ts";
import * as Projections from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { LIMIT_CHECK_INTERVAL_MS, isLimitRecoveryCandidate } from "./usageLimitRecovery.ts";

type Result = {
  readonly mayResume?: boolean;
  readonly codex: boolean;
  readonly observation: OrchestrationV2LimitAvailability | null;
};
export class UsageLimitAvailability extends Context.Service<
  UsageLimitAvailability,
  {
    readonly bind: (
      id: ProviderInstanceId,
    ) => Effect.Effect<NonNullable<OrchestrationV2LimitAvailability["affinity"]> | null>;
    readonly check: (thread: Projections.ProjectionLimitRecoveryCandidate) => Effect.Effect<Result>;
  }
>()("studio/orchestration-v2/UsageLimitAvailability") {}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
const pool = (provider: ServerProvider | undefined) => {
  const id = provider?.usageLimits?.quotaPoolId;
  return id && /^codex:sha256:[a-f0-9]{64}$/.test(id) ? id : undefined;
};

export const layer = Layer.effect(
  UsageLimitAvailability,
  Effect.gen(function* () {
    const providers = yield* Providers.ProviderRegistry;
    const instances = yield* Instances.ProviderInstanceRegistry;
    const capacity = yield* Capacity.Capacity;
    const projections = yield* Projections.ProjectionStoreV2;
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    // One bounded metadata probe per profile per minute, including repeated manual clicks.
    // Durable retryAt below also preserves automatic backoff across server restarts.
    const lastChecks = new Map<ProviderInstanceId, number>();
    const bind = (id: ProviderInstanceId) =>
      Effect.gen(function* () {
        const instance = yield* instances.getInstance(id);
        const current = (yield* providers.getProviders).find((p) => p.instanceId === id);
        const now = yield* Clock.currentTimeMillis;
        const quotaPoolId = pool(current);
        if (
          !instance?.enabled ||
          instance.driverKind !== "codex" ||
          !quotaPoolId ||
          !nativeSnapshotAuthorized(current, now) ||
          !freshObservation(current?.usageLimits?.quotaPoolObservedAt, now)
        )
          return null;
        return {
          instanceId: id,
          continuationKey: fingerprint(instance.continuationIdentity.continuationKey),
          quotaPoolId,
        };
      });
    return UsageLimitAvailability.of({
      bind,
      check: Effect.fn("UsageLimitAvailability.check")(function* (thread) {
        const instance = yield* instances.getInstance(thread.providerInstanceId);
        if (instance && instance.driverKind !== "codex") return { codex: false, observation: null };
        const now = yield* Clock.currentTimeMillis;
        const previous = thread.limitRecovery?.availability;
        if (!isLimitRecoveryCandidate(thread) || !thread.limitRecovery)
          return { codex: true, observation: null };
        const before = (yield* providers.getProviders).find(
          (p) => p.instanceId === thread.providerInstanceId,
        );
        const beforePool = pool(before);
        const key = instance
          ? fingerprint(instance.continuationIdentity.continuationKey)
          : undefined;
        const affinity =
          thread.limitRecovery.armedAffinity ??
          previous?.affinity ??
          (key && beforePool
            ? {
                instanceId: thread.providerInstanceId,
                continuationKey: key,
                quotaPoolId: beforePool,
              }
            : undefined);
        if (
          (!thread.limitRecovery.checkNow && previous && Date.parse(previous.retryAt) > now) ||
          now - (lastChecks.get(thread.providerInstanceId) ?? -Infinity) < 60_000
        )
          return {
            codex: true,
            observation: null,
            mayResume:
              !!affinity &&
              affinity.continuationKey === key &&
              affinity.quotaPoolId === beforePool &&
              nativeSnapshotAuthorized(before, now) &&
              before?.usageLimits?.ordinaryUsageAllowed === true &&
              freshObservation(before.usageLimits.nativeAllowanceObservedAt, now) &&
              !nativeQuotaDenied(before.usageLimits, now),
          };
        lastChecks.set(thread.providerInstanceId, now);
        const observe = (
          status: OrchestrationV2LimitAvailability["status"],
          at: number,
          identity = affinity,
        ): Result => ({
          codex: true,
          mayResume: status === "allowed",
          observation: {
            checkedAt: new Date(at).toISOString(),
            retryAt: new Date(at + LIMIT_CHECK_INTERVAL_MS).toISOString(),
            threadUpdatedAt: DateTime.formatIso(thread.updatedAt),
            status,
            ...(identity ? { affinity: identity } : {}),
          },
        });
        if (!instance?.enabled || !key) return observe("unknown", now);
        if (
          affinity &&
          (affinity.instanceId !== thread.providerInstanceId ||
            affinity.continuationKey !== key ||
            (beforePool && affinity.quotaPoolId !== beforePool))
        )
          return observe("changed", now);
        const result = yield* Effect.gen(function* () {
          const refreshed = yield* providers.refreshInstance(thread.providerInstanceId);
          const current = refreshed.find((p) => p.instanceId === thread.providerInstanceId);
          const afterInstance = yield* instances.getInstance(thread.providerInstanceId);
          const at = yield* Clock.currentTimeMillis;
          const limits = current?.usageLimits;
          if (afterInstance !== instance || (affinity && pool(current) !== affinity.quotaPoolId))
            return observe("changed", at);
          if (!affinity)
            return observe(
              "unknown",
              at,
              pool(current)
                ? {
                    instanceId: thread.providerInstanceId,
                    continuationKey: key,
                    quotaPoolId: pool(current)!,
                  }
                : undefined,
            );
          const observedAt = Date.parse(limits?.nativeAllowanceObservedAt ?? "");
          if (
            !nativeSnapshotAuthorized(current, at) ||
            !limits ||
            limits.unavailable ||
            !freshObservation(limits.quotaPoolObservedAt, at) ||
            !freshObservation(limits.nativeAllowanceObservedAt, at) ||
            observedAt < now ||
            observedAt <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
          )
            return observe("unknown", at);
          if (nativeQuotaDenied(limits, at)) return observe("denied", at);
          if (limits.ordinaryUsageAllowed !== true || limits.spendControlReached === true)
            return observe("unknown", at);
          // Old failures never carried account identity. A new account read cannot
          // retroactively bind that run; an explicit user arm is required.
          if (
            thread.limitRecovery?.autoResume &&
            (thread.limitRecovery.explicitArm !== true || !thread.limitRecovery.armedAffinity)
          )
            return observe("unknown", at);
          const stored = yield* projections.getThread(thread.id);
          const runtime = yield* policy.resolve({
            thread: stored,
            modelSelection: stored.modelSelection,
          });
          // Reuse native subscription route/auth/profile admission for this actual cwd.
          yield* capacity.assertNativeStart(thread.providerInstanceId, runtime.cwd);
          const finalInstance = yield* instances.getInstance(thread.providerInstanceId);
          const finalSnapshot = (yield* providers.getProviders).find(
            (p) => p.instanceId === thread.providerInstanceId,
          );
          const completedAt = yield* Clock.currentTimeMillis;
          if (finalInstance !== instance || pool(finalSnapshot) !== affinity.quotaPoolId)
            return observe("changed", completedAt);
          if (nativeQuotaDenied(finalSnapshot?.usageLimits, completedAt))
            return observe("denied", completedAt);
          if (
            !nativeSnapshotAuthorized(finalSnapshot, completedAt) ||
            finalSnapshot?.usageLimits?.ordinaryUsageAllowed !== true ||
            !freshObservation(finalSnapshot.usageLimits.nativeAllowanceObservedAt, completedAt)
          )
            return observe("unknown", completedAt);
          return observe("allowed", observedAt);
        }).pipe(
          Effect.timeoutOption("20 seconds"),
          Effect.catchCause(() => Effect.succeed(Option.none<Result>())),
        );
        return Option.isSome(result)
          ? result.value
          : observe("unknown", yield* Clock.currentTimeMillis);
      }),
    });
  }),
);
