import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { ArrowDownIcon } from "lucide-react";
import type { PointerEvent } from "react";
import { Button } from "../ui/button";

/**
 * The way back to the newest message, shown whenever a conversation is read
 * further up. The coordinator conversation and every thread use this one
 * control, so it reads and behaves the same in both.
 */
export function JumpToLatestButton({
  unseen = false,
  onJump,
  onPointerDown,
}: {
  /** Something arrived below since the reader left the end. */
  unseen?: boolean;
  onJump: () => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  const tx = useTx();
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      className="pointer-events-auto rounded-full shadow-lg before:rounded-full"
      aria-label={unseen ? tx("Jump to latest, new messages below") : tx("Jump to latest")}
      data-jump-to-latest=""
      data-unseen={unseen ? "" : undefined}
      onPointerDown={onPointerDown}
      onClick={onJump}
    >
      <ArrowDownIcon aria-hidden />
      {renderRich(tx("Jump to latest{value}"), {
        value: unseen ? (
          <span
            className="ms-0.5 rounded-full bg-background px-1.5 text-2xs font-semibold leading-4 text-foreground"
            aria-hidden
          >
            {tx("New")}
          </span>
        ) : null,
      })}
    </Button>
  );
}
