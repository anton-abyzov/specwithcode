import type { ReactNode } from "react";

import { CREATION_DESCRIPTIONS, CREATION_LABELS, type CreationKind } from "./galleryModel";

/** Small line drawings, one per kind, drawn in the app's own ink and accent. */
const ART: Record<CreationKind, ReactNode> = {
  design: (
    <svg viewBox="0 0 120 72" aria-hidden className="h-full w-full" strokeWidth={1.25}>
      <rect x="30" y="10" width="60" height="52" rx="3" className="fill-background stroke-border" />
      <circle cx="48" cy="30" r="9" className="fill-primary/25 stroke-primary" />
      <rect
        x="58"
        y="34"
        width="22"
        height="16"
        rx="2"
        className="fill-foreground/10 stroke-foreground/50"
      />
      <path d="M38 54h28" className="stroke-foreground/40" strokeLinecap="round" />
    </svg>
  ),
  "design-from-code": (
    <svg viewBox="0 0 120 72" aria-hidden className="h-full w-full" strokeWidth={1.25}>
      <rect
        x="16"
        y="16"
        width="48"
        height="40"
        rx="3"
        className="fill-foreground/85 stroke-foreground"
      />
      <path
        d="M26 30l6 5-6 5M36 41h10"
        className="stroke-background"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <rect x="58" y="10" width="46" height="40" rx="3" className="fill-background stroke-border" />
      <rect x="64" y="17" width="20" height="6" rx="1.5" className="fill-primary/40" />
      <path d="M64 31h32M64 38h24" className="stroke-foreground/35" strokeLinecap="round" />
    </svg>
  ),
  slides: (
    <svg viewBox="0 0 120 72" aria-hidden className="h-full w-full" strokeWidth={1.25}>
      <rect x="22" y="14" width="76" height="44" rx="3" className="fill-background stroke-border" />
      <rect x="30" y="24" width="34" height="6" rx="1.5" className="fill-primary/40" />
      <path d="M30 38h44M30 45h30" className="stroke-foreground/35" strokeLinecap="round" />
    </svg>
  ),
  "design-system": (
    <svg viewBox="0 0 120 72" aria-hidden className="h-full w-full" strokeWidth={1.25}>
      <rect x="22" y="14" width="76" height="44" rx="3" className="fill-background stroke-border" />
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x={30 + index * 15}
          y="24"
          width="11"
          height="11"
          rx="2"
          className={
            index === 0 ? "fill-primary" : index === 1 ? "fill-primary/50" : "fill-foreground/15"
          }
        />
      ))}
      <path d="M30 46h40" className="stroke-foreground/35" strokeLinecap="round" />
    </svg>
  ),
};

/** "Make something new": one entry per kind that works in this build. */
export function CreationRow({
  kinds,
  disabledReason,
  onCreate,
}: {
  kinds: readonly CreationKind[];
  /** Why a kind can't be made in this window, or null when it can. */
  disabledReason: (kind: CreationKind) => string | null;
  onCreate: (kind: CreationKind) => void;
}) {
  return (
    <section aria-labelledby="design-make-new" className="flex flex-col gap-2.5">
      <h2 id="design-make-new" className="text-muted-foreground text-sm">
        Make something new
      </h2>
      <ul className="flex flex-wrap gap-3">
        {kinds.map((kind) => {
          const reason = disabledReason(kind);
          return (
            <li key={kind}>
              <button
                type="button"
                disabled={reason !== null}
                data-testid="design-create"
                data-kind={kind}
                onClick={() => onCreate(kind)}
                className="group flex w-40 flex-col gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)"
              >
                <span className="block h-22 w-full rounded-lg bg-muted/70 p-2 ring-1 ring-border/70 transition-colors group-hover:bg-accent group-disabled:group-hover:bg-muted/70">
                  {ART[kind]}
                </span>
                <span className="flex flex-col px-0.5">
                  <span className="font-medium text-sm">{CREATION_LABELS[kind]}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {reason ?? CREATION_DESCRIPTIONS[kind]}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
