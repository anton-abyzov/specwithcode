/**
 * What a model search means beyond the letters typed: vendor names that stand
 * for a model family ("anthropic"), capability words that filter instead of
 * matching text ("cheap", "fast", "1m"), how big a model family is, which
 * providers are known to offer a family they have not listed here, and the
 * bounded edit distance behind "Closest matches".
 *
 * Pure data and string functions, so the picker, tests and other clients agree.
 *
 * @module modelSearchIntents
 */

/** A capability word's filter. The word stays out of the text match. */
export type ModelSearchCapabilityId =
  | "cheap"
  | "fast"
  | "smart"
  | "local"
  | "free"
  | "images"
  | "long"
  | "new"
  | "latest";

export interface ModelSearchCapability {
  readonly id: ModelSearchCapabilityId;
  /** What the removable chip says. */
  readonly label: string;
  /** The word the person typed, to take it back out of the query. */
  readonly word: string;
}

const CAPABILITY_WORDS: Readonly<Record<string, ModelSearchCapabilityId>> = {
  cheap: "cheap",
  fast: "fast",
  smart: "smart",
  best: "smart",
  local: "local",
  free: "free",
  images: "images",
  image: "images",
  vision: "images",
  "1m": "long",
  long: "long",
  new: "new",
  latest: "latest",
};

const CAPABILITY_LABELS: Readonly<Record<ModelSearchCapabilityId, string>> = {
  cheap: "Cheap",
  fast: "Fast",
  smart: "Smartest",
  local: "Local",
  free: "Not billed per token",
  images: "Reads images",
  long: "1M context",
  new: "New",
  latest: "Latest",
};

/** Lowercased words of a query, split on whitespace. */
function modelSearchTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

export interface ParsedModelSearch {
  /** Words matched against names and providers. */
  readonly text: ReadonlyArray<string>;
  /** Capability filters, each once, in typed order. */
  readonly capabilities: ReadonlyArray<ModelSearchCapability>;
}

/** Splits a query into text words and capability filters. */
export function parseModelSearch(query: string): ParsedModelSearch {
  const text: string[] = [];
  const capabilities: ModelSearchCapability[] = [];
  for (const token of modelSearchTokens(query)) {
    const id = CAPABILITY_WORDS[token];
    if (id === undefined) {
      text.push(token);
    } else if (!capabilities.some((capability) => capability.id === id)) {
      capabilities.push({ id, label: CAPABILITY_LABELS[id], word: token });
    }
  }
  return { text, capabilities };
}

/** The query without one capability word, for the chip's remove button. */
export function removeModelSearchWord(query: string, word: string): string {
  return query
    .split(/\s+/u)
    .filter((token) => token.toLowerCase() !== word.toLowerCase())
    .join(" ")
    .trim();
}

/** How big a model family is: what "cheap" and "smart" need, since no price is reported. */
export type ModelSizeClass = "small" | "medium" | "large";

const SMALL_WORDS = new Set(["haiku", "mini", "nano", "flash", "lite", "small", "tiny", "spark"]);
const LARGE_WORDS = new Set(["opus", "fable", "sol", "max", "ultra", "carbon", "pro", "heavy"]);

/** Lowercased name words: letters and digits runs, versions kept whole ("5.5"). */
export function modelNameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9.]+/u)
    .map((word) => word.replace(/^\.+|\.+$/gu, ""))
    .filter((word) => word.length > 0);
}

/**
 * The size class of a model from its name. A small word wins ("GPT-6 mini",
 * "Gemini Flash"); unknown families are medium, so they match neither "cheap"
 * nor "smart" by size.
 */
export function modelSizeClass(model: {
  readonly name: string;
  readonly slug?: string;
}): ModelSizeClass {
  const words = modelNameWords(`${model.name} ${model.slug ?? ""}`);
  if (words.some((word) => SMALL_WORDS.has(word))) return "small";
  if (words.some((word) => LARGE_WORDS.has(word))) return "large";
  return "medium";
}

/** Vendor names that stand for the families the vendor makes. */
const VENDOR_FAMILIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  anthropic: ["claude", "opus", "sonnet", "haiku", "fable"],
  openai: ["gpt", "codex", "sol", "o3", "o4"],
  google: ["gemini", "carbon", "gemma"],
  xai: ["grok"],
  meta: ["llama"],
  deepseek: ["deepseek"],
  mistral: ["mistral", "codestral", "devstral"],
};

/** Vendor names that stand for a provider rather than a model family. */
const VENDOR_PROVIDERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  github: ["copilot"],
  microsoft: ["copilot"],
  anthropic: ["claude"],
  openai: ["codex"],
  google: ["gemini", "antigravity"],
  xai: ["grok"],
};

/** Extra words a model answers to: the vendors that make its family. */
export function modelVendorAliases(model: { readonly name: string; readonly slug?: string }) {
  const words = new Set(modelNameWords(`${model.name} ${model.slug ?? ""}`));
  // "gpt-5.3" splits to "gpt", "o3-mini" to "o3": both are in the word set already.
  return Object.entries(VENDOR_FAMILIES).flatMap(([vendor, families]) =>
    families.some((family) => words.has(family)) ? [vendor] : [],
  );
}

