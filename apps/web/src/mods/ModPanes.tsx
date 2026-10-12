import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";
import { type ModPane, useModsStore } from "./modsStore";
import type { ModNode, ModTone } from "./protocol";

const TONE_CLASS: Record<ModTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  strong: "font-semibold text-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive-foreground",
};

const GAP_CLASS = ["gap-0", "gap-1", "gap-2", "gap-3", "gap-4", "gap-5", "gap-6"] as const;

/** Draws a checked mod tree with workbench components; text stays text. */
export function ModTree({
  node,
  onPress,
}: {
  node: ModNode;
  onPress: (handler: number) => void;
}): ReactNode {
  if (typeof node === "string") return node;
  const children = node.children.map((child, index) => (
    // Mod trees carry no keys; order is the identity within one draw.
    // oxlint-disable-next-line react/no-array-index-key
    <ModTree key={index} node={child} onPress={onPress} />
  ));
  switch (node.type) {
    case "Box":
      return (
        <div
          className={cn(
            "flex min-w-0",
            node.direction === "row" ? "flex-row flex-wrap items-center" : "flex-col",
            GAP_CLASS[node.gap],
          )}
        >
          {children}
        </div>
      );
    case "Text":
      return (
        <span
          className={cn(
            "min-w-0 break-words text-sm",
            TONE_CLASS[node.tone],
            node.mono && "font-mono",
          )}
        >
          {children}
        </span>
      );
    case "Button": {
      const handler = node.handler;
      return (
        <Button
          size="compact"
          variant={node.variant}
          disabled={node.disabled || handler === null}
          onClick={() => {
            if (handler !== null) onPress(handler);
          }}
        >
          {children}
        </Button>
      );
    }
  }
}

function ModPaneDialog({ pane }: { pane: ModPane }) {
  const channel = useModsStore((state) => state.channels[pane.mod]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) channel?.closePane(pane.id);
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{pane.title}</DialogTitle>
          <DialogDescription>From the {pane.mod} mod</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {pane.tree === null ? (
            <span className="text-sm text-muted-foreground">Nothing to show yet.</span>
          ) : (
            <ModTree node={pane.tree} onPress={(handler) => channel?.press(pane.id, handler)} />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The most recently opened pane is shown; closing it reveals the one below. */
export function ModPanes() {
  const pane = useModsStore((state) => state.panes.at(-1));
  return pane ? <ModPaneDialog key={`${pane.mod}:${pane.id}`} pane={pane} /> : null;
}

/** Short status text from running mods, for the sidebar footer. */
export function ModStatusItems() {
  const status = useModsStore((state) => state.status);
  const entries = Object.entries(status);
  if (entries.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1 px-2 pb-1" aria-label="Mod status">
      {entries.map(([mod, text]) => (
        <span
          key={mod}
          title={`${mod} mod`}
          className="max-w-full truncate rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {text}
        </span>
      ))}
    </div>
  );
}
