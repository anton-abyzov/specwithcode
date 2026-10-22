import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** 24-hour "HH:MM" wall-clock time. Mirrors `parseTimeOfDay` on the server. */
const TimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
).annotate({ description: "Local wall-clock time in 24-hour HH:MM form, such as 09:30." });

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;

const ScheduledTaskIntervalMs = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Positive interval in milliseconds.",
});

const ScheduledTaskIntervalSchedule = Schema.Struct({
  type: Schema.Literal("interval").annotate({
    description: "Select interval scheduling.",
  }),
  everyMs: ScheduledTaskIntervalMs,
}).annotate({
  description: "Run repeatedly after a fixed number of milliseconds.",
});

const ScheduledTaskFixedTimeSchedule = Schema.Struct({
  type: Schema.Literal("fixed_time").annotate({
    description: "Select a fixed local wall-clock time.",
  }),
  timeOfDay: TimeOfDay,
  weekdays: Schema.optional(
    Schema.Array(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
        description: "Weekday number where 0 is Sunday and 6 is Saturday.",
      }),
    ).annotate({
      description: "Optional weekdays; omit to run every day.",
    }),
  ),
}).annotate({
  description: "Run at a fixed local wall-clock time on selected weekdays.",
});

const ScheduledTaskWebhookSignatureFields = {
  header: TrimmedNonEmptyString.annotate({
    description: "Request header carrying the signature, such as x-hub-signature-256.",
  }),
  encoding: Schema.Literals(["hex", "base64"]).annotate({
    description: "How the HMAC-SHA256 digest is encoded in the header.",
  }),
  prefix: Schema.String.annotate({
    description: "Text before the digest in the header value, such as 'sha256='. Empty for none.",
  }),
};

/** HMAC-SHA256 over the raw request body. The secret is never part of the read model. */
export const ScheduledTaskWebhookSignature = Schema.Struct(
  ScheduledTaskWebhookSignatureFields,
).annotate({ description: "Optional HMAC-SHA256 signature check over the raw request body." });
export type ScheduledTaskWebhookSignature = typeof ScheduledTaskWebhookSignature.Type;

/** Matches how long the relay holds a request for an offline environment. */
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;

const WebhookMaxDeliveryAgeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_WEBHOOK_DELIVERY_AGE_MINUTES }),
).annotate({
  description:
    "Skip requests the relay held longer than this many minutes while the environment was offline. Null runs every request.",
});

const ScheduledTaskWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook").annotate({
    description: "Run when the task's webhook URL receives a request.",
  }),
  signature: Schema.NullOr(ScheduledTaskWebhookSignature),
  // Optional so rows saved before this setting existed still decode.
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
}).annotate({
  description:
    "Run on each request to the task's webhook URL. The prompt may use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}} placeholders.",
});

const ScheduledTaskUpsertWebhookSchedule = Schema.Struct({
  type: Schema.Literal("webhook").annotate({
    description: "Run when the task's webhook URL receives a request.",
  }),
  signature: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        ...ScheduledTaskWebhookSignatureFields,
        secret: Schema.optional(TrimmedNonEmptyString).annotate({
          description: "Shared signing secret. Omit to keep the stored secret.",
        }),
        secretRef: Schema.optional(SecretRef).annotate({
          description:
            "A secret the user entered through request_secret, used instead of secret. It is consumed by this save.",
        }),
      }),
    ),
  ).annotate({
    description: "Signature check; omit or null to accept requests by URL token only.",
  }),
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
}).annotate({
  description:
    "Run on each request to the task's webhook URL. The prompt may use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} and {{request}} placeholders.",
});

const ScheduledTaskManualSchedule = Schema.Struct({
  type: Schema.Literal("manual").annotate({
    description: "Run only when asked: Run now, or run_scheduled_task_now.",
  }),
}).annotate({
  description: "Never runs on its own; for reusable work the user starts when it is needed.",
});

const ScheduledTaskMonthlySchedule = Schema.Struct({
  type: Schema.Literal("monthly").annotate({
    description: "Select a monthly run.",
  }),
  dayOfMonth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 28 })).annotate({
    description: "Day of the month, 1 to 28, so every month has it.",
  }),
  timeOfDay: TimeOfDay,
}).annotate({
  description: "Run once a month on a day of the month at a local wall-clock time.",
});

