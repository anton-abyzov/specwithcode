/**
 * The key one subscription account goes by in usage reports, on every machine.
 *
 * It is the Limits views' key where they have one (`<driver>:<email>`, else the
 * credential key), so a report lines up with its limit windows and history.
 * Providers that name no email still need a key to be grouped by: the CLI's
 * login when it has one (Copilot), else the provider instance.
 *
 * @module usageAccountKey
 */
import type { ServerProvider } from "@specweave-studio/contracts";

import { limitAccountKey } from "./usageLimits.ts";

export type UsageAccountKeyProvider = Pick<ServerProvider, "driver" | "instanceId"> & {
  readonly auth: Pick<ServerProvider["auth"], "email" | "login">;
  readonly usageLimits?: ServerProvider["usageLimits"];
};

export function usageAccountKey(provider: UsageAccountKeyProvider): string {
  const limitKey = limitAccountKey(provider.driver, provider.auth.email, provider.usageLimits);
  if (limitKey !== null) return limitKey;
  const login = provider.auth.login?.trim().toLowerCase();
  return login
    ? `${provider.driver}:login:${login}`
    : `${provider.driver}:instance:${provider.instanceId}`;
}

/** The key for sessions whose account nothing on the machine could name. */
export function unknownUsageAccountKey(driver: string): string {
  return `${driver}:unknown`;
}

export function isUnknownUsageAccountKey(accountKey: string): boolean {
  return accountKey.endsWith(":unknown");
}

/** The driver a key belongs to: everything before its first colon. */
export function usageAccountKeyDriver(accountKey: string): string {
  const colon = accountKey.indexOf(":");
  return colon === -1 ? accountKey : accountKey.slice(0, colon);
}

/**
 * What to call an account when no provider instance names it: the email or
 * login inside the key. Null for credential, instance and unknown keys, which
 * hold nothing a person would recognise.
 */
export function usageAccountKeyName(accountKey: string): string | null {
  const rest = accountKey.slice(usageAccountKeyDriver(accountKey).length + 1);
  if (rest.startsWith("login:")) return rest.slice("login:".length) || null;
  if (rest === "unknown" || rest.startsWith("credential:") || rest.startsWith("instance:")) {
    return null;
  }
  return rest.includes("@") ? rest : null;
}
