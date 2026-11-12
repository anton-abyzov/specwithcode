import { type ReactNode, useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { scrollToSettingsTarget, useSettingsSearchTargetId } from "./settingsLayout";

/**
 * "Another account, or no Connect" in Settings > Machines: the join line and
 * code paths, folded because machines on one SpecWithCode Connect account no
 * longer need them. Everything inside stays mounted, so a settings-search jump
 * still finds it; an entry point that needs what is inside opens the fold.
 */
export function OtherAccountJoinFold({
  openFor,
  targetIds,
  children,
}: {
  /** Something inside is in use (a typed line, a running add, an open dialog), or this build has no other path. */
  openFor: boolean;
  /** Ids inside the fold that settings search can jump to. */
  targetIds: ReadonlyArray<string>;
  children: ReactNode;
}) {
  const tx = useTx();
  const searchTargetId = useSettingsSearchTargetId();
  const jumpTarget =
    searchTargetId !== null && targetIds.includes(searchTargetId) ? searchTargetId : null;
  const needed = openFor || jumpTarget !== null;
  const [open, setOpen] = useState(needed);
  // Opens when it starts being needed, once: after that the owner may fold it again.
  const [wasNeeded, setWasNeeded] = useState(needed);
  if (needed !== wasNeeded) {
    setWasNeeded(needed);
    if (needed) setOpen(true);
  }
  // A search jump lands on the row itself, not only on an opened section somewhere below.
  useEffect(() => {
    if (jumpTarget) scrollToSettingsTarget(jumpTarget);
  }, [jumpTarget]);
  return (
    <details
      id="private-machines-other-account"
      className="border-t border-border/60"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-ring sm:px-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm">{tx("Another account, or no Connect")}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {tx(
              "A friend's machine, or one that cannot reach SpecWithCode Connect, joins with a code or a join line.",
            )}
          </span>
        </span>
        <span className="shrink-0 rounded-md border border-input bg-background px-2 py-1 text-xs font-medium">
          {open ? tx("Hide") : tx("Show")}
        </span>
      </summary>
      {children}
    </details>
  );
}
