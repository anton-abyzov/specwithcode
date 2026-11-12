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
  "flex min-w-0 flex-col gap-2 rounded-2xl border bg-card px-3.5 py-3 text-card-foreground",
  "border-border/70 shadow-access-card",
  "dark:border-white/[0.08] dark:bg-access-card dark:shadow-access-card-dark",
);

/** The list of things asked for: one rounded chip per subject. */
export const ACCESS_SUBJECT_LIST_CLASS = "flex min-w-0 flex-col gap-1";

const CHIP_CLASS =
  "flex min-h-9 min-w-0 items-center gap-2.5 rounded-xl bg-foreground/[0.045] px-2.5 py-1.5 dark:bg-white/[0.06]";

/** The small accent shield at the left of the title. */
export function AccessCardTile() {
  return (
    <span
      aria-hidden
      data-access-card-tile
      className="flex h-5 shrink-0 items-center text-access-tile"
    >
      <ShieldIcon className="size-4" strokeWidth={2.25} />
    </span>
  );
}

/** One left-aligned line: shield and title (what is asked), then the reason in muted text. */
export function AccessCardHeader(props: {
  readonly titleId?: string;
  readonly title: ReactNode;
  readonly reason?: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-start gap-2">
        <AccessCardTile />
        <h3
          id={props.titleId}
          data-access-request-title
          className="min-w-0 text-sm/5 font-medium text-foreground wrap-break-word"
        >
          {props.title}
        </h3>
      </div>
      {props.reason ? (
        <div className="min-w-0 ps-6 text-xs/5 text-muted-foreground wrap-break-word">
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
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col text-sm/5 font-medium text-foreground wrap-break-word">
        {label}
      </span>
      {trailing ? <span className="flex shrink-0 items-center">{trailing}</span> : null}
    </li>
  );
}

/** The small pill at a chip's right ("All"). */
export function AccessChipTag({ children }: { readonly children: ReactNode }) {
  return (
    <span className="rounded-full bg-access-tag px-1.5 py-px text-2xs/4 font-medium text-access-tag-foreground">
      {children}
    </span>
  );
}

const PILL =
  "inline-flex h-8 min-w-0 cursor-pointer items-center justify-center rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-[background-color,border-color,scale] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.98] disabled:cursor-default disabled:opacity-60";

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

/** Compact buttons, left-aligned on one row; they wrap only when the row is too narrow. */
export const ACCESS_BUTTON_ROW_CLASS =
  "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5";