const ONCE_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether `value` is an ISO 8601 date and time with an explicit offset or Z,
 * naming a real calendar day and clock time. A naive local time is refused:
 * it means a different instant on every host that reads it.
 */
export function isScheduledTaskOnceAt(value: string): boolean {
  const match = ONCE_AT_PATTERN.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  // @effect-diagnostics-next-line globalDate:off -- Pure calendar validation of a stored string, outside any Effect.
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    offsetHour! <= 23 &&
    offsetMinute! <= 59
  );
}

const ONCE_AT_DESCRIPTION =
  "ISO 8601 date and time with an offset or Z, such as 2026-10-22T09:30:00-04:00 or 2026-10-22T13:30:00Z.";

/** As stored: any date and time JavaScript can read, so older rows still list. */
const ScheduledTaskStoredOnceAt = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value)), {
    expected: "an ISO 8601 date and time",
  }),
).annotate({ description: ONCE_AT_DESCRIPTION });

/** As written: strict ISO 8601 with an offset or Z, such as 2026-10-22T09:30:00-04:00. */
const ScheduledTaskOnceAt = TrimmedNonEmptyString.check(
  Schema.makeFilter(isScheduledTaskOnceAt, {
    expected: "an ISO 8601 date and time with an offset or Z, such as 2026-10-22T13:30:00Z",
  }),
).annotate({ description: ONCE_AT_DESCRIPTION });

const onceScheduleFields = {
  type: Schema.Literal("once").annotate({
    description: "Select a single run at one date and time.",
  }),
};
const ONCE_SCHEDULE_DESCRIPTION =
  "Run once at a date and time, then turn off. A run the host missed (asleep or offline) fires as soon as it can, and one whose provider cannot start waits for it.";

const ScheduledTaskOnceSchedule = Schema.Struct({
  ...onceScheduleFields,
  at: ScheduledTaskStoredOnceAt,
}).annotate({ description: ONCE_SCHEDULE_DESCRIPTION });

const ScheduledTaskUpsertOnceSchedule = Schema.Struct({
  ...onceScheduleFields,
  at: ScheduledTaskOnceAt,
}).annotate({ description: ONCE_SCHEDULE_DESCRIPTION });

/**
 * Read model for persisted schedules. Keep accepting legacy sub-minute rows so
 * users can list, disable, edit, or delete them after the write minimum changes.
 */
export const ScheduledTaskSchedule = Schema.Union([
  ScheduledTaskIntervalSchedule,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookSchedule,
  ScheduledTaskManualSchedule,
  ScheduledTaskMonthlySchedule,
  ScheduledTaskOnceSchedule,
]).annotate({
  description:
    "Structured trigger. Pass an object with type 'interval', 'fixed_time', 'once', 'webhook', 'manual' or 'monthly'.",
});
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

/** Mutation model: newly created or updated interval schedules run at most once per minute. */
export const ScheduledTaskUpsertSchedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval").annotate({
      description: "Select interval scheduling.",
    }),
    everyMs: ScheduledTaskIntervalMs.check(
      Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS),
    ).annotate({
      description: "Interval in milliseconds, with a minimum of 60000 (one minute).",
    }),
  }).annotate({
    description: "Run repeatedly after a fixed number of milliseconds.",
  }),
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskUpsertWebhookSchedule,
  ScheduledTaskManualSchedule,
  ScheduledTaskMonthlySchedule,
  ScheduledTaskUpsertOnceSchedule,
]).annotate({
  description:
    "Writable trigger. Pass an object with type 'interval', 'fixed_time', 'once', 'webhook', 'manual' (only when asked) or 'monthly'.",
});
export type ScheduledTaskUpsertSchedule = typeof ScheduledTaskUpsertSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["never", "running", "succeeded", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

/** Where a webhook task receives requests. Present only on webhook tasks. */
export const ScheduledTaskWebhookEndpoint = Schema.Struct({
  /** Environment-relative path including the secret token; works on any origin that reaches the environment. */
  path: TrimmedNonEmptyString,
  /** Public Studio Connect URL, or null when the environment is not linked to Studio Connect. */
  url: Schema.NullOr(TrimmedNonEmptyString),
  hasSecret: Schema.Boolean,
});
export type ScheduledTaskWebhookEndpoint = typeof ScheduledTaskWebhookEndpoint.Type;

/**
 * A shell check run before any agent: the routine wakes its thread only when
 * the command exits 0, and a quiet run uses no AI provider at all.
 */
export const ScheduledTaskCheck = Schema.Struct({
  command: TrimmedNonEmptyString.annotate({
    description:
      "Shell command run with /bin/sh in the project folder. Exit 0 means the condition holds: the prompt is sent with the command's output. Any other exit ends the run quietly, without an agent.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 600_000 })).annotate({
      description: "How long the command may run, in milliseconds; defaults to 60000.",
    }),
  ),
}).annotate({ description: "Run a shell check first and wake the agent only when it passes." });
export type ScheduledTaskCheck = typeof ScheduledTaskCheck.Type;

