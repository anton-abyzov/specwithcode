import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { humanPromptTitle, isHarnessMarkupTitle, legacyImportTitle } from "./AgentSessionPrompt.ts";

/**
 * Sessions imported before titles skipped harness markup are named
 * `<environment_context>` or `<wake reason="mention" …`. Once, when the server
 * starts, each is renamed from the first line a person typed in it.
 *
 * A thread is only touched while its title is still the one the import wrote,
 * so a name a person gave it stays. One with no typed line is archived when
 * its whole transcript is stored and nobody has done anything to it since the
 * import (a bot wake-up); otherwise it is renamed "Imported session", because
 * the typed line may be in the part of a long transcript the import left out.
 *
 * A renamed thread keeps the time its session was last used: the rename is
 * written as the thread's own event at that time, the way the import writes a
 * thread, and not as a metadata command, which would stamp it "now" and line
 * every repaired thread up at the same age.
 */

/** The import keeps a session's first message and its last 199. */
const MAX_IMPORTED_MESSAGES = 200;
const UNTYPED_TITLE = "Imported session";
const REPAIR_PREFIX = "imported-thread-title-repair";

type ImportedShell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "historyOrigin">;
type RepairThread = Pick<
  OrchestrationV2AppThread,
  "title" | "updatedAt" | "settledOverride" | "settledAt" | "pinnedAt" | "archivedAt"
>;
type StoredMessage = {
  readonly role: string;
  readonly text: string;
  readonly createdAt: DateTime.Utc;
};

export type ImportedThreadRepair =
  | { readonly type: "rename"; readonly title: string; readonly updatedAt: DateTime.Utc }
  | { readonly type: "archive" };

/** The imported threads whose stored title is harness markup. */
export function importedThreadsToRepair<T extends ImportedShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) => thread.historyOrigin === "v1_import" && isHarnessMarkupTitle(thread.title),
  );
}

/** True while the thread is exactly as the import left it: settled, never changed. */
function untouchedSinceImport(thread: RepairThread): boolean {
  const settledAt = thread.settledAt ?? null;
  return (
    thread.settledOverride === "settled" &&
    (thread.pinnedAt ?? null) === null &&
    (thread.archivedAt ?? null) === null &&
    settledAt !== null &&
    DateTime.toEpochMillis(settledAt) === DateTime.toEpochMillis(thread.updatedAt)
  );
}

/**
 * What to do with one imported thread, or null to leave it alone. `messages`
 * are the thread's stored messages, oldest first.
 */
export function importedThreadRepair(
  thread: RepairThread,
  messages: ReadonlyArray<StoredMessage>,
  options: { readonly hasRuns: boolean },
): ImportedThreadRepair | null {
  const firstUserMessage = messages.find((message) => message.role === "user");
  // Renamed since the import, or not titled by it: not ours to change.
  if (firstUserMessage === undefined || thread.title !== legacyImportTitle(firstUserMessage.text))
    return null;
  const untouched = untouchedSinceImport(thread) && !options.hasRuns;
  // The import stamped the thread with the transcript file's time. Until
  // someone changes the thread, its age is when the session was last used.
  const lastMessageAt = messages.at(-1)?.createdAt;
  const updatedAt =
    untouched &&
    lastMessageAt !== undefined &&
    DateTime.toEpochMillis(lastMessageAt) <= DateTime.toEpochMillis(thread.updatedAt)
      ? lastMessageAt
      : thread.updatedAt;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const title = humanPromptTitle(message.text);
    // A typed line that itself reads like markup is already the title: nothing to write.
    if (title !== "") return title === thread.title ? null : { type: "rename", title, updatedAt };
  }
  return untouched && messages.length < MAX_IMPORTED_MESSAGES
    ? { type: "archive" }
    : { type: "rename", title: UNTYPED_TITLE, updatedAt };
}

/** The event that renames a thread and leaves its age at `repair.updatedAt`. */
export function importedThreadRenameEvent(
  thread: OrchestrationV2AppThread,
  repair: Extract<ImportedThreadRepair, { type: "rename" }>,
): OrchestrationV2DomainEvent {
  const untouched = untouchedSinceImport(thread);
  return {
    // One event per state of the thread: a restart that finds it renamed writes nothing.
    id: EventId.make(
      `${REPAIR_PREFIX}:${thread.id}:${DateTime.toEpochMillis(thread.updatedAt)}:renamed`,
    ),
    type: "thread.metadata-updated",
    threadId: thread.id,
    occurredAt: repair.updatedAt,
    payload: {
      ...thread,
      title: repair.title,
      updatedAt: repair.updatedAt,
      ...(untouched ? { settledAt: repair.updatedAt } : {}),
    },
  };
}

export const repairImportedThreadTitles = Effect.fn("ImportedThreadTitleRepair.repair")(
  function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const eventSink = yield* EventSink.EventSinkV2;
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    let renamed = 0;
    let archived = 0;
    let failed = 0;
    const candidates = importedThreadsToRepair(snapshot.threads);
    for (const shell of candidates) {
      // Read just before the write: provider writes share this path and take no command lock either.
      const repairOne = Effect.gen(function* () {
        const records = yield* threads.getThreadRecords(shell.id, ["messages"]);
        const messages = records.messages.toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        );
        const repair = importedThreadRepair(records.thread, messages, {
          hasRuns: shell.latestRunId !== null,
        });
        if (repair === null) return;
        if (repair.type === "archive") {
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`${REPAIR_PREFIX}:archive:${shell.id}`),
            threadId: shell.id,
          });
          archived += 1;
          return;
        }
        yield* eventSink.write({ events: [importedThreadRenameEvent(records.thread, repair)] });
        renamed += 1;
      });
      // One thread that cannot be read or written does not stop the rest.
      yield* repairOne.pipe(
        Effect.catchCause((cause) => {
          failed += 1;
          return Effect.logWarning("Could not repair an imported thread's title", {
            threadId: shell.id,
            cause,
          });
        }),
      );
      yield* Effect.yieldNow;
    }
    // On the span, so a machine's trace shows the outcome even when nothing needed repair.
    yield* Effect.annotateCurrentSpan({
      "imported_thread_repair.candidates": candidates.length,
      "imported_thread_repair.renamed": renamed,
      "imported_thread_repair.archived": archived,
      "imported_thread_repair.failed": failed,
    });
    if (renamed + archived + failed > 0)
      yield* Effect.logInfo("Repaired imported thread titles", { renamed, archived, failed });
    return { renamed, archived, failed };
  },
);

/** Runs once when the server starts, off the startup path. */
export const layerStart = Layer.effectDiscard(
  repairImportedThreadTitles().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Imported thread title repair failed", { cause }),
    ),
    Effect.forkScoped,
  ),
);