/** Extra words a provider answers to ("github" for a Copilot instance). */
export function providerVendorAliases(provider: {
  readonly driverKind: string;
  readonly displayName: string;
}): string[] {
  const text = `${provider.driverKind} ${provider.displayName}`.toLowerCase();
  return Object.entries(VENDOR_PROVIDERS).flatMap(([vendor, names]) =>
    names.some((name) => text.includes(name)) ? [vendor] : [],
  );
}

/** What a capability filter reads about a model. Absent means not reported. */
export interface ModelSearchFacts {
  readonly name: string;
  readonly slug: string;
  readonly billing?: string | undefined;
  readonly contextWindow?: number | undefined;
  readonly imageInput?: boolean | undefined;
  readonly isNew?: boolean | undefined;
  /** The newest version of its family among the models listed. */
  readonly isLatest?: boolean | undefined;
  /** The model lists Fast mode or a fast service tier. */
  readonly hasFast?: boolean | undefined;
  /** In the person's Hardest work tier. */
  readonly inHardestTier?: boolean | undefined;
  /** The account behind the model is a subscription (not an API key). */
  readonly subscription?: boolean | undefined;
}

const isPerToken = (facts: ModelSearchFacts) =>
  facts.billing === "api" || facts.billing === "paid-router";

/** Whether a model passes one capability filter. */
export function modelHasCapability(id: ModelSearchCapabilityId, facts: ModelSearchFacts): boolean {
  const size = modelSizeClass(facts);
  switch (id) {
    case "cheap":
      return (
        facts.billing === "local" ||
        (size === "small" && !isPerToken(facts) && facts.subscription !== false)
      );
    case "fast":
      return facts.hasFast === true || size === "small";
    case "smart":
      return facts.inHardestTier === true || (size === "large" && facts.isLatest !== false);
    case "local":
      return facts.billing === "local";
    case "free":
      return !isPerToken(facts) && (facts.billing !== undefined || facts.subscription === true);
    case "images":
      return facts.imageInput === true;
    case "long":
      return (
        (facts.contextWindow ?? 0) >= 1_000_000 || /\b1m\b/iu.test(`${facts.name} ${facts.slug}`)
      );
    case "new":
      return facts.isNew === true;
    case "latest":
      return facts.isLatest === true;
  }
}

/** Orders "smart" results: the Hardest work tier first, then the latest frontier. */
export function smartRank(facts: ModelSearchFacts): number {
  return facts.inHardestTier ? 0 : 1;
}

/**
 * Model families a provider is known to offer when signed in, by driver kind.
 * Used only to say "sign in to list its models" for a provider that lists none
 * here; it never adds a model to the list.
 */
const KNOWN_PROVIDER_FAMILIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  cursor: ["carbon", "gemini", "opus", "sonnet", "fable", "claude", "gpt", "codex", "sol", "grok"],
  claudeAgent: ["claude", "opus", "sonnet", "haiku", "fable"],
  codex: ["gpt", "codex", "sol"],
  grok: ["grok"],
  copilot: ["carbon", "gemini", "opus", "sonnet", "fable", "claude", "gpt", "codex", "sol"],
};

/** The known-family list for a provider: its driver's, or Copilot's when it is one. */
function knownProviderFamilies(provider: {
  readonly driverKind: string;
  readonly displayName: string;
}): ReadonlyArray<string> {
  if (/copilot/iu.test(`${provider.driverKind} ${provider.displayName}`)) {
    return KNOWN_PROVIDER_FAMILIES.copilot!;
  }
  return KNOWN_PROVIDER_FAMILIES[provider.driverKind] ?? [];
}

/**
 * Whether a provider that lists nothing here is known to offer what the text
 * words ask for: every word must start one of its known family names, or name
 * the vendor of one.
 */
export function providerKnownToOffer(
  provider: { readonly driverKind: string; readonly displayName: string },
  textTokens: ReadonlyArray<string>,
): boolean {
  if (textTokens.length === 0) return false;
  const families = knownProviderFamilies(provider);
  if (families.length === 0) return false;
  return textTokens.every(
    (token) =>
      (token.length >= 3 && families.some((family) => family.startsWith(token))) ||
      (VENDOR_FAMILIES[token] ?? []).some((family) => families.includes(family)),
  );
}

/**
 * Damerau-Levenshtein distance (adjacent transpositions count once), or null
 * once it exceeds `max`. Bounded so a long catalog stays cheap to scan.
 */
export function boundedEditDistance(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null;
  let twoBack: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2]! + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return null;
    twoBack = previous;
    previous = current;
  }
  const distance = previous[b.length]!;
  return distance <= max ? distance : null;
}

/** How many edits a typo may be from a name word: one, or two for 7+ characters. */
function typoBudget(token: string): number {
  return token.length >= 7 ? 2 : 1;
}

/**
 * The distance from a typed word to the closest of a model's name words, within
 * the typo budget; null when none is close. Words under three characters and
 * versions are never guessed at.
 */
export function closestNameWordDistance(token: string, nameWords: ReadonlyArray<string>) {
  if (token.length < 3 || /^\d+(?:\.\d+)*$/u.test(token)) return null;
  const budget = typoBudget(token);
  let best: number | null = null;
  for (const word of nameWords) {
    if (word.length < 3) continue;
    // A typed prefix of a longer word is compared against the same length.
    const target = word.length > token.length + budget ? word.slice(0, token.length) : word;
    const distance = boundedEditDistance(token, target, budget);
    if (distance !== null && (best === null || distance < best)) best = distance;
  }
  return best;
}