export const ROUTINE_BRIEF_MAX_INPUTS = 8;

/** One thing a routine works from, which the user named: a folder, a file or a URL. */
export const ScheduledTaskBriefInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
    description: "Short name, such as 'Receipts folder'.",
  }),
  location: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description: "Where it is: a folder or file path, or a URL. Only what the user named.",
  }),
});
export type ScheduledTaskBriefInput = typeof ScheduledTaskBriefInput.Type;

/**
 * What a reusable routine works from and produces. Each run's message opens
 * with it, so every run checks the same inputs and updates the same output.
 */
export const ScheduledTaskBrief = Schema.Struct({
  inputs: Schema.Array(ScheduledTaskBriefInput)
    .check(Schema.isMaxLength(ROUTINE_BRIEF_MAX_INPUTS))
    .annotate({
      description:
        "Up to 8 inputs. Each run checks they exist and are current before any work, and stops with a list when one is missing or stale.",
    }),
  output: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))).annotate({
    description:
      "Where the result goes, such as a file path with {period}; a rerun updates it in place. Null to answer in the thread only.",
  }),
  prepareOnly: Schema.Boolean.annotate({
    description:
      "Prepare and draft only: never file, pay, send, post or change an account; list those actions for the user.",
  }),
}).annotate({ description: "Inputs, output and limits every run of this routine follows." });
export type ScheduledTaskBrief = typeof ScheduledTaskBrief.Type;

const ScheduledTaskOwnThread = Schema.Boolean.annotate({
  description:
    "Give the routine a thread of its own: the first run starts it, titled after the routine, and later runs continue it. A deleted or archived thread is replaced on the next run.",
});

const ScheduledTaskModelPinned = Schema.Boolean.annotate({
  description:
    "Run every time on modelSelection. Off by default: a run in a bound thread uses the model that thread's next turn would use, and never moves it to another provider.",
});

export const ScheduledTask = Schema.Struct({
  id: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  webhook: Schema.optional(ScheduledTaskWebhookEndpoint),
  modelPinned: Schema.optional(ScheduledTaskModelPinned),
  check: Schema.optional(Schema.NullOr(ScheduledTaskCheck)),
  brief: Schema.optional(Schema.NullOr(ScheduledTaskBrief)),
  ownThread: Schema.optional(ScheduledTaskOwnThread),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskListInput = Schema.Struct({});
export type ScheduledTaskListInput = typeof ScheduledTaskListInput.Type;

export const ScheduledTaskListResult = Schema.Struct({
  // Trigger types grow over time; a client must not lose the whole list over
  // one task it cannot decode.
  tasks: ForwardCompatibleArray(ScheduledTask),
});
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskUpsertInput = Schema.Struct({
  id: Schema.optional(ScheduledTaskId),
  requireExisting: Schema.optional(Schema.Boolean).annotate({
    description: "Reject the save if the task no longer exists, for edits from a client form.",
  }),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskUpsertSchedule,
  projectId: ProjectId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdBy: Schema.optional(OrchestrationV2Actor),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  modelPinned: Schema.optional(ScheduledTaskModelPinned),
  check: Schema.optional(Schema.NullOr(ScheduledTaskCheck)),
  brief: Schema.optional(Schema.NullOr(ScheduledTaskBrief)),
  ownThread: Schema.optional(ScheduledTaskOwnThread),
});
export type ScheduledTaskUpsertInput = typeof ScheduledTaskUpsertInput.Type;

/** Partial update that flips only the enabled flag — never overwrites other fields. */
export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: ScheduledTaskId,
  enabled: Schema.Boolean,
});
export type ScheduledTaskSetEnabledInput = typeof ScheduledTaskSetEnabledInput.Type;

export const ScheduledTaskDeleteInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteInput = typeof ScheduledTaskDeleteInput.Type;

export const ScheduledTaskRunNowInput = Schema.Struct({
  id: ScheduledTaskId,
  /** Reuse after a transport failure; a new intentional run gets a new id. */
  commandId: Schema.optional(CommandId),
});
export type ScheduledTaskRunNowInput = typeof ScheduledTaskRunNowInput.Type;

export const ScheduledTaskRotateWebhookTokenInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskRotateWebhookTokenInput = typeof ScheduledTaskRotateWebhookTokenInput.Type;

export const ScheduledTaskWebhookDeliveryId = TrimmedNonEmptyString.pipe(
  Schema.brand("ScheduledTaskWebhookDeliveryId"),
);
export type ScheduledTaskWebhookDeliveryId = typeof ScheduledTaskWebhookDeliveryId.Type;

export const ScheduledTaskWebhookDeliveryOutcome = Schema.Literals([
  "accepted",
  "dispatch_failed",
  "rejected_signature",
  "disabled",
  "rate_limited",
  "expired",
]);
export type ScheduledTaskWebhookDeliveryOutcome = typeof ScheduledTaskWebhookDeliveryOutcome.Type;

export const ScheduledTaskWebhookDeliverySummary = Schema.Struct({
  id: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  receivedAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  contentType: Schema.NullOr(Schema.String),
  bodyBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: ScheduledTaskWebhookDeliveryOutcome,
  /** True when a configured signature matched; false when none was configured. */
  signatureVerified: Schema.Boolean,
  /** Template placeholders that had no value in this request and rendered empty. */
  missingFields: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDeliverySummary = typeof ScheduledTaskWebhookDeliverySummary.Type;

export const ScheduledTaskWebhookDelivery = Schema.Struct({
  ...ScheduledTaskWebhookDeliverySummary.fields,
  query: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  /** Body as UTF-8 text, cut at the log limit; see bodyTruncated. */
  body: Schema.String,
  bodyTruncated: Schema.Boolean,
  renderedPrompt: Schema.NullOr(Schema.String),
});
export type ScheduledTaskWebhookDelivery = typeof ScheduledTaskWebhookDelivery.Type;

export const ScheduledTaskListWebhookDeliveriesInput = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskListWebhookDeliveriesInput =
  typeof ScheduledTaskListWebhookDeliveriesInput.Type;

export const ScheduledTaskListWebhookDeliveriesResult = Schema.Struct({
  deliveries: Schema.Array(ScheduledTaskWebhookDeliverySummary),
});
export type ScheduledTaskListWebhookDeliveriesResult =
  typeof ScheduledTaskListWebhookDeliveriesResult.Type;

export const ScheduledTaskGetWebhookDeliveryInput = Schema.Struct({
  id: ScheduledTaskId,
  deliveryId: ScheduledTaskWebhookDeliveryId,
});
export type ScheduledTaskGetWebhookDeliveryInput = typeof ScheduledTaskGetWebhookDeliveryInput.Type;

export const ScheduledTaskGetWebhookDeliveryResult = Schema.Struct({
  delivery: ScheduledTaskWebhookDelivery,
});
export type ScheduledTaskGetWebhookDeliveryResult =
  typeof ScheduledTaskGetWebhookDeliveryResult.Type;

export const ScheduledTaskMutationResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskMutationResult = typeof ScheduledTaskMutationResult.Type;

export const ScheduledTaskDeleteResult = Schema.Struct({
  id: ScheduledTaskId,
});
export type ScheduledTaskDeleteResult = typeof ScheduledTaskDeleteResult.Type;

export const ScheduledTaskRunNowResult = Schema.Struct({
  task: ScheduledTask,
});
export type ScheduledTaskRunNowResult = typeof ScheduledTaskRunNowResult.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  {
    message: Schema.String,
    taskId: Schema.optional(ScheduledTaskId),
    reason: Schema.optional(Schema.Literals(["run_outcome_unknown", "run_command_conflict"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
