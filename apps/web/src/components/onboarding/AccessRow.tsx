import { CheckIcon } from "lucide-react";
import type { ReactNode, SVGProps } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * One row of first-run's Access list: a glyph, a heading, the row's live state
 * in one line, its own labelled actions, and an optional body that opens below.
 * Presentational only: each row's container reads its state and passes it in,
 * so a fixture can draw every state. The list keeps one row open at a time.
 */
export function AccessRow({
  id,
  glyph,
  title,
  badge,
  state,
  done = false,
  actions,
  open = false,
  children,
}: {
  /** `data-access-row`, and the base of the body's id. */
  readonly id: string;
  readonly glyph: ReactNode;
  readonly title: string;
  /** Drawn after the heading, such as a version note. */
  readonly badge?: ReactNode;
  /** The live state line under the heading. */
  readonly state?: ReactNode;
  /** The row's thing is allowed or set up: the glyph takes the accent. */
  readonly done?: boolean;
  readonly actions?: ReactNode;
  readonly open?: boolean;
  /** The body, shown while `open`. */
  readonly children?: ReactNode;
}) {
  const bodyId = accessRowBodyId(id);
  return (
    <li
      data-access-row={id}
      data-done={done ? "" : undefined}
      data-open={open ? "" : undefined}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 first:border-t-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <span
        aria-hidden
        data-slot="access-row-glyph"
        data-motion="setup"
        className={cn(
          "grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground",
          done && "text-primary",
        )}
      >
        {glyph}
      </span>
      <div className="min-w-0">
        <h2 className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-foreground">
          {title}
          {badge}
        </h2>
        {state ? (
          <div
            data-slot="access-row-state"
            className="text-compact leading-snug text-muted-foreground"
          >
            {state}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div
          data-slot="access-row-actions"
          className="col-span-2 flex flex-wrap items-center gap-1.5 ps-12 sm:col-span-1 sm:justify-end sm:ps-0"
        >
          {actions}
        </div>
      ) : null}
      <div
        id={bodyId}
        data-slot="access-row-body"
        data-motion="setup"
        hidden={!open}
        className="col-span-full min-w-0"
      >
        {open ? (
          // Opens by its own height (setupMotion.css): the clip has no padding, so the track can start at 0.
          <div data-slot="access-row-body-clip">
            <div className="mt-0.5 rounded-lg bg-muted px-3 py-2.5 text-compact leading-relaxed text-foreground">
              {children}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function accessRowBodyId(id: string) {
  return `access-row-${id}-body`;
}

/** The list the rows sit in. */
export function AccessRowList({ children }: { readonly children: ReactNode }) {
  return (
    <ul
      data-slot="access-rows"
      className="mt-4 min-w-0 rounded-xl border border-border bg-background"
    >
      {children}
    </ul>
  );
}

/** A row's own action: an outline button, never filled, so Continue stays the only filled one. */
export function AccessRowAction({
  children,
  onClick,
  disabled,
  expands,
  ...rest
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** The id of the row whose body this opens, with whether it is open. */
  readonly expands?: { readonly row: string; readonly open: boolean };
} & Omit<React.ComponentProps<typeof Button>, "onClick" | "children" | "variant" | "size">) {
  return (
    <Button
      {...rest}
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expands ? expands.open : undefined}
      aria-controls={expands ? accessRowBodyId(expands.row) : undefined}
    >
      {children}
    </Button>
  );
}

/** "Full access", "Allowed", "Paired: Work": what a row settled, with a check when it is on. */
export function AccessRowChip({
  children,
  on = false,
}: {
  readonly children: ReactNode;
  readonly on?: boolean;
}) {
  return (
    <span
      data-slot="access-row-chip"
      data-on={on ? "" : undefined}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        on ? "border-current text-success-foreground" : "border-border text-muted-foreground",
      )}
    >
      {on ? <CheckIcon aria-hidden className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "ref">;

function Glyph({ children, ...props }: GlyphProps & { readonly children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** Files and commands: a terminal window. */
export function TerminalRowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M7.5 10l3 2.5-3 2.5M13 15h3.5" />
    </Glyph>
  );
}

/** Your browser: a browser window. */
export function BrowserRowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M3 9h18M6.3 6.8h.01M9 6.8h.01" />
    </Glyph>
  );
}

/** Mac apps: a screen with a pointer on it. */
export function MacAppsRowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="12.5" rx="2.5" />
      <path d="M9 20h6M12.2 9.2l4.6 2-2 .8-.8 2z" />
    </Glyph>
  );
}

/** Your iPhone. */
export function PhoneRowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="7.5" y="3" width="9" height="18" rx="2.5" />
      <path d="M11 18.2h2" />
    </Glyph>
  );
}

/** Full Disk Access: a folder. */
export function FolderRowGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Glyph>
  );
}
