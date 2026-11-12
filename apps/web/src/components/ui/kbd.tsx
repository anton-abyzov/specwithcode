import type * as React from "react";

import { currentPlatform, keyLabel, shortcutLabel, type KeyName } from "~/lib/platformConventions";
import { cn } from "~/lib/utils";

/** One of the three, never two: a named key, a shortcut, or the caller's own content. */
type KbdContent =
  | {
      /** A named key: "enter" is ↵ on macOS and Enter elsewhere. */
      keyName: KeyName;
      shortcut?: never;
      children?: never;
    }
  | {
      /** A letter pressed with the main modifier: "k" is ⌘K on macOS and Ctrl+K elsewhere. */
      shortcut: string;
      keyName?: never;
      children?: never;
    }
  | { keyName?: never; shortcut?: never; children?: React.ReactNode };

/**
 * A key hint. `keyName` and `shortcut` print the key the way the system's own
 * menus do (a symbol on macOS, a word elsewhere); children are for everything else.
 */
function Kbd({
  className,
  keyName,
  shortcut,
  children,
  ...props
}: Omit<React.ComponentProps<"kbd">, "children"> & KbdContent) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    >
      {keyName !== undefined
        ? keyLabel(keyName, currentPlatform())
        : shortcut !== undefined
          ? shortcutLabel(shortcut, currentPlatform())
          : children}
    </kbd>
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
