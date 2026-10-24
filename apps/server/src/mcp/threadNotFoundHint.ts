import { OrchestratorMcpFailure, ThreadId } from "@specweave-studio/contracts";
import { threadIdNearMisses } from "@specweave-studio/shared/studioThreadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { loadCaller } from "./threadAccess.ts";
import { workGrantOf } from "./workGrantAccess.ts";

const COPY_EXACTLY =
  "Thread IDs are opaque: copy threadId, or the href of threadLink, exactly as a tool returned it; the leading `thread:` and any `%3A` are part of the ID.";

/**
 * A `thread_not_found` an agent can act on. When the ID it passed is a
 * near miss of a thread that exists (see threadIdNearMisses), the answer names
 * that thread; the tool still acts only on the ID it was given, so access
 * checks always see the thread it acts on. Work started from another machine
 * gets no suggestions: it may reach only the projects its grant covers.
 */
export const explainThreadNotFound = (threadId: string, failure: OrchestratorMcpFailure) =>
  Effect.gen(function* () {
    if (failure.code !== "thread_not_found") return failure;
    const context = yield* loadCaller();
    // The ID was right and the thread is gone: the original answer says so.
    if ((yield* context.threads.getThreadShell(ThreadId.make(threadId))) !== null) return failure;
    const meant =
      (yield* workGrantOf(context)) !== undefined
        ? undefined
        : yield* Effect.findFirst(threadIdNearMisses(threadId), (candidate) =>
            context.threads.getThreadShell(ThreadId.make(candidate)).pipe(
              Effect.map((shell) => shell !== null && shell.deletedAt === null),
              Effect.orElseSucceed(() => false),
            ),
          ).pipe(Effect.map(Option.getOrUndefined));
    return new OrchestratorMcpFailure({
      code: "thread_not_found",
      message:
        meant === undefined
          ? `Thread ${threadId} was not found. ${COPY_EXACTLY} Find the thread with studio_thread_search or studio_thread_list.`
          : `Thread ${threadId} was not found. Did you mean ${meant}? ${COPY_EXACTLY}`,
    });
  }).pipe(Effect.orElseSucceed(() => failure));
