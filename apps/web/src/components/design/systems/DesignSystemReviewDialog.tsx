import type { DesignSystemConfirmInput, DesignSystemProposal } from "@specweave-studio/contracts";

import { useRef } from "react";

import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../../ui/dialog";
import { DesignSystemReview } from "./DesignSystemReview";

/** The review in a large dialog; the caller owns loading, confirm and discard. */
export function DesignSystemReviewDialog({
  proposal,
  loadError,
  ownerLabel,
  threadTitle,
  busy,
  error,
  onConfirm,
  onDiscard,
  onClose,
}: {
  proposal: DesignSystemProposal | null;
  loadError: string | null;
  ownerLabel: string;
  threadTitle: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: (input: DesignSystemConfirmInput) => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  // Focus the review itself, not its first control, so nothing looks pre-selected.
  const body = useRef<HTMLDivElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup
        className="flex h-[min(52rem,calc(100dvh-4rem))] flex-col overflow-hidden sm:max-w-4xl"
        data-testid="design-system-review-dialog"
        initialFocus={body}
      >
        <div className="border-b border-border/60">
          <DialogHeader>
            <DialogTitle>Review design system</DialogTitle>
            <DialogDescription>
              Untick anything you do not want. Only ticked items are saved when you confirm.
            </DialogDescription>
          </DialogHeader>
        </div>
        <div ref={body} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {proposal !== null ? (
            <DesignSystemReview
              // A different proposal starts a fresh review.
              key={proposal.id}
              className="min-h-0 flex-1"
              proposal={proposal}
              ownerLabel={ownerLabel}
              threadTitle={threadTitle}
              busy={busy}
              error={error}
              onConfirm={onConfirm}
              onDiscard={onDiscard}
            />
          ) : (
            <p
              role={loadError ? "alert" : undefined}
              className={
                loadError
                  ? "p-6 text-sm text-destructive-foreground"
                  : "p-6 text-sm text-muted-foreground"
              }
            >
              {loadError ?? "Loading the proposal…"}
            </p>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
