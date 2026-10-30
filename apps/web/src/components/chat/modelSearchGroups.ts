import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";

const OLDER_VERSIONS_KEY_PREFIX = "older-models:";

/** Vendor words providers put before a model name ("Anthropic: Claude Opus 5.5"). */
const VENDOR_WORDS = new Set(["anthropic", "claude", "openai", "google", "xai", "x-ai", "meta"]);
const VERSION = /^\d+(?:\.\d+)*$/u;

/**
 * Which model a provider's option is, apart from the provider: "Claude Opus 5.5",
 * "Opus 5.5" and "anthropic/claude-opus-5.5" are one model. `family` holds its name
 * without the version ("opus"), so versions of one family can be told apart and ranked.
 */
export interface ModelSearchIdentity {
  readonly key: string;
  readonly family: string;
  readonly version: ReadonlyArray<number>;
}

export function modelSearchIdentity(model: {
  readonly name: string;
  readonly slug: string;
}): ModelSearchIdentity {
  const tokens = model.name
    .toLowerCase()
    .split(/[^a-z0-9.]+/u)
    .map((token) => token.replace(/^\.+|\.+$/gu, ""))
    .filter((token) => token.length > 0);
  const words = tokens.filter((token) => !VERSION.test(token));
  const named = words.filter((word) => !VENDOR_WORDS.has(word));
  // "Claude" alone stays a name; only a vendor in front of another name is dropped.
  const family = (named.length > 0 ? named : words).join(" ") || model.slug.toLowerCase();
  const versionToken = tokens.find((token) => VERSION.test(token));
  const version = versionToken ? versionToken.split(".").map(Number) : [];
  return { key: `${family}|${version.join(".")}`, family, version };
}

