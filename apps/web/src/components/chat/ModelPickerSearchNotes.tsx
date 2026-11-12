/**
 * What the picker says around a search besides the matches: the choice being made,
 * the capability filters as removable chips, the "Closest matches" label, the empty
 * state, and a provider that would list the model once signed in.
 */
import type { ProviderInstanceId } from "@specweave-studio/contracts";
import {
  parseModelSearch,
  providerKnownToOffer,
  type ModelSearchCapability,
} from "@specweave-studio/shared/modelSearchIntents";
import { ChevronLeftIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  isProviderInstancePickerSelectable,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { modelSearchHighlightRanges } from "./modelPickerSearch";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** Names the choice the picker makes: "Choosing Model for new threads · carbon-test". */
export function ModelPickerTitle(props: {
  readonly title: string;
  /** What it applies to, such as the project's name. */
  readonly context?: string | undefined;
  /** Returns to the view the picker was opened from. */
  readonly onBack?: (() => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5">
      {props.onBack ? (
        <button
          type="button"
          className="-ms-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Back to Models"
          onClick={props.onBack}
          data-model-picker-back=""
        >
          <ChevronLeftIcon className="size-4" aria-hidden />
        </button>
      ) : null}
      <p
        className="min-w-0 truncate text-xs leading-snug text-muted-foreground"
        data-model-picker-title=""
      >
        Choosing <span className="font-semibold text-foreground">{props.title}</span>
        {props.context ? <span> · {props.context}</span> : null}
      </p>
    </div>
  );
}

/** `label` with the characters the query matched marked. */
export function HighlightedModelName(props: { readonly label: string; readonly query: string }) {
  const ranges = props.query ? modelSearchHighlightRanges(props.label, props.query) : [];
  if (ranges.length === 0) return <>{props.label}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(props.label.slice(at, start));
    parts.push(
      <mark key={start} className="sws-picker-mark" data-model-search-mark="">
        {props.label.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < props.label.length) parts.push(props.label.slice(at));
  return <>{parts}</>;
}

/** The capability words of the query as chips; removing one takes its word out. */
export function ModelSearchCapabilityChips(props: {
  readonly capabilities: ReadonlyArray<ModelSearchCapability>;
  readonly onRemove: (word: string) => void;
}) {
  if (props.capabilities.length === 0) return null;
  return (
    <ul
      className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-1.5"
      aria-label="Search filters"
      data-model-search-capabilities=""
    >
      {props.capabilities.map((capability) => (
        <li key={capability.id}>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-primary/35 bg-primary/10 ps-2 pe-1.5 text-xs text-foreground hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Remove filter: ${capability.label}`}
            onClick={() => props.onRemove(capability.word)}
            data-model-search-capability={capability.id}
          >
            {capability.label}
            <XIcon className="size-3 text-muted-foreground" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A provider that lists nothing here but is known to offer what was searched for. */
export interface ModelSearchSignInOffer {
  readonly entry: ProviderInstanceEntry;
  /** Why it lists nothing: signed out, or turned off. */
  readonly reason: "signedOut" | "off";
}

/**
 * The enabled-but-signed-out and turned-off providers known to offer the model family
 * the query names. They never add rows: they are offered as a sign-in.
 */
export function modelSearchSignInOffers(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  query: string,
): ReadonlyArray<ModelSearchSignInOffer> {
  const text = parseModelSearch(query).text;
  if (text.length === 0) return [];
  return entries.flatMap((entry): ModelSearchSignInOffer[] => {
    const signedOut = entry.snapshot.auth?.status === "unauthenticated";
    const off = !entry.enabled || entry.status === "disabled";
    if (!signedOut && !off) return [];
    if (!off && isProviderInstancePickerSelectable(entry) && entry.models.length > 0) return [];
    return providerKnownToOffer(entry, text) ? [{ entry, reason: off ? "off" : "signedOut" }] : [];
  });
}

export function modelSearchSignInSentence(
  offer: ModelSearchSignInOffer,
  input: { readonly model: string | null; readonly machine: string | null },
): string {
  const name = offer.entry.displayName;
  const where = input.machine ? ` on ${input.machine}` : " here";
  const state = offer.reason === "off" ? `It's turned off${where}.` : `It's signed out${where}.`;
  return input.model
    ? `${name} also offers ${input.model}. ${state}`
    : `${name}: ${offer.reason === "off" ? "turn it on" : "sign in"} to list its models.`;
}

/** Under the results or in the empty state: "Cursor also offers Gemini 4 Carbon. It's signed out on M4." */
export function ModelSearchSignInOffers(props: {
  readonly offers: ReadonlyArray<ModelSearchSignInOffer>;
  /** The best direct match's name, when there is one. */
  readonly model: string | null;
  readonly machine: string | null;
  readonly onSignIn?: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  if (props.offers.length === 0) return null;
  return (
    <ul className="flex shrink-0 flex-col gap-1 px-2 pb-2" data-model-search-sign-in="">
      {props.offers.map((offer) => (
        <li
          key={offer.entry.instanceId}
          className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-2 text-xs leading-snug text-muted-foreground"
        >
          <ProviderInstanceIcon
            driverKind={offer.entry.driverKind}
            displayName={offer.entry.displayName}
            accentColor={offer.entry.accentColor}
            acpRegistryAgentId={offer.entry.acpRegistryAgentId}
            acpRegistryIconUrl={offer.entry.acpRegistryIconUrl}
            showBadge={false}
            className="size-4 shrink-0"
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1">
            {modelSearchSignInSentence(offer, { model: props.model, machine: props.machine })}
          </span>
          {props.onSignIn ? (
            <button
              type="button"
              className="shrink-0 rounded px-1 font-semibold text-foreground underline decoration-primary/60 underline-offset-2 hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => props.onSignIn?.(offer.entry.instanceId)}
              data-model-search-sign-in-action={offer.entry.instanceId}
            >
              {offer.reason === "off" ? "Turn on" : "Sign in"}
              <span className="sr-only"> to {offer.entry.displayName}</span>
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Over near-misses, so a typo's guesses are never taken for matches. */
export function ModelSearchClosestLabel() {
  return (
    <p
      className="shrink-0 px-3 pt-1.5 text-2xs font-semibold tracking-wide text-muted-foreground uppercase"
      role="status"
      data-model-search-closest=""
    >
      Closest matches
    </p>
  );
}

/** Nothing matched, not even closely. */
export function ModelSearchEmpty(props: { readonly query: string }) {
  return (
    <p
      className="shrink-0 px-3 py-4 text-sm leading-snug text-muted-foreground"
      role="status"
      data-model-search-empty=""
    >
      No model matches “{props.query.trim()}”, and none is close.
    </p>
  );
}
