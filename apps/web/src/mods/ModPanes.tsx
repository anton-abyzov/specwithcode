import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { MOD_STAT_TONE_CLASS, ModStatGlyph } from "./ModStatGlyph";
import { type ModPane, useModsStore } from "./modsStore";
import { MOD_STAT_GLYPHS, type ModNode, type ModStat, type ModTone } from "./protocol";

const TONE_CLASS: Record<ModTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  strong: "font-semibold text-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

const GAP_CLASS = ["gap-0", "gap-1", "gap-2", "gap-3", "gap-4", "gap-5", "gap-6"] as const;

/** Draws a checked mod tree with workbench components; text stays text. */
export function ModTree({
  node,
  onPress,
}: {
  node: ModNode;
  onPress: (handler: number) => void;
}): ReactNode {
  if (typeof node === "string") return node;
  const children = node.children.map((child, index) => (
    // Mod trees carry no keys; order is the identity within one draw.
    // oxlint-disable-next-line react/no-array-index-key
    <ModTree key={index} node={child} onPress={onPress} />
  ));
  switch (node.type) {
    case "Box":
      return (
        <div
          className={cn(
            "flex min-w-0",
            node.direction === "row" ? "flex-row flex-wrap items-center" : "flex-col",
            GAP_CLASS[node.gap],
          )}
        >
          {children}
        </div>
      );
    case "Text":
      return (
        <span
          className={cn(
            "min-w-0 break-words text-sm",
            TONE_CLASS[node.tone],
            node.mono && "font-mono",
          )}
        >
          {children}
        </span>
      );
    case "Button": {
      const handler = node.handler;
      return (
        <Button
          size="compact"
          variant={node.variant}
          disabled={node.disabled || handler === null}
          onClick={() => {
            if (handler !== null) onPress(handler);
          }}
        >
          {children}
        </Button>
      );
    }
  }
}

function ModPaneDialog({ pane }: { pane: ModPane }) {
  const channel = useModsStore((state) => state.channels[pane.mod]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) channel?.closePane(pane.id);
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{pane.title}</DialogTitle>
          <DialogDescription>From the {pane.mod} mod</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {pane.tree === null ? (
            <span className="text-sm text-muted-foreground">Nothing to show yet.</span>
          ) : (
            <ModTree node={pane.tree} onPress={(handler) => channel?.press(pane.id, handler)} />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The most recently opened pane is shown; closing it reveals the one below. */
export function ModPanes() {
  const pane = useModsStore((state) => state.panes.at(-1));
  return pane ? <ModPaneDialog key={`${pane.mod}:${pane.id}`} pane={pane} /> : null;
}

const MOD_STAT_COUNT_CAP = 999;
export const formatModStatCount = (count: number) =>
  count > MOD_STAT_COUNT_CAP ? `${MOD_STAT_COUNT_CAP}+` : String(count);

export interface ModStatRow extends ModStat {
  readonly mod: string;
}

/** Every mod's stats as one list, most urgent first; equal glyphs keep the mods' order. */
export function orderModStats(
  stats: Readonly<Record<string, ReadonlyArray<ModStat>>>,
): ReadonlyArray<ModStatRow> {
  return Object.entries(stats)
    .flatMap(([mod, list]) => list.map((stat) => ({ ...stat, mod })))
    .toSorted((a, b) => MOD_STAT_GLYPHS.indexOf(a.glyph) - MOD_STAT_GLYPHS.indexOf(b.glyph));
}

/** One stat as a glyph and a count; its word is the tooltip and pressing it opens its list. */
function ModStatIcon({ stat }: { stat: ModStatRow }) {
  const channel = useModsStore((state) => state.channels[stat.mod]);
  const handler = stat.handler;
  const count = formatModStatCount(stat.count);
  const iconClass =
    "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-foreground tabular-nums";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          handler === null ? (
            <span className={iconClass} role="img" aria-label={`${count} ${stat.label}`} />
          ) : (
            <button
              type="button"
              aria-label={`${count} ${stat.label}`}
              className={cn(
                iconClass,
                "cursor-pointer hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
              )}
              onClick={() => channel?.pressStat(handler)}
            />
          )
        }
      >
        <ModStatGlyph
          name={stat.glyph}
          className={cn("size-3.5", MOD_STAT_TONE_CLASS[stat.glyph])}
        />
        {count}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        <div className="font-medium">{stat.label}</div>
        {stat.detail === null ? null : <div>{stat.detail}</div>}
        <div className="text-muted-foreground">From the {stat.mod} mod</div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Mods' counts as icons and their plain status text as pills, for the sidebar footer. */
export function ModStatusItems() {
  const status = useModsStore((state) => state.status);
  const stats = useModsStore((state) => state.stats);
  const entries = Object.entries(status);
  const rows = orderModStats(stats);
  if (entries.length === 0 && rows.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-1" aria-label="Mod status">
      {rows.map((stat) => (
        <ModStatIcon key={`${stat.mod}:${stat.glyph}:${stat.label}`} stat={stat} />
      ))}
      {entries.map(([mod, text]) => (
        <Tooltip key={mod}>
          <TooltipTrigger
            render={
              <span className="max-w-full truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" />
            }
          >
            {text}
          </TooltipTrigger>
          <TooltipPopup side="top">{mod} mod</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
