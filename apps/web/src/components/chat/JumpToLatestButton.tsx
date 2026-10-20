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
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      className="pointer-events-auto rounded-full shadow-lg before:rounded-full"
      aria-label={unseen ? "Jump to latest, new messages below" : "Jump to latest"}
      data-jump-to-latest=""
      data-unseen={unseen ? "" : undefined}
      onPointerDown={onPointerDown}
      onClick={onJump}
    >
      <ArrowDownIcon aria-hidden />
      Jump to latest
      {unseen ? (
        <span
          className="ms-0.5 rounded-full bg-background px-1.5 text-[11px] font-semibold leading-4 text-foreground"
          aria-hidden
        >
          New
        </span>
      ) : null}
    </Button>
  );
}
