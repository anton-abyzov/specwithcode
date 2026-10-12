import { ProviderDriverKind, ProviderInstanceId, ServerSettings, type ServerProvider } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const settings = Schema.decodeUnknownSync(ServerSettings)({});
export function provider(id = "codex", driver = "codex", now = Date.now()): ServerProvider {
  return { instanceId: ProviderInstanceId.make(id), driver: ProviderDriverKind.make(driver), enabled: true,
    installed: true, status: "ready", auth: { status: "authenticated", type: driver === "codex" ? "chatgpt" : "max" },
    checkedAt: new Date(now).toISOString(), version: null, models: [], slashCommands: [], skills: [], usageLimits: {
      checkedAt: new Date(now).toISOString(), windows: [], nativeRouteVerified: true, nativeRouteObservedAt: new Date(now).toISOString(), quotaPoolId: `codex:sha256:${"a".repeat(64)}`, quotaPoolObservedAt: new Date(now).toISOString(),
    } };
}
export function rawAccount(id = "codex-1", now = Date.now()) {
  return { id, provider: id.startsWith("codex") ? "codex" : "claude", authenticated: true, status: "ready",
    authKind: id.startsWith("codex") ? "chatgpt" : "claude.ai", authError: null,
    quota: { window: { usedPercent: 10, resetsAt: Math.floor(now / 1000) + 3600 },
      weekly: { usedPercent: 25, resetsAt: Math.floor(now / 1000) + 86400 },
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60000).toISOString(), source: "native-app-server" } };
}
export function rawSnapshot(now = Date.now()) { return { accounts: [rawAccount("codex-1", now)], policy: { mode: "balanced", preferredProvider: null, selectedAccount: null } }; }