function compareVersionsDescending(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (b[index] ?? 0) - (a[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Where a provider sits among those offering one model: the local apps and subscriptions
 * first (Claude, Codex), then GitHub Copilot (enterprise, then personal), then
 * Cursor, then everything else. Lower comes first.
 */
export function modelSearchProviderTier(entry: ProviderInstanceEntry): number {
  const auth = entry.snapshot.auth;
  const names = [entry.instanceId, entry.displayName, entry.acpRegistryAgentId ?? ""].join(" ");
  if (/copilot/iu.test(names)) {
    return /enterprise|business/iu.test(`${names} ${auth.label ?? ""}`) ? 1 : 2;
  }
  if (entry.driverKind === "cursor" || /cursor/iu.test(names)) return 3;
  // The local Claude and Codex apps lead however they bill, then other subscriptions.
  if (entry.driverKind === "claudeAgent" || entry.driverKind === "codex") return 0;
  return auth.type === "subscription" ? 0 : 4;
}

/** One model as offered by every provider that matched, best provider first. */
export interface ModelSearchGroup<T> {
  readonly key: string;
  readonly identity: ModelSearchIdentity;
  readonly items: ReadonlyArray<T>;
}

/** One model family: its newest matching version, and the older ones behind a toggle. */
export interface ModelSearchFamily<T> {
  readonly family: string;
  readonly latest: ModelSearchGroup<T>;
  readonly older: ReadonlyArray<ModelSearchGroup<T>>;
}

type Groupable = {
  readonly slug: string;
  readonly name: string;
  readonly instanceId: ProviderInstanceId;
};

/**
 * Folds ranked search results so each model appears once. Families keep the rank of their
 * best match; within one, the newest version leads; within one model, providers follow
 * `providerRank` (tier, then the configured order).
 */
export function groupModelSearchResults<T extends Groupable>(
  ranked: ReadonlyArray<T>,
  providerRank: (instanceId: ProviderInstanceId) => number,
): ReadonlyArray<ModelSearchFamily<T>> {
  const families = new Map<string, Map<string, { identity: ModelSearchIdentity; items: T[] }>>();
  for (const item of ranked) {
    const identity = modelSearchIdentity(item);
    let family = families.get(identity.family);
    if (!family) {
      family = new Map();
      families.set(identity.family, family);
    }
    const group = family.get(identity.key);
    if (group) group.items.push(item);
    else family.set(identity.key, { identity, items: [item] });
  }
  return [...families].map(([family, groups]) => {
    const versions = [...groups.values()]
      .toSorted((a, b) => compareVersionsDescending(a.identity.version, b.identity.version))
      .map((group): ModelSearchGroup<T> => ({
        key: group.identity.key,
        identity: group.identity,
        items: group.items.toSorted(
          (a, b) => providerRank(a.instanceId) - providerRank(b.instanceId),
        ),
      }));
    return { family, latest: versions[0]!, older: versions.slice(1) };
  });
}

/** The display name of a grouped model: the best provider's, without a vendor prefix. */
export function modelSearchGroupLabel(group: ModelSearchGroup<{ readonly name: string }>): string {
  const name = group.items[0]?.name ?? group.identity.family;
  return name.replace(/^[A-Za-z-]+:\s*/u, "");
}

export function modelPickerOlderVersionsKey(family: string): string {
  return `${OLDER_VERSIONS_KEY_PREFIX}${family}`;
}

export function parseModelPickerOlderVersionsKey(key: string): string | null {
  return key.startsWith(OLDER_VERSIONS_KEY_PREFIX)
    ? key.slice(OLDER_VERSIONS_KEY_PREFIX.length)
    : null;
}

/** What the list shows over a grouped model's first provider row. */
export interface ModelSearchHeader {
  readonly label: string;
  /** The model's family without its version ("opus"), the key a family star saves. */
  readonly family: string;
  readonly providerCount: number;
  readonly older: boolean;
  /** The newest of a family that has older versions: the one most people want. */
  readonly latest: boolean;
}

/**
 * A family's heading when it has older versions: it names the latest model and is itself
 * the toggle that opens the older ones beneath it.
 */
export interface ModelSearchOlderSection {
  readonly family: string;
  readonly latest: ModelSearchHeader;
  /** The family's name without a version ("Claude Opus"), or null when none is left. */
  readonly familyLabel: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly isExpanded: boolean;
}

/**
 * The search list in display order: each family's newest model with its providers, then
 * its older versions when expanded. Plain headers ride on a group's first row and are never
 * rows themselves; a family with older versions gets a heading row that toggles them, so
 * the switch to a legacy version sits right on the latest model.
 */
export function layoutModelSearch<T extends Groupable>(
  families: ReadonlyArray<ModelSearchFamily<T>>,
  keyOf: (item: T) => string,
  expandedFamilies: ReadonlySet<string>,
): {
  readonly visibleModels: T[];
  readonly keys: string[];
  readonly headers: ReadonlyMap<string, ModelSearchHeader>;
  readonly older: ReadonlyMap<string, ModelSearchOlderSection>;
} {
  const visibleModels: T[] = [];
  const keys: string[] = [];
  const headers = new Map<string, ModelSearchHeader>();
  const older = new Map<string, ModelSearchOlderSection>();
  const headerOf = (group: ModelSearchGroup<T>, isOlder: boolean, latest: boolean) => ({
    label: modelSearchGroupLabel(group),
    family: group.identity.family,
    providerCount: new Set(group.items.map((item) => item.instanceId)).size,
    older: isOlder,
    latest,
  });
  const push = (group: ModelSearchGroup<T>, header: ModelSearchHeader | null) => {
    if (header) headers.set(keyOf(group.items[0]!), header);
    visibleModels.push(...group.items);
    keys.push(...group.items.map(keyOf));
  };
  for (const family of families) {
    if (family.older.length === 0) {
      push(family.latest, headerOf(family.latest, false, false));
      continue;
    }
    const key = modelPickerOlderVersionsKey(family.family);
    const isExpanded = expandedFamilies.has(family.family);
    const latestLabel = modelSearchGroupLabel(family.latest);
    const familyLabel = latestLabel.replace(/[\s-]*v?\d+(?:\.\d+)*\s*$/u, "");
    older.set(key, {
      family: family.family,
      latest: headerOf(family.latest, false, true),
      familyLabel: familyLabel !== latestLabel && familyLabel.length > 0 ? familyLabel : null,
      labels: family.older.map(modelSearchGroupLabel),
      isExpanded,
    });
    keys.push(key);
    push(family.latest, null);
    if (isExpanded) for (const group of family.older) push(group, headerOf(group, true, false));
  }
  return { visibleModels, keys, headers, older };
}

/** Search results laid out by model, providers ranked by tier then their configured order. */
export function layoutModelSearchResults<T extends Groupable>(
  ranked: ReadonlyArray<T>,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  keyOf: (item: T) => string,
  expandedFamilies: ReadonlySet<string>,
): ReturnType<typeof layoutModelSearch<T>> {
  const rank = new Map(
    entries.map(
      (entry, index) => [entry.instanceId, modelSearchProviderTier(entry) * 1000 + index] as const,
    ),
  );
  const families = groupModelSearchResults(
    ranked,
    (instanceId) => rank.get(instanceId) ?? Number.MAX_SAFE_INTEGER,
  );
  return layoutModelSearch(families, keyOf, expandedFamilies);
}

/** The plan a provider row names in search results ("Claude Max", "Copilot Enterprise"). */
export function modelSearchProviderPlan(entry: ProviderInstanceEntry | undefined): string | null {
  const auth = entry?.snapshot.auth;
  const plan = auth?.status === "authenticated" ? (auth.label ?? null) : null;
  // "Copilot Enterprise · Copilot Enterprise" says nothing twice.
  return plan && plan.toLowerCase() !== entry?.displayName.toLowerCase() ? plan : null;
}
