import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

type LabelEntry = Pick<
  ProviderInstanceEntry,
  "instanceId" | "driverKind" | "displayName" | "acpRegistryAgentId"
> & { readonly snapshot: { readonly auth: ProviderInstanceEntry["snapshot"]["auth"] } };

const withoutParenthetical = (name: string) => name.replace(/\s*\([^)]*\)\s*/gu, " ").trim();
const words = (name: string) => withoutParenthetical(name).split(/\s+/u).filter(Boolean);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Which product an instance is: two Copilot accounts share one, Claude and Codex do not. */
function brandOf(entry: LabelEntry): string {
  if (entry.driverKind !== "acpRegistry") return entry.driverKind;
  return entry.acpRegistryAgentId ?? words(entry.displayName)[0]?.toLowerCase() ?? entry.instanceId;
}

/**
 * The few words beside a provider's logo on a model row. The logo already says which
 * product it is, so the label only tells accounts apart: "Enterprise" and "Personal" when
 * the same product is there twice, otherwise the plan ("Claude Max") or the short name.
 * The full name, account and harness stay in the logo's tooltip.
 */
export function providerShortLabels(
  entries: ReadonlyArray<LabelEntry>,
): ReadonlyMap<ProviderInstanceId, string> {
  const byBrand = new Map<string, LabelEntry[]>();
  for (const entry of entries) {
    const brand = brandOf(entry);
    byBrand.set(brand, [...(byBrand.get(brand) ?? []), entry]);
  }
  const labels = new Map<ProviderInstanceId, string>();
  for (const group of byBrand.values()) {
    if (group.length > 1) {
      // Drop the words every account of the product shares ("Copilot"), keep what differs.
      const lists = group.map((entry) => words(entry.displayName));
      let shared = 0;
      while (
        lists.every((list) => list.length > shared + 1) &&
        lists.every((list) => list[shared]!.toLowerCase() === lists[0]![shared]!.toLowerCase())
      ) {
        shared += 1;
      }
      group.forEach((entry, index) => {
        const rest = lists[index]!.slice(shared).join(" ");
        labels.set(entry.instanceId, upperFirst(rest || withoutParenthetical(entry.displayName)));
      });
      // Names that still read alike fall back to the whole name, which the person chose.
      const seen = new Set<string>();
      for (const entry of group) {
        const label = labels.get(entry.instanceId)!;
        if (seen.has(label))
          for (const twin of group) labels.set(twin.instanceId, twin.displayName);
        seen.add(label);
      }
      continue;
    }
    const entry = group[0]!;
    const auth = entry.snapshot.auth;
    const plan = auth.status === "authenticated" ? auth.label?.trim() : undefined;
    labels.set(entry.instanceId, plan || withoutParenthetical(entry.displayName));
  }
  return labels;
}

/**
 * The account tag on a composer's model chip: the label that tells this account
 * apart from another account of the same product ("Enterprise", "Personal"), or
 * null when the product is signed in once and the logo already says it all.
 */
export function chipAccountTag(
  entries: ReadonlyArray<LabelEntry>,
  instanceId: ProviderInstanceId,
): string | null {
  const signedIn = entries.filter(
    (candidate) => candidate.snapshot.auth.status === "authenticated",
  );
  const entry = signedIn.find((candidate) => candidate.instanceId === instanceId);
  if (!entry) return null;
  const brand = brandOf(entry);
  const twins = signedIn.filter((candidate) => brandOf(candidate) === brand);
  if (twins.length < 2) return null;
  const tag = providerShortLabels(twins).get(instanceId) ?? null;
  // Names that read alike fall back to the whole name: too long for a chip.
  return tag === null || tag === entry.displayName ? null : tag;
}
