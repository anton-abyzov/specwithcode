import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { FallbackOption, FallbackOptionGroup } from "@specweave-studio/shared/fallbackOptions";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { getLocale, t, useT, type Translate } from "../../i18n";
import {
  type FallbackProviderBlock,
  fallbackFamilySummaryLabel,
  isUsableFallbackOption,
  layoutFallbackFamily,
  sameAccess,
  summarizeFallbackFamily,
} from "./fallbackOptionsLayout";

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" });

/** Whether, and why not, a limited thread can continue on this model now. */
export function fallbackOptionStatusLabel(option: FallbackOption, tr: Translate = t): string {
  switch (option.status) {
    case "ready":
      return tr("fallback.status.ready");
    case "unverified":
      return tr("fallback.status.unverified");
    case "current":
      return tr("fallback.status.current");
    case "excluded":
      return tr("fallback.status.excluded");
    case "disabled":
      return tr("fallback.status.disabled");
    case "signed-out":
      return tr("fallback.status.signedOut");
    case "not-ready":
      return tr("fallback.status.notReady");
    case "limited":
      return tr("fallback.status.limited");
    case "full":
      return option.resetAt === null
        ? tr("fallback.status.full")
        : tr("fallback.status.fullUntil", { time: clock(option.resetAt) });
    case "per-token":
      return tr("fallback.status.perToken");
    case "never-automatic":
      return tr("fallback.status.neverAutomatic");
    case "named-only":
      return tr("fallback.status.namedOnly");
  }
}

/** What backs the access, as far as SpecWithCode can see. */
export function fallbackOptionAccessLabel(option: FallbackOption, tr: Translate = t): string {
  switch (option.access) {
    case "usage-read":
      if (option.usedPercent === null)
        return option.status === "unverified"
          ? tr("fallback.access.notRead")
          : tr("fallback.access.reported");
      // An old reading is not current room: say it is the last one.
      return option.status === "unverified"
        ? tr("fallback.access.lastRead", { percent: Math.round(option.usedPercent) })
        : tr("fallback.access.planUsage", { percent: Math.round(option.usedPercent) });
    case "no-usage-reported":
      return tr("fallback.access.noUsage");
    case "per-token":
      return tr("fallback.access.perToken");
    case "unknown":
      return tr("fallback.access.unknown");
  }
}

function statusDot(option: FallbackOption) {
  return isUsableFallbackOption(option)
    ? "bg-success"
    : option.status === "current"
      ? "bg-muted-foreground/40"
      : "bg-warning";
}

function OptionRow(props: {
  readonly option: FallbackOption;
  readonly common: FallbackProviderBlock["common"];
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean | undefined;
}) {
  const tr = useT();
  const { option, common, onToggleExcluded, disabled } = props;
  // The block header already says what most rows share; a row adds only what differs.
  const notes = [
    option.status === common.status ? null : fallbackOptionStatusLabel(option, tr),
    sameAccess(option, common) ? null : fallbackOptionAccessLabel(option, tr),
  ].filter((note): note is string => note !== null);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1 text-sm hover:bg-accent/40">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusDot(option))} />
      <span className="min-w-40 flex-1 truncate">
        <span className={cn(option.excluded && "line-through opacity-60")}>{option.modelName}</span>
        {option.orderIndex !== null ? (
          <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
            {tr("fallback.inOrder", { index: option.orderIndex + 1 })}
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
        aria-label={tr(option.excluded ? "fallback.includeAria" : "fallback.excludeAria", {
          model: option.modelName,
        })}
        onClick={() => onToggleExcluded(option.selection.model)}
      >
        {option.excluded ? tr("fallback.include") : tr("fallback.exclude")}
      </Button>
    </li>
  );
}

function ProviderBlock(props: {
  readonly block: FallbackProviderBlock;
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean | undefined;
}) {
  const tr = useT();
  const { block, onToggleExcluded, disabled } = props;
  const [showOlder, setShowOlder] = useState(false);
  const sample = block.shown[0] ?? block.older[0]!;
  const headerOption = { ...sample, ...block.common };
  const rows = showOlder ? [...block.shown, ...block.older] : block.shown;
  return (
    <section
      aria-label={tr("fallback.providerModels", { provider: block.providerName })}
      className="flex flex-col gap-0.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 px-2 pb-0.5">
        <h5 className="text-xs font-medium text-foreground/80">{block.providerName}</h5>
        <span className="text-xs text-muted-foreground" data-testid="provider-block-status">
          {fallbackOptionStatusLabel(headerOption, tr)} ·{" "}
          {fallbackOptionAccessLabel(headerOption, tr)}
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
            ? tr("fallback.hideOlder")
            : tr("fallback.showOlder", { count: block.older.length })}
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
  const tr = useT();
  const { group, onToggleExcluded, disabled, defaultOpen } = props;
  const [open, setOpen] = useState(defaultOpen);
  const blocks = layoutFallbackFamily(group);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section aria-label={tr("fallback.providerModels", { provider: group.label })} />}
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
            {fallbackFamilySummaryLabel(summarizeFallbackFamily(group), tr)}
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
  const tr = useT();
  const { groups, onToggleExcluded, disabled } = props;
  if (groups.length === 0)
    return <p className="text-sm text-muted-foreground">{tr("fallback.noProviders")}</p>;
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
      <p className="text-xs text-muted-foreground">{tr("fallback.footnote")}</p>
    </div>
  );
}
