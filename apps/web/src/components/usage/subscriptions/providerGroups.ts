/**
 * The provider a subscription is counted under in the usage summaries.
 *
 * A built-in driver is its own provider. ACP Registry is a transport, not a
 * provider: GitHub Copilot, Gemini CLI and the other registry agents each get
 * their own group, named and drawn as the agent, so a summary never shows one
 * "ACP Registry" row for several agents. The registry identity comes from the
 * instance's registry icon URL (assigned by the registry); the instance's name
 * is only the fallback, as it is for the icons elsewhere.
 */
import type { ServerProvider } from "@specweave-studio/contracts";

import { type ProviderBrand, providerBrandFor, providerBrandForName } from "../../ProviderLogo";
import { getDriverOption } from "../../settings/providerDriverMeta";

export interface ProviderGroup {
  /** The driver for a built-in provider; `acpRegistry:<brand>` for a registry agent. */
  readonly key: string;
  readonly label: string;
  readonly driver: ServerProvider["driver"];
  /** A registry icon URL that names the agent, for its mark. */
  readonly iconUrl: string | null;
}

export interface ProviderGroupSource {
  readonly driver: ServerProvider["driver"];
  readonly displayName?: string | null | undefined;
  readonly iconUrl?: string | null | undefined;
}

/** What each registry agent is called, whatever an instance of it was named. */
const AGENT_NAMES: Partial<Record<ProviderBrand, string>> = {
  copilot: "GitHub Copilot",
  gemini: "Gemini CLI",
  claude: "Claude Agent",
  openai: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  opencode: "OpenCode",
  qwen: "Qwen Code",
  kimi: "Kimi",
  mistral: "Mistral Vibe",
  kiro: "Kiro",
  goose: "Goose",
  cline: "Cline",
  auggie: "Auggie",
  factory: "Factory Droid",
  amp: "Amp",
  junie: "Junie",
  deepseek: "DeepSeek",
};

export const REGISTRY_DRIVER = "acpRegistry";

export function providerGroupOf(source: ProviderGroupSource): ProviderGroup {
  const driver = source.driver;
  const name = source.displayName?.trim() || null;
  const iconUrl = source.iconUrl?.trim() || null;
  if (driver !== REGISTRY_DRIVER) {
    return {
      key: String(driver),
      label: getDriverOption(driver)?.label ?? String(driver),
      driver,
      iconUrl: null,
    };
  }
  const brand =
    providerBrandFor({ driverKind: REGISTRY_DRIVER, acpRegistryIconUrl: iconUrl }) ??
    providerBrandForName(name ?? undefined);
  if (brand !== null) {
    return {
      key: `${REGISTRY_DRIVER}:${brand}`,
      label: AGENT_NAMES[brand] ?? name ?? brand,
      driver,
      iconUrl,
    };
  }
  // An agent the app has no mark for keeps its own name, one group per name.
  if (name !== null) {
    return { key: `${REGISTRY_DRIVER}:name:${name.toLowerCase()}`, label: name, driver, iconUrl };
  }
  return { key: REGISTRY_DRIVER, label: "Other registry agents", driver, iconUrl };
}

/**
 * The group of every account key the rows name, for ledger periods, which
 * carry an account key and a driver but no instance.
 */
export function groupResolver(
  rows: ReadonlyArray<ProviderGroupSource & { readonly accountKey: string | null }>,
): (accountKey: string, driver: ServerProvider["driver"]) => ProviderGroup {
  const byKey = new Map<string, ProviderGroup>();
  for (const row of rows) {
    if (row.accountKey === null) continue;
    const group = providerGroupOf(row);
    // A named agent beats the catch-all when two machines describe one account.
    if (!byKey.has(row.accountKey) || byKey.get(row.accountKey)?.key === REGISTRY_DRIVER) {
      byKey.set(row.accountKey, group);
    }
  }
  return (accountKey, driver) => byKey.get(accountKey) ?? providerGroupOf({ driver });
}
