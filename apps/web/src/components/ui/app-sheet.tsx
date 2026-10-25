import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";

/**
 * A centered sheet over the whole dimmed app, sidebar included, like the native
 * settings windows: an optional section nav on the left, the page on the right,
 * a close button in the corner. Escape, the close button and a click on the
 * dimmed area close it. Settings and the Usage sheet share it.
 */
export function AppSheet({
  title,
  closeLabel,
  slot,
  popupProps,
  focusSheetFirst = false,
  headerWraps = false,
  nav,
  header,
  children,
  onClose,
}: {
  /** The dialog's accessible name; also the phone header. */
  title: string;
  closeLabel: string;
  /** Prefix for the backdrop, viewport and nav `data-slot` names. */
  slot: string;
  popupProps?: Readonly<Record<`data-${string}`, string>>;
  /** Focus the sheet itself on open, not its first control; Tab reaches the controls. */
  focusSheetFirst?: boolean;
  /** Let a toolbar that wraps at narrow widths grow the header past one row. */
  headerWraps?: boolean;
  nav?: ReactNode;
  header: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const pressStartedOnBackdrop = useRef(false);
  const pendingEscape = useRef<Event | null>(null);
  const popup = useRef<HTMLDivElement>(null);

  return (
    <DialogPrimitive.Root
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (open) return;
        const event = details.event;
        if (details.reason === "escape-key" && event) {
          // Base UI handles Escape before controls that consume it on the document
          // (the theme variant picker). Let the event through unmarked and close
          // only if nothing else handled it.
          details.cancel();
          details.allowPropagation();
          if (pendingEscape.current === event) return;
          pendingEscape.current = event;
          setTimeout(() => {
            if (!event.defaultPrevented) onClose();
          }, 0);
          return;
        }
        onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* Base UI drops the backdrop when it sees a parent dialog; always dim. */}
        <DialogPrimitive.Backdrop
          forceRender
          className="fixed inset-0 z-50 bg-black/35 backdrop-blur-xs transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/55 [-webkit-app-region:no-drag]"
          data-slot={`${slot}-backdrop`}
        />
        <DialogPrimitive.Viewport
          className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6 lg:p-10 [-webkit-app-region:no-drag]"
          data-slot={`${slot}-viewport`}
          onPointerDown={(event) => {
            pressStartedOnBackdrop.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (pressStartedOnBackdrop.current && event.target === event.currentTarget) onClose();
            pressStartedOnBackdrop.current = false;
          }}
        >
          {/* aria-modal and data-app-sheet tell the window key listeners of the page
              underneath (chat, launcher, peek) that this sheet owns the keyboard. */}
          <DialogPrimitive.Popup
            {...popupProps}
            aria-modal="true"
            data-app-sheet=""
            ref={popup}
            initialFocus={focusSheetFirst ? popup : undefined}
            finalFocus={false}
            className="dialog-glass relative flex h-full max-h-[880px] w-full max-w-[1180px] min-h-0 min-w-0 flex-col overflow-hidden border bg-background text-foreground shadow-2xl outline-none transition-[scale,opacity] duration-200 ease-out data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 sm:rounded-2xl md:flex-row [-webkit-app-region:no-drag]"
          >
            {/* On phones the nav stacks above the page, so the close button leads. */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b ps-4 pe-2 md:hidden">
              <span aria-hidden className="text-sm font-medium">
                {title}
              </span>
              <DialogPrimitive.Close
                aria-label={closeLabel}
                title="Close (Esc)"
                render={<Button size="icon" variant="ghost" />}
              >
                <XIcon />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            {nav ? (
              <div
                className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b bg-sidebar text-sidebar-foreground md:max-h-none md:w-64 md:border-e md:border-b-0"
                data-slot={`${slot}-nav`}
              >
                {nav}
              </div>
            ) : null}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div
                className={cn(
                  "flex shrink-0 items-center gap-3 border-b ps-6 pe-3",
                  headerWraps ? "min-h-14" : "h-14",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">{header}</div>
                <DialogPrimitive.Close
                  aria-label={closeLabel}
                  title="Close (Esc)"
                  className="max-md:hidden"
                  render={<Button size="icon" variant="ghost" />}
                >
                  <XIcon />
                </DialogPrimitive.Close>
              </div>
              {children}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
