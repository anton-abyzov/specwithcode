/**
 * The Overview card that offers the first feature guide (1398 AC-11, AC-20):
 * a title, one sentence, one action and a dismiss. Pure; `FirstFeatureOffer`
 * decides what it offers.
 */
import { ArrowRightIcon, XIcon } from "lucide-react";

import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import {
  OFFER_CONTINUE,
  OFFER_CONTINUE_TEXT,
  OFFER_CONTINUE_TITLE,
  OFFER_DISMISS,
  OFFER_SIGN_IN,
  OFFER_START,
  OFFER_TEXT,
  OFFER_TITLE,
  type FirstFeatureOffer,
} from "./firstFeature.logic";

/** The card itself; what it offers is the caller's. */
export function FirstFeatureOfferCard({
  offer,
  starting = false,
  onStart,
  onDismiss,
}: {
  readonly offer: FirstFeatureOffer<{ readonly title?: string }>;
  readonly starting?: boolean;
  readonly onStart: () => void;
  readonly onDismiss: () => void;
}) {
  const tx = useTx();
  if (offer.kind === "hidden") return null;
  const title = offer.kind === "continue" ? tx(OFFER_CONTINUE_TITLE) : tx(OFFER_TITLE);
  const text = offer.kind === "continue" ? tx(OFFER_CONTINUE_TEXT) : tx(OFFER_TEXT);
  const action =
    offer.kind === "continue"
      ? tx(OFFER_CONTINUE)
      : offer.kind === "sign-in"
        ? tx(OFFER_SIGN_IN)
        : tx(OFFER_START);
  return (
    <section
      aria-labelledby="first-feature-offer-title"
      data-first-feature-offer={offer.kind}
      className="mb-4 flex min-w-0 items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground max-sm:flex-wrap"
    >
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h2 id="first-feature-offer-title" className="text-sm font-medium">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{text}</p>
      </div>
      <Button
        className="shrink-0"
        size="xs"
        variant="outline"
        disabled={starting}
        onClick={onStart}
        data-first-feature-offer-action=""
      >
        {action}
        <ArrowRightIcon aria-hidden className="size-3" />
      </Button>
      <Button
        className="shrink-0"
        size="icon-xs"
        variant="ghost-muted"
        aria-label={tx(OFFER_DISMISS)}
        onClick={onDismiss}
      >
        <XIcon className="size-3.5" />
      </Button>
    </section>
  );
}
