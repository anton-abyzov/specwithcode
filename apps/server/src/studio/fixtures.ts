import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings, type ServerProvider } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const settings = Schema.decodeUnknownSync(ServerSettings)({});
export function provider(id = "codex", driver = "codex", now = DateTime.toEpochMillis(DateTime.nowUnsafe())): ServerProvider {
  return { instanceId: ProviderInstanceId.make(id), driver: ProviderDriverKind.make(driver), enabled: true,
    installed: true, status: "ready", auth: { status: "authenticated", type: driver === "codex" ? "chatgpt" : "max" },
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), version: null, models: [], slashCommands: [], skills: [], usageLimits: {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), windows: [], nativeRouteVerified: true, nativeRouteObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
      quotaPoolObservedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    },
  };
}
export function rawAccount(id = "codex-1", now = DateTime.toEpochMillis(DateTime.nowUnsafe())) {
  return {
    id,
    provider: id.startsWith("codex") ? "codex" : "claude",
    authenticated: true,
    status: "ready",
    authKind: id.startsWith("codex") ? "chatgpt" : "claude.ai",
    authError: null,
    quota: {
      window: { usedPercent: 10, resetsAt: Math.floor(now / 1000) + 3600 },
      weekly: { usedPercent: 25, resetsAt: Math.floor(now / 1000) + 86400 },
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 15 * 60000)),
      source: "native-app-server",
    },
  };
}
export function rawSnapshot(now = DateTime.toEpochMillis(DateTime.nowUnsafe())) {
  return {
    accounts: [rawAccount("codex-1", now)],
    policy: { mode: "balanced", preferredProvider: null, selectedAccount: null },
  };
}
