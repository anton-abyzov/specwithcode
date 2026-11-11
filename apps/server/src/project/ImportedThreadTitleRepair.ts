import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { humanPromptTitle, isHarnessMarkupTitle } from "./AgentSessionPrompt.ts";

/**
 * Sessions imported before titles skipped harness markup are named
 * `<environment_context>` or `<wake reason="mention" …`. This renames each from
 * the first line a person typed in it, and archives one with no such line (a bot
 * wake-up). A title a person set is never markup, so nothing else is touched.
 */

type ImportedShell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "historyOrigin">;

/** The imported threads whose stored title is harness markup. */
export function importedThreadsToRepair<T extends ImportedShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) => thread.historyOrigin === "v1_import" && isHarnessMarkupTitle(thread.title),
  );
}

/**
 * The command that repairs one imported thread. Command ids are fixed per
 * thread, so a restart that finds the same thread again repeats nothing.
 */
export function importedThreadRepairCommand(
  thread: Pick<OrchestrationV2ThreadShell, "id">,
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): OrchestrationV2ServerCommand {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const title = humanPromptTitle(message.text);
    if (title !== "")
      return {
        type: "thread.metadata.update",
        commandId: CommandId.make(`imported-thread-title-repair:${thread.id}`),
        threadId: thread.id,
        title,
      };
  }
  return {
    type: "thread.archive",
    commandId: CommandId.make(`imported-thread-title-repair:archive:${thread.id}`),
    threadId: thread.id,
  };
}

export const repairImportedThreadTitles = Effect.fn("ImportedThreadTitleRepair.repair")(
  function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    let renamed = 0;
    let archived = 0;
    for (const thread of importedThreadsToRepair(snapshot.threads)) {
      const records = yield* threads.getThreadRecords(thread.id, ["messages"]);
      const messages = records.messages.toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      );
      const command = importedThreadRepairCommand(thread, messages);
      yield* threads.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (command.type === "thread.archive") archived += 1;
            else renamed += 1;
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not repair an imported thread's title", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
      yield* Effect.yieldNow;
    }
    if (renamed + archived > 0)
      yield* Effect.logInfo("Repaired imported thread titles", { renamed, archived });
    return { renamed, archived };
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
