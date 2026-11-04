/**
 * The access card's look, kept free of app state so the macOS permission card
 * and fixtures can use it without loading the server connection.
 *
 * @module AccessCardChrome
 */
import { ShieldIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

/** The card's frame; the macOS permission card uses it too, so both read as one kind of ask. */
export const ACCESS_CARD_CLASS = cn(
  "flex min-w-0 flex-col gap-3 rounded-3xl border bg-card px-4 pt-5 pb-4 text-card-foreground sm:px-5",
  "border-border/70 shadow-access-card",
  "dark:border-white/[0.08] dark:bg-access-card dark:shadow-access-card-dark",
);

/** The list of things asked for: one rounded chip per subject. */
export const ACCESS_SUBJECT_LIST_CLASS = "flex min-w-0 flex-col gap-1.5";

const CHIP_CLASS =
  "flex min-h-12 min-w-0 items-center gap-3 rounded-2xl bg-foreground/[0.045] px-3 py-2 dark:bg-white/[0.06]";

/** The small accent tile at the top of the card. */
export function AccessCardTile() {
  return (
    <span
      aria-hidden
      data-access-card-tile
      className="mx-auto flex size-11 items-center justify-center rounded-xl bg-access-tile text-access-tile-foreground shadow-access-tile"
    >
      <ShieldIcon className="size-5.5" strokeWidth={2} />
    </span>
  );
}

/** Tile, centered title (what is asked) and the reason under it. */
export function AccessCardHeader(props: {
  readonly titleId?: string;
  readonly title: ReactNode;
  readonly reason?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-1.5">
      <AccessCardTile />
      <h3
        id={props.titleId}
        data-access-request-title
        className="mt-2 min-w-0 text-center text-base/snug font-semibold text-balance text-foreground wrap-break-word"
      >
        {props.title}
      </h3>
      {props.reason ? (
        <div className="min-w-0 text-sm/relaxed text-muted-foreground wrap-break-word">
          {props.reason}
        </div>
      ) : null}
    </header>
  );
}

/** One requested thing: its icon, its name and, at the right, a tag or an action. */
export function AccessChip({
  icon,
  label,
  trailing,
  className,
  ...props
}: {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
} & Omit<ComponentProps<"li">, "children">) {
  return (
    <li {...props} className={cn(CHIP_CLASS, className)}>
      <span className="flex size-7 shrink-0 items-center justify-center" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm font-medium text-foreground wrap-break-word">
        {label}
      </span>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </li>
  );
}

/** The small pill at a chip's right ("All"). */
export function AccessChipTag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="rounded-full bg-access-tag px-2.5 py-0.5 text-xs font-medium text-access-tag-foreground">
      {children}
    </span>
  );
}

const PILL =
  "inline-flex h-10 min-w-0 cursor-pointer items-center justify-center rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-[background-color,border-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.98] disabled:cursor-default disabled:opacity-60";

/** The card's quiet button: outlined pill. */
export const ACCESS_SECONDARY_BUTTON_CLASS = cn(
  PILL,
  "border border-border bg-card text-foreground hover:bg-foreground/[0.04] dark:border-white/15 dark:bg-transparent dark:hover:bg-white/[0.06]",
);

/** The card's answer: near-black pill in light mode, inverted in dark. */
export const ACCESS_PRIMARY_BUTTON_CLASS = cn(
  PILL,
  "border border-transparent bg-access-primary text-access-primary-foreground hover:bg-access-primary-hover",
);

/** Two equal buttons in a row; they stack only when both do not fit. */
export const ACCESS_BUTTON_ROW_CLASS =
  "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,9.75rem),1fr))] gap-2.5 pt-1";
