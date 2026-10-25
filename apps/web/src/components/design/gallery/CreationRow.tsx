import {
  CodeXmlIcon,
  PaletteIcon,
  PlusIcon,
  PresentationIcon,
  SwatchBookIcon,
  UploadIcon,
} from "lucide-react";
import { useRef, type ReactElement, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { PPTX_ACCEPT } from "./deckImport";
import { CREATION_DESCRIPTIONS, CREATION_LABELS, type CreationKind } from "./galleryModel";

function Tip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

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

const COMPACT_ICONS: Record<CreationKind, ReactNode> = {
  design: <PaletteIcon aria-hidden />,
  "design-from-code": <CodeXmlIcon aria-hidden />,
  slides: <PresentationIcon aria-hidden />,
  "design-system": <SwatchBookIcon aria-hidden />,
};

/**
 * "Make something new": one entry per kind that works in this build. An
 * empty scope shows the illustrated tiles; once the scope has designs it
 * folds to one row of buttons so the designs stay near the top.
 */
export function CreationRow({
  kinds,
  disabledReason,
  onCreate,
  compact = false,
  designLabel,
  designDescription,
  onImportSlides = null,
}: {
  kinds: readonly CreationKind[];
  /** Why a kind can't be made in this window, or null when it can. */
  disabledReason: (kind: CreationKind) => string | null;
  onCreate: (kind: CreationKind) => void;
  compact?: boolean;
  /** The Design entry's name when the gallery is scoped, "New design in EasyChamp". */
  designLabel?: string;
  /** The Design entry's description when the gallery is scoped to one project. */
  designDescription?: string;
  /** "Import PowerPoint…" next to Slides, with the picked .pptx; absent when the server cannot import. */
  onImportSlides?: ((file: File) => void) | null;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const importReason = kinds.includes("slides") ? disabledReason("slides") : null;
  const importEntry =
    onImportSlides === null || !kinds.includes("slides") ? null : (
      <>
        <input
          ref={fileInput}
          type="file"
          accept={PPTX_ACCEPT}
          hidden
          data-testid="design-import-pptx-input"
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            event.target.value = "";
            if (picked !== null) onImportSlides(picked);
          }}
        />
        <button
          type="button"
          disabled={importReason !== null}
          data-testid="design-import-pptx"
          onClick={() => fileInput.current?.click()}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium outline-none transition-colors duration-[120ms] ease-out-quint focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) motion-reduce:transition-none [&_svg]:size-3.5",
            compact
              ? "h-8 border border-border/80 px-2.5 text-foreground/80 hover:border-foreground/20 hover:bg-accent hover:text-foreground"
              : "self-start px-0.5 text-muted-foreground hover:text-foreground",
          )}
        >
          <UploadIcon aria-hidden />
          Import PowerPoint…
          {importReason ? <span className="sr-only">: {importReason}</span> : null}
        </button>
      </>
    );
  const label = (kind: CreationKind) =>
    kind === "design" && designLabel !== undefined ? designLabel : CREATION_LABELS[kind];
  const description = (kind: CreationKind) =>
    kind === "design" && designDescription !== undefined
      ? designDescription
      : CREATION_DESCRIPTIONS[kind];
  if (compact) {
    // The plain design comes first; it is the one people reach for.
    const ordered = [
      ...kinds.filter((kind) => kind === "design"),
      ...kinds.filter((kind) => kind !== "design"),
    ];
    return (
      <section aria-label="Make something new" className="flex flex-wrap items-center gap-1.5">
        {ordered.map((kind) => {
          const reason = disabledReason(kind);
          const primary = kind === "design";
          const button = (
            <button
              type="button"
              disabled={reason !== null}
              data-testid="design-create"
              data-kind={kind}
              onClick={() => onCreate(kind)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-[background-color,border-color,color] duration-[120ms] ease-out-quint focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) motion-reduce:transition-none [&_svg]:size-3.5",
                primary
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border/80 text-foreground/80 hover:border-foreground/20 hover:bg-accent hover:text-foreground",
              )}
            >
              {primary ? <PlusIcon aria-hidden /> : COMPACT_ICONS[kind]}
              {label(kind)}
              {reason ? <span className="sr-only">: {reason}</span> : null}
            </button>
          );
          const tip = (
            <Tip key={kind} label={reason ?? description(kind)}>
              {button}
            </Tip>
          );
          return kind === "slides" && importEntry !== null ? (
            <span key={kind} className="contents">
              {tip}
              {importEntry}
            </span>
          ) : (
            tip
          );
        })}
      </section>
    );
  }
  return (
    <section aria-labelledby="design-make-new" className="flex flex-col gap-2.5">
      <h2 id="design-make-new" className="text-sm text-muted-foreground">
        Make something new
      </h2>
      <ul className="flex flex-wrap gap-3">
        {kinds.map((kind) => {
          const reason = disabledReason(kind);
          return (
            <li key={kind} className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={reason !== null}
                data-testid="design-create"
                data-kind={kind}
                onClick={() => onCreate(kind)}
                className="group flex w-40 flex-col gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)"
              >
                <span className="block h-22 w-full rounded-lg bg-muted/70 p-2 ring-1 ring-border/70 transition-colors duration-150 ease-out-quint group-hover:bg-accent group-disabled:group-hover:bg-muted/70">
                  {ART[kind]}
                </span>
                <span className="flex flex-col px-0.5">
                  <span className="text-sm font-medium">{label(kind)}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {reason ?? description(kind)}
                  </span>
                </span>
              </button>
              {kind === "slides" ? importEntry : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
