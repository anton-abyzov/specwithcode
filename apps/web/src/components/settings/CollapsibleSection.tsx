import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";

import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { SettingsGroup } from "./SettingsGroup";

const SECTION_OPEN_STORAGE_PREFIX = "specwithcode:settings-section-open:";

function readSectionOpen(id: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(SECTION_OPEN_STORAGE_PREFIX + id);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

/**
 * A settings section that rests closed behind its heading. Its rows stay
 * mounted, so a search can still reveal and focus one; whether it is open is
 * remembered on this device.
 */
export function CollapsibleSection({
  id,
  title,
  count,
  defaultOpen = false,
  children,
  className,
  ref,
}: {
  readonly id: string;
  readonly title: string;
  /** How many settings sit inside, shown beside the closed heading. */
  readonly count?: number | undefined;
  readonly defaultOpen?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly ref?: Ref<HTMLDetailsElement> | undefined;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(() => readSectionOpen(id, defaultOpen));
  return (
    <details
      id={id}
      ref={ref}
      tabIndex={-1}
      open={open}
      data-slot="settings-collapsible-section"
      className={cn("group/section space-y-2.5", className)}
      // A search that reveals a row opens the section for now; only a person's
      // own click on the heading is remembered.
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        onClick={() => {
          try {
            window.localStorage.setItem(SECTION_OPEN_STORAGE_PREFIX + id, open ? "0" : "1");
          } catch {
            // Private windows refuse storage; the section still opens and closes.
          }
        }}
        data-settings-scroll-target
        className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:px-4 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-icon-muted transition-transform group-open/section:rotate-90"
        />
        <h2 className="text-sm font-semibold">{tx(title)}</h2>
        {count !== undefined ? (
          <span className="text-xs font-normal text-muted-foreground tabular-nums group-open/section:hidden">
            {count}
          </span>
        ) : null}
      </summary>
      <SettingsGroup>{children}</SettingsGroup>
    </details>
  );
}
