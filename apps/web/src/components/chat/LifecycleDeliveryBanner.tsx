import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";
import {
  currentLifecycleRequest,
  lifecycleDeliveryStatus,
} from "@specweave-studio/shared/threadLifecycleEvidence";
import { CircleAlertIcon, CircleCheckIcon, HourglassIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Recorded delivery evidence for the open thread: who still owes what, or why it
 * cannot resolve yet. Nothing on a resolved thread: its own banner carries the verified scope.
 */
export function lifecycleDeliveryBannerItem(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages"> | null,
  options: { readonly settled: boolean; readonly nowMs: number },
): ComposerBannerStackItem | null {
  // A resolved thread's own banner already says how it resolved; evidence that
  // expires afterwards must not contradict it.
  if (projection === null || options.settled) return null;
  const receipt = projection.thread.lifecycleReceipt;
  // The view's clock is floored to the minute: evidence recorded later in that
  // minute is current, not from the future.
  const recordedMs = receipt == null ? Number.NaN : Date.parse(receipt.recordedAt);
  const nowMs =
    Number.isFinite(recordedMs) && recordedMs > options.nowMs && recordedMs < options.nowMs + 60_000
      ? recordedMs
      : options.nowMs;
  const status = lifecycleDeliveryStatus(receipt, currentLifecycleRequest(projection), nowMs);
  if (status === null) return null;
  return {
    id: `thread-delivery:${projection.thread.id}`,
    variant:
      status.tone === "verified" ? "success" : status.tone === "waiting" ? "info" : "warning",
    priority: "notice",
    icon:
      status.tone === "verified" ? (
        <CircleCheckIcon />
      ) : status.tone === "waiting" ? (
        <HourglassIcon />
      ) : (
        <CircleAlertIcon />
      ),
    title: status.title,
    // One line like every notice: it truncates, and the info button shows it whole.
    description: status.lines.join(" · "),
  };
}
