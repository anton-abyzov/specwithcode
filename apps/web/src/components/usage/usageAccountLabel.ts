import { describeLimitAccount, type LimitAccount } from "@specweave-studio/shared/usageLimits";

import { getDriverOption } from "../settings/providerDriverMeta";

/** The instance's name, else the provider's: what the account was called before identity was shown. */
export function instanceLabel(account: LimitAccount): string {
  return account.displayName ?? getDriverOption(account.driver)?.label ?? String(account.driver);
}

/**
 * The text a segment carries: the account the provider reported (email, plan
 * or hub account name) on its first line and the machine on its second.
 * Nothing reported means the instance name and no second line.
 */
export function limitAccountLabel(account: LimitAccount): {
  readonly primary: string;
  readonly machine: string | null;
  readonly summary: string;
} {
  const identity = describeLimitAccount(account);
  const primary = identity.account ?? instanceLabel(account);
  // A kept read from an unreachable machine must not pass for a live one.
  const machine =
    identity.machine && account.offline ? `${identity.machine} · offline` : identity.machine;
  return {
    primary,
    machine,
    summary: machine
      ? `${primary} ${identity.machineKind === "source" ? "via" : "on"} ${machine}`
      : primary,
  };
}
