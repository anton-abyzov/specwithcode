import {
  EMPTY_MODEL_ROUTE,
  type EnvironmentId,
  type ModelRoute,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { modelOffers, type SourceCost, sourceCost } from "@specweave-studio/shared/modelOffers";
import {
  addRouteSource,
  dropRouteSource,
  moveRouteSource,
  restoreRouteSource,
  togglePinRouteSource,
} from "@specweave-studio/shared/modelRoutes";
import { sourceStatus, type TrackRow } from "@specweave-studio/shared/modelTrackRules";
import { PinIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { SortableList, SortableRow, statusChip } from "./ModelListParts";
import { FixButton, sourceFix, useSourceFixer } from "./ModelSourcesCard";

type Tx = ReturnType<typeof useTx>;

/** What running the model on a source costs, in a few words: "Claude Max", "Credits", "Per token". */
export function costLabel(cost: SourceCost, tx: Tx): string {
  switch (cost.kind) {
    case "plan":
      return cost.plan ?? tx("Subscription");
    case "credits":
      return tx("Credits");
    case "per-token":
      return tx("Per token");
    case "unknown":
      return tx("Billing unknown");
  }
}

/**
 * One model's route, opened from its track row: the sources that run it
 * first to last, each with what it costs and its limit, ready to reorder,
 * drop or pin; the sources it never runs on; and every other source known to
 * offer it ("Available via") with the step that sets it up.
 */
export function ModelRoutePanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly row: TrackRow;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly sourceName: (provider: ServerProvider) => string;
  readonly onSave: (route: ModelRoute) => void;
}) {
  const tx = useTx();
  const { row } = props;
  const route = row.route;
  const runs = row.sources.filter((source) => source.used);
  const held = row.sources.filter((source) => !source.used);
  const shown = runs.map((source) => source.provider.instanceId);
  const pinned = route?.pinned === true ? (route.order[0] ?? null) : null;
  const providerOf = (id: ProviderInstanceId) =>
    props.providers.find((provider) => provider.instanceId === id);
  const dropped = (route?.dropped ?? []).flatMap((id) => {
    const provider = providerOf(id);
    return provider === undefined ? [] : [provider];
  });
  const listed = new Set<string>([
    ...row.sources.map((source) => source.provider.instanceId),
    ...(route?.dropped ?? []),
  ]);
  const offers = modelOffers(props.providers, { slug: row.model, name: row.name }).filter(
    (offer) => offer.kind === "absent" || !listed.has(offer.provider.instanceId),
  );
  const nameOf = (provider: ServerProvider) => props.sourceName(provider);

  return (
    <div
      aria-label={`${tx("Route for")} ${row.name}`}
      className="flex flex-col gap-2.5 border-t border-border/70 bg-muted/30 py-2.5 pr-3 pl-14"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-xs font-semibold">{`${tx("Route for")} ${row.name}`}</h4>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {tx("First to last. Saved for this model on every track.")}
        </p>
        {route !== null ? (
          <InlineButton tone="link" type="button" onClick={() => props.onSave(EMPTY_MODEL_ROUTE)}>
            {tx("Use the automatic order")}
          </InlineButton>
        ) : null}
      </div>
      {runs.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <SortableList
            label={`${tx("Route for")} ${row.name}`}
            ids={shown}
            onMove={(from, to) => props.onSave(moveRouteSource(route, shown, from, to))}
          >
            {runs.map((source, index) => {
              const name = nameOf(source.provider);
              const chip = statusChip(source.status, tx);
              const isPinned = pinned === source.provider.instanceId;
              return (
                <SortableRow
                  key={source.provider.instanceId}
                  id={source.provider.instanceId}
                  position={index + 1}
                  label={name}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {costLabel(sourceCost(source.provider, source.slug), tx)}
                  </span>
                  {source.ask ? (
                    <Badge variant="warning" size="sm">
                      {tx("Asks before first run")}
                    </Badge>
                  ) : (
                    <Badge variant={chip.variant} size="sm">
                      {chip.label}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    size="xs"
                    variant={isPinned ? "default" : "outline"}
                    aria-pressed={isPinned}
                    aria-label={`${tx("Pin")} ${name}`}
                    onClick={() =>
                      props.onSave(togglePinRouteSource(route, shown, source.provider.instanceId))
                    }
                  >
                    <PinIcon className="size-3" />
                    {tx("Pin")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    aria-label={`${tx("Never run it on")} ${name}`}
                    onClick={() => props.onSave(dropRouteSource(route, source.provider.instanceId))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </SortableRow>
              );
            })}
          </SortableList>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{tx("No source here runs this model now.")}</p>
      )}
      {pinned !== null ? (
        <p className="text-xs text-muted-foreground">
          {tx("Pinned: only this source runs the model. When it cannot, the next model is tried.")}
        </p>
      ) : null}
      {dropped.length > 0 ? (
        <ul
          aria-label={tx("Never runs this model")}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
        >
          <li>{tx("Never runs this model:")}</li>
          {dropped.map((provider) => (
            <li key={provider.instanceId} className="flex items-center gap-1.5">
              <span className="text-foreground line-through">{nameOf(provider)}</span>
              <InlineButton
                tone="link"
                type="button"
                aria-label={`${tx("Restore")} ${nameOf(provider)}`}
                onClick={() => props.onSave(restoreRouteSource(route, provider.instanceId))}
              >
                {tx("Restore")}
              </InlineButton>
            </li>
          ))}
        </ul>
      ) : null}
      {held.length > 0 ? (
        <ul aria-label={tx("Paid sources")} className="flex flex-col gap-1 text-xs">
          {held.map((source) => {
            const name = nameOf(source.provider);
            return (
              <li key={source.provider.instanceId} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{name}</span>
                <span className="text-muted-foreground">
                  {`${costLabel(sourceCost(source.provider, source.slug), tx)}. ${tx("Asks before its first run once added.")}`}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label={`${tx("Add")} ${name}`}
                  onClick={() =>
                    props.onSave(addRouteSource(route, shown, source.provider.instanceId))
                  }
                >
                  {tx("Add")}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {offers.length > 0 ? (
        <AvailableVia
          environmentId={props.environmentId}
          offers={offers}
          nowMs={props.nowMs}
          nameOf={nameOf}
        />
      ) : null}
    </div>
  );
}

function AvailableVia(props: {
  readonly environmentId: EnvironmentId | null;
  readonly offers: ReturnType<typeof modelOffers<ServerProvider>>;
  readonly nowMs: number;
  readonly nameOf: (provider: ServerProvider) => string;
}) {
  const tx = useTx();
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{tx("Available via")}</p>
      <ul
        aria-label={tx("Available via")}
        className="overflow-hidden rounded-lg border border-border bg-card"
      >
        {props.offers.map((offer) =>
          offer.kind === "absent" ? (
            <OfferRow
              key={offer.source}
              id={offer.source}
              name={offer.name}
              note={tx("Not set up on this machine")}
            >
              {props.environmentId !== null ? (
                <OpenProvidersButton environmentId={props.environmentId} name={offer.name} />
              ) : null}
            </OfferRow>
          ) : (
            <ProviderOffer
              key={offer.provider.instanceId}
              environmentId={props.environmentId}
              provider={offer.provider}
              slug={offer.slug}
              listed={offer.listed}
              name={props.nameOf(offer.provider)}
              nowMs={props.nowMs}
            />
          ),
        )}
      </ul>
    </div>
  );
}

function OfferRow(props: {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly children?: ReactNode;
}) {
  return (
    <li
      data-route-offer={props.id}
      className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-xs last:border-b-0"
    >
      <span className="min-w-0 flex-1 truncate text-sm">{props.name}</span>
      <span className="shrink-0 text-muted-foreground">{props.note}</span>
      {props.children}
    </li>
  );
}

function ProviderOffer(props: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: ServerProvider;
  readonly slug: string | null;
  readonly listed: boolean;
  readonly name: string;
  readonly nowMs: number;
}) {
  const tx = useTx();
  const status = sourceStatus(props.provider, props.nowMs, props.slug ?? undefined);
  const chip = statusChip(status, tx);
  return (
    <OfferRow
      id={props.provider.instanceId}
      name={props.name}
      note={
        props.listed
          ? costLabel(sourceCost(props.provider, props.slug), tx)
          : tx("Usually offers it")
      }
    >
      <Badge variant={chip.variant} size="sm" className={cn(status.state === "ready" && "hidden")}>
        {chip.label}
      </Badge>
      {props.environmentId !== null ? (
        <ProviderOfferFix
          environmentId={props.environmentId}
          provider={props.provider}
          name={props.name}
        />
      ) : null}
    </OfferRow>
  );
}

function ProviderOfferFix(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly name: string;
}) {
  const tx = useTx();
  const fixer = useSourceFixer(props.environmentId);
  const fix = sourceFix(props.provider, tx);
  return fix === null ? null : (
    <FixButton provider={props.provider} fix={fix} fixer={fixer} name={props.name} />
  );
}

function OpenProvidersButton(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  const tx = useTx();
  const fixer = useSourceFixer(props.environmentId);
  const label = tx("Open Providers");
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-label={`${label}: ${props.name}`}
      onClick={() => fixer.openProviders()}
    >
      {label}
    </Button>
  );
}
