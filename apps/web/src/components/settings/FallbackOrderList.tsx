import type { ModelSelection, ServerProvider } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";

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

/**
 * The fallback order as numbered rows a person can reorder or remove. The
 * first row that can take a limited thread is the one it continues on.
 */
export function FallbackOrderList(props: {
  readonly order: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (order: ReadonlyArray<ModelSelection>) => void;
}) {
  const { order, providers, onChange } = props;
  if (order.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1" aria-label="Fallback order">
      {order.map((entry, index) => {
        const label = fallbackEntryLabel(providers, entry);
        const missing = !providers.some((provider) => provider.instanceId === entry.instanceId);
        return (
          <li
            key={`${entry.instanceId}:${entry.model}`}
            className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1 text-sm"
          >
            <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate" title={label}>
              {label}
              {missing ? (
                <span className="ml-2 text-xs text-muted-foreground">not on this machine</span>
              ) : null}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${label} up`}
              disabled={index === 0}
              onClick={() => onChange(moveFallbackEntry(order, index, -1))}
            >
              <ArrowUpIcon className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${label} down`}
              disabled={index === order.length - 1}
              onClick={() => onChange(moveFallbackEntry(order, index, 1))}
            >
              <ArrowDownIcon className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${label}`}
              onClick={() => onChange(order.filter((_, at) => at !== index))}
            >
              <XIcon className="size-3" />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
