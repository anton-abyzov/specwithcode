/**
 * The cover Overview opens on, built only from the system's own data: its
 * name set in its display face, its description, and a mosaic of its own
 * colors. A system without colors shows the name alone.
 */
import type { DesignSystem } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { relativeLuminance } from "./contrast";
import {
  baseValue,
  hexOf,
  measureColor,
  parseTypeStyle,
  resolveFamily,
  safeFamily,
  shownValue,
} from "./tokenValues";

const MOSAIC_MAX = 8;

const rank = (name: string) => {
  const lower = name.toLowerCase();
  if (/brand|accent|primary|iris/.test(lower)) return 0;
  if (/success|warning|danger|error|info|status/.test(lower)) return 2;
  return 1;
};

/**
 * Up to eight distinct opaque colors from the first mode: brand and accent
 * first, then the rest in the system's order, status colors last.
 * Near-white grounds are left out, since they vanish on the card.
 */
export function coverColors(system: Pick<DesignSystem, "tokens" | "modes">): string[] {
  const seen = new Set<string>();
  const picked: { hex: string; rank: number; index: number }[] = [];
  system.tokens.forEach((token, index) => {
    if (token.type !== "color") return;
    const value = baseValue(token, system.modes);
    const color = value === null ? null : measureColor(shownValue(value));
    if (color === null || color.a < 0.99 || relativeLuminance(color) > 0.86) return;
    const hex = hexOf(color);
    if (seen.has(hex)) return;
    seen.add(hex);
    picked.push({ hex, rank: rank(token.name), index });
  });
  return picked
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MOSAIC_MAX)
    .map((entry) => entry.hex);
}

/** Columns of one or two tiles; four colors or fewer get one tile each. */
export function mosaicColumns(colors: readonly string[]): string[][] {
  if (colors.length <= 4) return colors.map((color) => [color]);
  const columns = Math.min(4, Math.ceil(colors.length / 2));
  return Array.from({ length: columns }, (_, column) =>
    [colors[column * 2], colors[column * 2 + 1]].filter((color) => color !== undefined),
  );
}

const DISPLAY_NAMES = [/display/, /hero/, /h1$|-h1-|heading|title/];

/** The family the system sets its display type in, or null for the app's own face. */
export function displayFamily(system: Pick<DesignSystem, "tokens" | "modes">): string | null {
  const styles = system.tokens.filter((token) => token.type === "typography");
  const style =
    DISPLAY_NAMES.map((pattern) =>
      styles.find((token) => pattern.test(token.name.toLowerCase())),
    ).find((token) => token !== undefined) ?? styles[0];
  const raw = style === undefined ? null : baseValue(style, system.modes)?.raw;
  const parsed = raw === null || raw === undefined ? null : parseTypeStyle(raw);
  if (parsed !== null) {
    const family = safeFamily(resolveFamily(parsed.family, system.tokens));
    if (family !== null) return family;
  }
  const families = system.tokens.filter((token) => token.type === "fontFamily");
  const family =
    families.find((token) => /display|heading|sans/.test(token.name.toLowerCase())) ?? families[0];
  const value = family === undefined ? null : baseValue(family, system.modes);
  return value === null ? null : safeFamily(resolveFamily(value.raw, system.tokens));
}

/**
 * The name's size: a tenth of its column between 1.25rem and 5.5rem, then
 * smaller still when its longest word would not fit on one line (0.62em per
 * letter covers bold display faces), down to 1rem.
 */
export function coverNameSize(name: string): string {
  const longest = Math.max(1, ...name.split(/\s+/).map((word) => word.length));
  const fit = `calc(100cqi / ${(longest * 0.62).toFixed(2)})`;
  return `max(1rem, min(clamp(1.25rem, 10cqi, 5.5rem), ${fit}))`;
}

/** Tile heights per column, so the mosaic steps like a woven pattern. */
const WEIGHTS = [
  [1, 1.7],
  [1.8, 1],
  [1, 1.4],
  [1.6, 1],
];

export function OverviewCover({
  system,
  headingId,
  children,
}: {
  system: Pick<DesignSystem, "name" | "tokens" | "modes">;
  headingId: string;
  /** The description, under the name. */
  children: ReactNode;
}) {
  const columns = mosaicColumns(coverColors(system));
  const family = displayFamily(system);
  return (
    // Lay out on the cover's own width, not the window's, so words stay whole
    // beside the sidebars. A container can't query itself, so the grid sits inside.
    <div className="@container/cover border-border/50 border-b" data-testid="overview-cover">
      <div
        className={cn(
          "grid min-h-56",
          columns.length > 0 && "@2xl/cover:grid-cols-[minmax(0,1fr)_minmax(15rem,42%)]",
        )}
        data-testid="overview-cover-grid"
      >
        <div className="@container flex min-w-0 flex-col justify-center gap-4 px-5 py-10 @xl/cover:px-10 @xl/cover:py-14">
          <h2
            id={headingId}
            className="break-words font-bold text-foreground leading-[0.98] tracking-[-0.035em] [text-wrap:balance]"
            style={{
              fontSize: coverNameSize(system.name),
              ...(family === null ? {} : { fontFamily: family }),
            }}
            data-testid="overview-cover-name"
          >
            {system.name}
          </h2>
          {children}
        </div>
        {columns.length > 0 ? (
          <div
            aria-hidden
            data-testid="overview-mosaic"
            className="grid min-h-44 gap-3 @max-2xl/cover:h-44 @xl/cover:gap-4"
            style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
          >
            {columns.map((tiles, column) => (
              <div key={tiles.join(" ")} className="flex min-h-0 flex-col gap-3 @xl/cover:gap-4">
                {tiles.map((color, index) => (
                  <div
                    key={color}
                    data-color={color}
                    className="min-h-6 ring-1 ring-black/5 ring-inset dark:ring-white/10"
                    style={{
                      backgroundColor: color,
                      flexGrow: tiles.length === 1 ? 1 : WEIGHTS[column % 4]![index],
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
