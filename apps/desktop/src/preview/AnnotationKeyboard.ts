import type { PreviewAnnotationSubmission } from "@specweave-studio/contracts";

interface AnnotationKeyboardEvent {
  /** False for events a page script dispatched; only the person's keys submit. */
  readonly isTrusted: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

export function resolveAnnotationSubmission(
  event: AnnotationKeyboardEvent,
  canSend: boolean,
): PreviewAnnotationSubmission | null {
  if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return event.metaKey || event.ctrlKey ? (canSend ? "send" : null) : "attach";
}
