import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { CONTEXT_COMPACT_MESSAGE_PREFIX, CONTEXT_RETRY_MESSAGE_PREFIX } from "./contextRecoveryIds.ts";
import {
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
} from "./providerOpenFailure.ts";
import { PROVIDER_RETRY_MESSAGE_PREFIX } from "./unopenableFallback.ts";

/**
 * Threads a routine runs in: its own thread, or an existing thread it posts
 * into. A fallback never gives such a thread a track row's Ultracode, since a
 * routine runs unattended and repeatedly (1441, 1506 D-04). A person's turns
 * in a thread a routine posts into lose it too: the stop does not say which
 * kind of turn it ended, and off is the safe side.
 * Empty without a database or on any read error.
 */
export const routineThreadIds = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return new Set<string>();
  return yield* sql.value<{ readonly thread_id: string }>`
    SELECT thread_id FROM scheduled_tasks WHERE thread_id IS NOT NULL
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.thread_id))),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

/** True for a thread a fallback must not give a row's Ultracode: a routine's or the coordinator. */
export const skipsRowUltracode = (
  threadId: string,
  routineThreads: ReadonlySet<string>,
  project: {
    readonly workspaceSettings?:
      | { readonly coordinatorThreadId?: string | null | undefined }
      | null
      | undefined;
  },
): boolean =>
  routineThreads.has(threadId) || threadId === project.workspaceSettings?.coordinatorThreadId;

// Messages an automatic continuation starts with: `<prefix><thread>:[hop-N:]<run>`.
const CONTINUATION_PREFIXES = [
  LIMIT_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_FALLBACK_MESSAGE_PREFIX,
  PROVIDER_RETRY_MESSAGE_PREFIX,
  CONTEXT_RETRY_MESSAGE_PREFIX,
  CONTEXT_COMPACT_MESSAGE_PREFIX,
  "limit-return:",
  "limit-reset:",
  "limit-credits:",
  "limit-api:",
  "limit-billing:",
];

/**
 * The run an automatic continuation message continues, or null for any other
 * message. Lets a routine's origin survive a second fallback hop (1506 D-04).
 */
export function continuedRunId(messageId: string, threadId: string): string | null {
  for (const prefix of CONTINUATION_PREFIXES) {
    const head = `${prefix}${threadId}:`;
    if (!messageId.startsWith(head)) continue;
    const rest = messageId.slice(head.length).replace(/^hop-\d+:/, "");
    return rest === "" ? null : rest;
  }
  return null;
}

/**
 * What a run's start message says about who began the work: a routine (it
 * carries a routine id), a person or agent (web, mobile, MCP, provider), a
 * continuation to follow to the run it continues, or unknown. Any other turn
 * the server started (usage-limit resume, a wake) cannot be traced and is
 * unknown, which keeps row Ultracode off (1506 D-04).
 */
export function messageOrigin(
  message:
    | { readonly scheduledTaskId?: string | undefined; readonly creationSource?: string }
    | undefined,
  continued: string | null,
): "routine" | "person" | "follow" | "unknown" {
  if (message === undefined) return "unknown";
  if (message.scheduledTaskId !== undefined) return "routine";
  if (continued !== null) return "follow";
  return message.creationSource === "server" ? "unknown" : "person";
}
