import { useState } from "react";

/**
 * The thread's last visit as it stood when this thread was opened. Opening a
 * thread records a new visit at once, so the live value would erase the
 * divider before the person sees it; the first known value per thread is kept.
 */
export function useUnreadSince(
  threadKey: string | null,
  lastVisitedAt: string | null | undefined,
  known: boolean,
): string | null {
  const [mark, setMark] = useState<{ key: string | null; since: string | null | undefined }>(
    () => ({ key: threadKey, since: known ? (lastVisitedAt ?? null) : undefined }),
  );
  if (mark.key !== threadKey || (mark.since === undefined && known)) {
    const since = known ? (lastVisitedAt ?? null) : undefined;
    setMark({ key: threadKey, since });
    return since ?? null;
  }
  return mark.since ?? null;
}

/** A thin rule marking where the messages the person has not read begin. */
export function NewMessagesDivider() {
  return (
    <div
      className="flex items-center gap-3 pb-3 text-xs font-medium text-info-foreground select-none"
      role="separator"
      aria-label="New messages"
      data-new-messages-divider=""
    >
      <span aria-hidden className="h-px flex-1 bg-info-foreground/35" />
      <span aria-hidden>New</span>
      <span aria-hidden className="h-px flex-1 bg-info-foreground/35" />
    </div>
  );
}
