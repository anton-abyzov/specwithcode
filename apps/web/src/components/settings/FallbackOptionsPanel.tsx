import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { FallbackOption, FallbackOptionGroup } from "@specweave-studio/shared/fallbackOptions";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  type FallbackProviderBlock,
  fallbackFamilySummaryLabel,
  isUsableFallbackOption,
  layoutFallbackFamily,
  sameAccess,
  summarizeFallbackFamily,
} from "./fallbackOptionsLayout";

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Whether, and why not, a limited thread can continue on this model now. */
export function fallbackOptionStatusLabel(option: FallbackOption): string {
  switch (option.status) {
    case "ready":
      return "Can take a limited thread";
    case "unverified":
      return "Signed in, no recent usage reading";
    case "current":
      return "This thread's model";
    case "excluded":
      return "Excluded from automatic fallback";
    case "disabled":
      return "Turned off";
    case "signed-out":
      return "Signed out";
    case "not-ready":
      return "Not set up on this machine";
    case "limited":
      return "At its limit";
    case "full":
      return option.resetAt === null ? "Full" : `Full until ${clock(option.resetAt)}`;
    case "per-token":
      return "Billed per token: only when you name it or allow API credits";
    case "never-automatic":
      return "Bills a Google Cloud project: never automatic";
    case "named-only":
      return "Billing unknown: only when you name it";
  }
}

/** What backs the access, as far as SpecWithCode can see. */
export function fallbackOptionAccessLabel(option: FallbackOption): string {
  switch (option.access) {
    case "usage-read":
      if (option.usedPercent === null)
        return option.status === "unverified" ? "Plan usage not read" : "Plan usage reported";
      // An old reading is not current room: say it is the last one.
      return option.status === "unverified"
        ? `Last read ${Math.round(option.usedPercent)}% used`
        : `Plan usage ${Math.round(option.usedPercent)}% used`;
    case "no-usage-reported":
      return "Signed in; provider reports no usage";
    case "per-token":
      return "Billed per token";
    case "unknown":
      return "Access unknown";
  }
}

function statusDot(option: FallbackOption) {
  return isUsableFallbackOption(option)
    ? "bg-emerald-500"
    : option.status === "current"
      ? "bg-muted-foreground/40"
      : "bg-amber-500";
}

function OptionRow(props: {
  readonly option: FallbackOption;
  readonly common: FallbackProviderBlock["common"];
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean | undefined;
}) {
  const { option, common, onToggleExcluded, disabled } = props;
  // The block header already says what most rows share; a row adds only what differs.
  const notes = [
    option.status === common.status ? null : fallbackOptionStatusLabel(option),
    sameAccess(option, common) ? null : fallbackOptionAccessLabel(option),
  ].filter((note): note is string => note !== null);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1 text-sm hover:bg-accent/40">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDot(option))} />
      <span className="min-w-40 flex-1 truncate">
        <span className={cn(option.excluded && "line-through opacity-60")}>{option.modelName}</span>
        {option.orderIndex !== null ? (
          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
            #{option.orderIndex + 1} in order
          </span>
        ) : null}
      </span>
      {notes.length > 0 ? (
        <span className="text-xs text-muted-foreground">{notes.join(" · ")}</span>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={disabled}
        aria-label={`${option.excluded ? "Include" : "Exclude"} ${option.modelName}`}
        onClick={() => onToggleExcluded(option.selection.model)}
      >
        {option.excluded ? "Include" : "Exclude"}
      </Button>
    </li>
  );
}

function ProviderBlock(props: {
  readonly block: FallbackProviderBlock;
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean | undefined;
}) {
  const { block, onToggleExcluded, disabled } = props;
  const [showOlder, setShowOlder] = useState(false);
  const sample = block.shown[0] ?? block.older[0]!;
  const headerOption = { ...sample, ...block.common };
  const rows = showOlder ? [...block.shown, ...block.older] : block.shown;
  return (
    <section aria-label={`${block.providerName} models`} className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 px-2 pb-0.5">
        <h5 className="text-xs font-medium text-foreground/80">{block.providerName}</h5>
        <span className="text-xs text-muted-foreground" data-testid="provider-block-status">
          {fallbackOptionStatusLabel(headerOption)} · {fallbackOptionAccessLabel(headerOption)}
        </span>
      </div>
      <ul className="flex flex-col">
        {rows.map((option) => (
          <OptionRow
            key={`${option.selection.instanceId}:${option.selection.model}`}
            option={option}
            common={block.common}
            onToggleExcluded={onToggleExcluded}
            disabled={disabled}
          />
        ))}
      </ul>
      {block.older.length > 0 ? (
        <button
          type="button"
          aria-expanded={showOlder}
          className="self-start rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setShowOlder((open) => !open)}
        >
          {showOlder
            ? "Hide older versions"
            : `Show ${block.older.length} older ${block.older.length === 1 ? "version" : "versions"}`}
        </button>
      ) : null}
    </section>
  );
}

function FamilySection(props: {
  readonly group: FallbackOptionGroup;
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean | undefined;
  readonly defaultOpen: boolean;
}) {
  const { group, onToggleExcluded, disabled, defaultOpen } = props;
  const [open, setOpen] = useState(defaultOpen);
  const blocks = layoutFallbackFamily(group);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section aria-label={`${group.label} models`} />}
      className="rounded-lg border border-border/70"
    >
      <h4>
        <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 text-sm font-medium" data-testid="family-label">
            {group.label}
          </span>
          <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
            {fallbackFamilySummaryLabel(summarizeFallbackFamily(group))}
          </span>
        </CollapsibleTrigger>
      </h4>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 border-t border-border/50 px-1 py-2">
          {blocks.map((block) => (
            <ProviderBlock
              key={block.key}
              block={block}
              onToggleExcluded={onToggleExcluded}
              disabled={disabled}
            />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Every model on this machine a limited thread could continue on: one folded
 * section per family, one block per provider inside it with the shared status
 * and usage said once, and older versions of a model line behind a toggle.
 * Excluding the models below the one you trust in a family is how that family
 * gets its minimum.
 */
export function FallbackOptionsPanel(props: {
  readonly groups: ReadonlyArray<FallbackOptionGroup>;
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean;
}) {
  const { groups, onToggleExcluded, disabled } = props;
  if (groups.length === 0)
    return <p className="text-sm text-muted-foreground">No providers on this machine yet.</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="fallback-options">
      {groups.map((group) => (
        <FamilySection
          key={group.family}
          group={group}
          onToggleExcluded={onToggleExcluded}
          disabled={disabled}
          defaultOpen={groups.length === 1}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        Excluding a model keeps it out of every automatic switch on every provider; you can still
        pick it yourself. New models are allowed until you exclude them. Access shown here is only
        what SpecWithCode can see: GitHub Actions minutes, an X subscription or startup credits are
        not model access unless one of these providers is signed in with them.
      </p>
    </div>
  );
}
