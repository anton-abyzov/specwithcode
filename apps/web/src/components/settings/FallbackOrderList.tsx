import type { ModelSelection, ServerProvider } from "@specweave-studio/contracts";
import type { ReviewerStepStatus } from "@specweave-studio/shared/adversarialReview";
import { MODEL_FAMILY_LABELS, type ModelFamily } from "@specweave-studio/shared/fallbackOptions";
import { createModelSelection } from "@specweave-studio/shared/model";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import { ArrowDownIcon, ArrowUpIcon, CornerDownRightIcon, XIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { getLocale, t, useT, type Translate } from "../../i18n";
import { renderRich } from "../../i18n/rich";

/** At most this many fallback models; the contract refuses more. */
export const MAX_FALLBACK_MODELS = 8;

/** "Codex · GPT-6 Astra": the provider as the user named it, then the model's own name. */
export function fallbackEntryLabel(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const providerName = provider?.displayName ?? selection.instanceId;
  const model = describeModel(provider, selection.model);
  return `${providerName} · ${"name" in model && model.name ? model.name : selection.model}`;
}

/** Adds an entry at the end; a model already in the order stays where it is. */
export function addFallbackEntry(
  order: ReadonlyArray<ModelSelection>,
  instanceId: ModelSelection["instanceId"],
  model: string,
): ReadonlyArray<ModelSelection> {
  if (order.length >= MAX_FALLBACK_MODELS) return order;
  if (order.some((entry) => entry.instanceId === instanceId && entry.model === model)) return order;
  return [...order, createModelSelection(instanceId, model)];
}

export function moveFallbackEntry(
  order: ReadonlyArray<ModelSelection>,
  index: number,
  by: -1 | 1,
): ReadonlyArray<ModelSelection> {
  const to = index + by;
  if (index < 0 || index >= order.length || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Whether a step can take work now: the same words for the fallback and reviewer orders. */
export type ModelOrderStatus = ReviewerStepStatus;

/** "3:30 PM" today, else "Fri 3:30 PM": a weekly reset is days away. */
const clock = (ms: number) => {
  const at = new Date(ms);
  return at.toDateString() === new Date().toDateString()
    ? at.toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(getLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" });
};

export function modelOrderStatusChip(
  status: ModelOrderStatus,
  resetAt: number | null = null,
  tr: Translate = t,
): { readonly label: string; readonly variant: "success" | "info" | "warning" | "outline" } {
  switch (status) {
    case "ready":
      return { label: tr("fallback.chip.ready"), variant: "success" };
    case "unverified":
      return { label: tr("fallback.chip.unverified"), variant: "info" };
    case "full":
      return {
        label:
          resetAt === null
            ? tr("fallback.chip.full")
            : tr("fallback.chip.fullUntil", { time: clock(resetAt) }),
        variant: "warning",
      };
    case "limited":
      return { label: tr("fallback.chip.limited"), variant: "warning" };
    case "signed-out":
      return { label: tr("fallback.chip.signedOut"), variant: "warning" };
    case "per-token":
      return { label: tr("fallback.chip.perToken"), variant: "warning" };
    case "too-small":
      return { label: tr("fallback.chip.tooSmall"), variant: "outline" };
    case "not-ready":
      return { label: tr("fallback.chip.notReady"), variant: "outline" };
    case "missing":
      return { label: tr("fallback.chip.missing"), variant: "outline" };
    case "excluded":
      return { label: tr("fallback.chip.excluded"), variant: "outline" };
    case "unknown-billing":
      return { label: tr("fallback.chip.unknownBilling"), variant: "outline" };
  }
}

/** One step of an ordered model list, as a row shows it. */
export interface ModelOrderStep {
  readonly selection: Pick<ModelSelection, "instanceId" | "model">;
  readonly status?: ModelOrderStatus | undefined;
  readonly resetAt?: number | null | undefined;
  readonly family?: ModelFamily | undefined;
  /** The same model on other providers, tried right after this step. */
  readonly alternates?: ReadonlyArray<ModelOrderStep> | undefined;
}

function StatusChip(props: { readonly step: ModelOrderStep }) {
  const tr = useT();
  if (props.step.status === undefined) return null;
  const chip = modelOrderStatusChip(props.step.status, props.step.resetAt ?? null, tr);
  return (
    <Badge variant={chip.variant} className="shrink-0" data-status={props.step.status}>
      {chip.label}
    </Badge>
  );
}

/**
 * A numbered model order, one row per step: provider mark, model, provider
 * account and family, and whether it can take work now. The same model on
 * other providers sits indented under its step. Rows can be moved and removed
 * when `onChange` is given; a default order shows read-only.
 */
export function ModelOrderList(props: {
  readonly label: string;
  readonly steps: ReadonlyArray<ModelOrderStep>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The stored order behind the steps; moving and removing rewrite it. */
  readonly order?: ReadonlyArray<ModelSelection> | undefined;
  readonly onChange?: ((order: ReadonlyArray<ModelSelection>) => void) | undefined;
  readonly className?: string | undefined;
}) {
  const tr = useT();
  const { label, steps, providers, order, onChange } = props;
  const entries = useMemo(() => deriveProviderInstanceEntries(providers), [providers]);
  if (steps.length === 0) return null;
  const editable = onChange !== undefined && order !== undefined;
  const identity = (selection: ModelOrderStep["selection"]) => {
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    const model = describeModel(provider, selection.model);
    return {
      entry: entries.find((entry) => entry.instanceId === selection.instanceId),
      providerName: provider?.displayName ?? selection.instanceId,
      modelName: "name" in model && model.name ? model.name : selection.model,
    };
  };
  const icon = (entry: ReturnType<typeof identity>["entry"], size: string) =>
    entry ? (
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        className="shrink-0"
        iconClassName={size}
      />
    ) : (
      <span aria-hidden className={cn("shrink-0 rounded-full bg-muted", size)} />
    );
  return (
    <ol
      aria-label={label}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border/70",
        props.className,
      )}
    >
      {steps.map((step, index) => {
        const { entry, providerName, modelName } = identity(step.selection);
        const rowLabel = `${providerName} · ${modelName}`;
        const at = editable
          ? order.findIndex(
              (item) =>
                item.instanceId === step.selection.instanceId &&
                item.model === step.selection.model,
            )
          : -1;
        return (
          <li
            key={`${step.selection.instanceId}:${step.selection.model}`}
            className="border-b border-border/60 px-2.5 py-2 last:border-b-0"
            data-step={index + 1}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground tabular-nums"
              >
                {index + 1}
              </span>
              {icon(entry, "size-4")}
              {/* The chip wraps under the name on a narrow row instead of squeezing it. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex min-w-[9rem] flex-1 flex-col" data-label={rowLabel}>
                  <span className="truncate text-sm font-medium text-foreground">{modelName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {providerName}
                    {step.family
                      ? ` · ${tr("fallback.family", { family: MODEL_FAMILY_LABELS[step.family] })}`
                      : ""}
                  </span>
                </span>
                <StatusChip step={step} />
              </span>
              {editable && at >= 0 ? (
                <span className="flex shrink-0 items-center">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={tr("fallback.moveUp", { label: rowLabel })}
                    disabled={at === 0}
                    onClick={() => onChange(moveFallbackEntry(order, at, -1))}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={tr("fallback.moveDown", { label: rowLabel })}
                    disabled={at === order.length - 1}
                    onClick={() => onChange(moveFallbackEntry(order, at, 1))}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={tr("fallback.remove", { label: rowLabel })}
                    onClick={() => onChange(order.filter((_, item) => item !== at))}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
              ) : null}
            </div>
            {step.alternates && step.alternates.length > 0 ? (
              <ul
                aria-label={tr("fallback.sameModelAria", { label: rowLabel })}
                className="mt-1.5 ml-[1.375rem] flex flex-col gap-1 border-l border-border/70 pl-3"
              >
                {step.alternates.map((alternate) => {
                  const alt = identity(alternate.selection);
                  return (
                    <li
                      key={`${alternate.selection.instanceId}:${alternate.selection.model}`}
                      className="flex min-w-0 items-start gap-2 [&>svg]:mt-0.5 [&>span:first-of-type]:mt-px"
                    >
                      <CornerDownRightIcon
                        aria-hidden
                        className="size-3 shrink-0 text-icon-muted"
                      />
                      {icon(alt.entry, "size-3.5")}
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span
                          className="min-w-[10rem] flex-1 truncate text-xs text-muted-foreground"
                          data-label={`${alt.providerName} · ${alt.modelName}`}
                        >
                          {renderRich(tr("fallback.sameModelOn"), {
                            provider: <span className="text-foreground">{alt.providerName}</span>,
                          })}
                        </span>
                        <StatusChip step={alternate} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The fallback order as numbered rows a person can reorder or remove. The
 * first row that can take a limited thread is the one it continues on.
 */
export function FallbackOrderList(props: {
  readonly order: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (order: ReadonlyArray<ModelSelection>) => void;
  readonly statuses?: ReadonlyMap<string, Pick<ModelOrderStep, "status" | "resetAt">> | undefined;
}) {
  const tr = useT();
  const { order, providers, onChange, statuses } = props;
  const steps = order.map((selection) => ({
    selection,
    ...statuses?.get(`${selection.instanceId}:${selection.model}`),
  }));
  return (
    <ModelOrderList
      label={tr("fallback.orderLabel")}
      className="mt-3 mb-2"
      steps={steps}
      providers={providers}
      order={order}
      onChange={onChange}
    />
  );
}
