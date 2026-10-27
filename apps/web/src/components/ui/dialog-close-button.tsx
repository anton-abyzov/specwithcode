"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

/**
 * The one close control for dialogs, sheets and app sheets: a ghost X in the
 * top corner, never a text "Close" in the footer. `corner` pins it to the
 * popup's top end, centred on a DialogHeader title; `inline` sits in a header
 * row the caller lays out.
 */
function DialogCloseButton({
  className,
  placement = "corner",
  ...props
}: DialogPrimitive.Close.Props & { placement?: "corner" | "inline" }) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      aria-label="Close"
      title="Close (Esc)"
      className={cn(
        "shrink-0",
        placement === "corner" && "absolute end-4 top-4 z-10 sm:top-4.5",
        className,
      )}
      render={<Button size="icon" variant="ghost" />}
      {...props}
    >
      <XIcon />
    </DialogPrimitive.Close>
  );
}

export { DialogCloseButton };
