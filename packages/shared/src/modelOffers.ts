/**
 * Which sources offer a model ("Available via"), and what running it there
 * costs. An installed provider's own catalog always answers for it. Only a
 * provider with no catalog here (not installed, off, never checked) or not
 * set up at all falls back to `KNOWN_MODEL_OFFERS`, a small table of offers
 * seen in real catalogs. It is approximate and says so.
 *
 * @module modelOffers
 */
import {
  isPaidModelBilling,
  providerModelBilling,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";

import { isSameModel, sameModelOn } from "./modelIdentity.ts";
import {
  isGeminiSpendProvider,
  isPerTokenProvider,
  isUnknownBillingAgent,
} from "./providerFallback.ts";

type ModelNames = Pick<ServerProviderModel, "slug"> &
  Partial<Pick<ServerProviderModel, "name" | "aliases">>;
type OfferProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "models" | "enabled" | "installed"
> &
  Partial<Pick<ServerProvider, "displayName" | "iconUrl">>;

export interface KnownOffer {
  /** The source's id in the registry or its driver: `devin`, `github-copilot-cli`, `cursor`. */
  readonly source: string;
  readonly name: string;
  /** Whether a provider here is this source. */
  readonly matches: (provider: OfferProvider) => boolean;
  /** Models this source was seen offering, by slug. */
  readonly models: ReadonlyArray<string>;
}

const named = (pattern: RegExp) => (provider: OfferProvider) =>
  pattern.test(provider.instanceId) ||
  pattern.test(provider.displayName ?? "") ||
  pattern.test(provider.iconUrl ?? "");

/**
 * Offers seen in live catalogs on November 18, 2026. Fable 5.2 runs on
 * Claude Code, Cursor and Devin; GitHub Copilot lists only Fable 5.
 */
export const KNOWN_MODEL_OFFERS: ReadonlyArray<KnownOffer> = [
  {
    source: "claudeAgent",
    name: "Claude Code",
    matches: (provider) => provider.driver === "claudeAgent",
    models: ["claude-fable-5-2", "claude-fable-5", "claude-opus-5-5", "claude-sonnet-5-5"],
  },
  {
    source: "cursor",
    name: "Cursor",
    matches: (provider) => provider.driver === "cursor",
    models: [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "gpt-5.6-sol",
      "gemini-4-carbon",
      "muse-wonder-1.0",
    ],
  },
  {
    source: "devin",
    name: "Devin",
    matches: named(/devin/i),
    models: ["claude-fable-5-2"],
  },
  {
    source: "github-copilot-cli",
    name: "GitHub Copilot",
    matches: named(/copilot/i),
    models: [
      "claude-fable-5",
      "claude-opus-5.5",
      "claude-sonnet-5.5",
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gemini-4-carbon",
    ],
  },
];

/** Whether the table says `offer` serves `model` (the same model, never another release). */
export const offersModel = (offer: KnownOffer, model: ModelNames) =>
  offer.models.some((slug) => isSameModel({ slug }, model));

export type ModelOffer<P extends OfferProvider = OfferProvider> =
  /** A provider here: `listed` when its own catalog lists the model, else the table says so. */
  | {
      readonly kind: "provider";
      readonly provider: P;
      readonly slug: string | null;
      readonly listed: boolean;
    }
  /** A source no provider here is: set it up in Providers. */
  | { readonly kind: "absent"; readonly source: string; readonly name: string };

/**
 * Every source that offers `model`, providers here first in their listed
 * order, then sources not set up here. A provider with a catalog that does
 * not list the model is left out, whatever the table says.
 */
export function modelOffers<P extends OfferProvider>(
  providers: ReadonlyArray<P>,
  model: ModelNames,
): ReadonlyArray<ModelOffer<P>> {
  const offers: ModelOffer<P>[] = [];
  for (const provider of providers) {
    const slug = sameModelOn(provider, model);
    if (slug !== undefined) {
      offers.push({ kind: "provider", provider, slug, listed: true });
      continue;
    }
    if (provider.models.length > 0) continue;
    const offer = KNOWN_MODEL_OFFERS.find((entry) => entry.matches(provider));
    if (offer !== undefined && offersModel(offer, model))
      offers.push({ kind: "provider", provider, slug: null, listed: false });
  }
  for (const offer of KNOWN_MODEL_OFFERS) {
    if (!offersModel(offer, model)) continue;
    if (providers.some((provider) => offer.matches(provider))) continue;
    offers.push({ kind: "absent", source: offer.source, name: offer.name });
  }
  return offers;
}

/** How a source bills a model: its plan, credits, per token, or nobody knows. */
export type SourceCost =
  | { readonly kind: "plan"; readonly plan: string | null }
  | { readonly kind: "credits" }
  | { readonly kind: "per-token" }
  | { readonly kind: "unknown" };

const CREDIT_DRIVERS = new Set(["cursor"]);

export function sourceCost(provider: ServerProvider, slug: string | null): SourceCost {
  const billing = slug === null ? undefined : providerModelBilling(provider, slug);
  if (isPaidModelBilling(billing)) return { kind: "per-token" };
  // A provider described without its sign-in (a bare list of models) says nothing about billing.
  const auth = (provider as Partial<ServerProvider>).auth;
  if (auth !== undefined && (isPerTokenProvider(provider) || isGeminiSpendProvider(provider)))
    return { kind: "per-token" };
  if (billing === "unknown") return { kind: "unknown" };
  if (CREDIT_DRIVERS.has(provider.driver)) return { kind: "credits" };
  if (auth !== undefined && isUnknownBillingAgent(provider, slug ?? undefined))
    return { kind: "unknown" };
  return { kind: "plan", plan: auth?.label?.trim() || null };
}
