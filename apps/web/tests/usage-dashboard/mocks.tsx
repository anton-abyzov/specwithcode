// Synthetic history only. No server, credentials, accounts or store.
import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
} from "@specweave-studio/contracts";
import { mergeUsage } from "@specweave-studio/shared/usageMerge";
import { useMemo } from "react";
import { enumerateHourStarts } from "@specweave-studio/shared/usageFormat";
const id = EnvironmentId.make("dashboard-fixture");
const now = Date.now();
const params = new URLSearchParams(location.search);
const providers = [
  { driver: "claudeAgent", auth: { status: "authenticated", apiKeyBilling: true } },
  {
    driver: "codex",
    auth: { status: "authenticated", type: "chatgpt" },
    usageLimits: {
      checkedAt: new Date(now).toISOString(),
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 38,
          resetsAt: new Date(now + 86400000).toISOString(),
        },
      ],
    },
  },
  { driver: "acp", displayName: "GitHub Copilot", auth: { status: "authenticated" } },
].map((p) => ({
  ...p,
  displayName:
    p.driver === "claudeAgent" ? "Claude Code" : p.driver === "codex" ? "Codex" : p.displayName,
  instanceId: p.driver,
  enabled: true,
  installed: true,
  models: [],
}));
export const environmentPresentations = {
  presentationsAtom: Atom.make(
    new Map([
      [
        id,
        {
          entry: { target: { label: "Fixture machine" } },
          connection: { phase: "connected" },
          serverConfig: { providers },
        },
      ],
    ]),
  ),
};
export const primaryServerKeybindingsAtom = Atom.make([]);
export const serverEnvironment = { refreshProviders: Symbol(), updateSettings: Symbol() };
export const useAtomCommand = () => async () => {};
export const isElectron = false;
export const SidebarInset = ({ children, className, ...props }: any) => (
  <main {...props} className={`relative flex min-w-0 w-full flex-1 flex-col ${className ?? ""}`}>
    {children}
  </main>
);
export const UsageLimitsSection = () => <p>Limits fixture</p>;
export const UsagePriceOverrides = () => null;
export const ensureLocalApi = () => ({ shell: { openExternal: () => {} } });
export const useNavigate = () => () => {};
export const useCanGoBack = () => false;
export const usePrimarySettings = () => "locale";
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = () => true;
export function mergeAnsweredUsage(
  environments: any[],
  keepBucket?: (bucket: UsageBucket) => boolean,
) {
  return mergeUsage(
    environments.map((e) => ({
      ...e,
      summary: {
        ...e.summary,
        buckets: keepBucket ? e.summary.buckets.filter(keepBucket) : e.summary.buckets,
      },
    })),
    USAGE_CONTRACT_VERSION,
  );
}
export function useUsage(window: any) {
  return useMemo(() => {
    const buckets: any[] = [];
    const days = [];
    for (
      let d = new Date(window.sinceDay + "T00:00:00Z");
      d.toISOString().slice(0, 10) <= window.untilDay;
      d.setUTCDate(d.getUTCDate() + 1)
    )
      days.push(d.toISOString().slice(0, 10));
    const periods = window.sinceTime
      ? enumerateHourStarts(window.sinceTime, window.untilTime).map((hourStart) => ({
          day: new Intl.DateTimeFormat("en-CA", {
            timeZone: window.timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(hourStart)),
          hourStart,
        }))
      : days.map((day) => ({ day, hourStart: undefined }));
    periods.forEach(({ day, hourStart }, index) =>
      ["claude", "codex"].forEach((provider, n) => {
        if (params.has("insufficient") && index < periods.length - 2) return;
        const value = 12 + ((index * 17 + n * 11) % 60);
        const unpriced =
          params.has("unpriced") ||
          (provider === "claude" &&
            (index === 0 || (params.has("partial-cost") && index % 9 === 0)));
        buckets.push({
          sourceId: provider,
          provider,
          day,
          ...(hourStart ? { hourStart } : {}),
          model:
            provider === "claude"
              ? ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5"][index % 3]
              : ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"][index % 3],
          serviceTier: "standard",
          speed: "standard",
          records: 12,
          unpricedRecords: unpriced ? 12 : 0,
          sessions: 12,
          costSource: unpriced ? "unpriced" : "modelPriced",
          costUsd: unpriced ? 0 : value,
          totals: {
            uncachedInputTokens: value * 13000,
            cachedInputTokens: value * 9000,
            cacheCreationTokens: value * 1000,
            outputTokens: value * 1800,
            reasoningTokens: 0,
          },
          categoryCostUsd: {
            input: unpriced ? 0 : value * 0.15,
            cacheRead: unpriced ? 0 : value * 0.35,
            cacheWrite: unpriced ? 0 : value * 0.2,
            output: unpriced ? 0 : value * 0.2,
          },
          cacheSavingsUsd: unpriced ? 0 : value * 0.3,
        });
      }),
    );
    const sources = ["claude", "codex"].map((provider) => ({
      sourceId: provider,
      distinctSessions: 64,
      status: params.has("partial") ? "partial" : "ok",
      message: null,
      scannedFiles: 64,
      skippedFiles: 0,
      malformedRecords: 0,
      fingerprint: {
        provider,
        hostId: "fixture",
        resolvedHomePath: "/fixture/" + provider,
        volumeId: provider,
      },
    }));
    const environments = [
      {
        environmentId: id,
        label: "Fixture machine",
        canReadDiagnostics: true,
        isPending: false,
        error: null,
        needsCursorKeychainAccess: false,
        summary: {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: new Date(now - (params.has("stale") ? 2 * 60 * 60_000 : 0)).toISOString(),
          ...window,
          buckets,
          sources,
          pricing: { status: "fresh", source: "fixture", fetchedAt: null, knownModels: 2 },
          scanDurationMs: 1,
        },
      },
    ];
    return {
      merged: mergeAnsweredUsage(environments),
      environments,
      selectedEnvironments: environments,
      isPending: false,
      isPartial: false,
      refresh: async () => {},
    };
  }, [window]);
}
