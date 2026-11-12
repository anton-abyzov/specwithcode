"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { currentPlatform, defaultButtonPlacement } from "~/lib/platformConventions";
import { cn } from "~/lib/utils";
import { usePagePopup } from "./pagePopups";
import { DialogCloseButton } from "~/components/ui/dialog-close-button";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MEDIA_BACKDROP_CLASS,
  DIALOG_MEDIA_POPUP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
} from "~/components/ui/dialog-styles";
import { ScrollArea } from "~/components/ui/scroll-area";

function Dialog<Payload>(props: DialogPrimitive.Root.Props<Payload>) {
  return <DialogPrimitive.Root {...usePagePopup(props)} />;
}

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Backdrop.Props & { variant?: "default" | "media" }) {
  return (
    <DialogPrimitive.Backdrop
      forceRender
      className={cn(
        variant === "media" ? DIALOG_MEDIA_BACKDROP_CLASS : DIALOG_BACKDROP_CLASS,
        className,
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

function DialogViewport({ className, ...props }: DialogPrimitive.Viewport.Props) {
  return (
    <DialogPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4",
        className,
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  variant = "default",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  variant?: "default" | "media";
}) {
  return (
    <DialogPortal>
      {/* Media opens from inside other overlays (a composer chip, a popover), so it sits above them. */}
      <DialogBackdrop className={variant === "media" ? "z-[60]" : undefined} variant={variant} />
      <DialogViewport
        className={cn(
          bottomStickOnMobile && "max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12",
          variant === "media" &&
            "z-[60] grid-rows-1 place-items-center px-4 py-6 [-webkit-app-region:no-drag]",
        )}
      >
        <DialogPrimitive.Popup
          className={cn(
            variant === "media" ? DIALOG_MEDIA_POPUP_CLASS : DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            variant === "default" && "max-h-full max-w-lg",
            bottomStickOnMobile && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton && <DialogCloseButton />}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

/**
 * The app's viewer overlay: a card over nearly the whole window, above a
 * backdrop that dims everything behind it. Use with `modal={false}`.
 */
function DialogOverlayPopup({
  className,
  children,
  onBackdropClick,
  ...props
}: DialogPrimitive.Popup.Props & {
  onBackdropClick: () => void;
}) {
  return (
    <DialogPortal>
      <DialogPrimitive.Backdrop
        forceRender
        className="viewer-overlay-backdrop"
        onClick={onBackdropClick}
      />
      <DialogPrimitive.Popup
        className={cn("viewer-overlay fixed z-50 text-popover-foreground", className)}
        data-slot="dialog-popup"
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

/**
 * Write the buttons in one order everywhere: the default action last. The
 * footer draws them the way the system does (default first on Windows) without
 * changing the source order, so focus opens on the same button on every system.
 * A child pushed to the start with `mr-auto` or `me-auto` stays at the start.
 * `buttonOrder="source"` is for a footer that is not a plain row of buttons, and
 * for one that holds Back: Back comes before the default on every system.
 */
function DialogFooter({
  className,
  variant = "default",
  buttonOrder = "platform",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "bare";
  buttonOrder?: "platform" | "source";
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        className,
      )}
      data-slot="dialog-footer"
      data-default-button={
        buttonOrder === "platform" ? defaultButtonPlacement(currentPlatform()) : undefined
      }
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "wrap-anywhere font-semibold text-xl leading-none in-[[data-slot=dialog-popup]:has(>[data-slot=dialog-close])]:pe-8",
        className,
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({
  className,
  scrollFade = true,
  ...props
}: React.ComponentProps<"div"> & { scrollFade?: boolean }) {
  return (
    <ScrollArea scrollFade={scrollFade}>
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogOverlayPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
