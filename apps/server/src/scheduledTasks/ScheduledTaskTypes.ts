import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { ScheduledTaskWebhookDeliveryId } from "@specweave-studio/contracts";
import type { WebhookRequest } from "./webhookTemplate.ts";

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  /** Set by Studio Connect; the same id is never dispatched twice. */
  readonly relayDeliveryId?: string;
  /** When the relay received a held request; defaults to now. */
  readonly receivedAt?: string;
}

/** What the HTTP route should answer. `not_found` covers unknown hooks and wrong tokens alike. */
/**
 * What happened to one webhook request, as recorded in metrics and spans.
 * Sent back to the relay as `x-studio-hook-outcome`; never request contents.
 */
export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      /** A 202 covers more than a started run; this says which. */
      readonly outcome: "accepted" | "duplicate" | "prompt_too_long";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      /** Too many requests to this hook, or too many runs already waiting. */
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

/**
 * Where a webhook task's public URL points: `${relayHookBaseUrl}/${taskId}/${token}`.
 * Null when the environment has no managed tunnel on Studio Connect; clients then show the path.
 */
interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "studio/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

/** A queued webhook delivery that no longer applies to its task; `reason` is shown in the delivery log. */
export class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

export interface RateWindow {
  readonly accepted: ReadonlyArray<number>;
  /** Whether a rejection was already logged in this window. */
  readonly rejectedLogged: boolean;
}
