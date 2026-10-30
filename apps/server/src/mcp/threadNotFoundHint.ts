import { OrchestratorMcpFailure, ThreadId } from "@specweave-studio/contracts";
import { threadIdNearMisses } from "@specweave-studio/shared/studioThreadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { loadCaller } from "./threadAccess.ts";
import { workGrantOf } from "./workGrantAccess.ts";

const COPY_EXACTLY =
  "Thread IDs are opaque: copy threadId, or the href of threadLink, exactly as a tool returned it; the leading `thread:` and any `%3A` are part of the ID.";

/**
 * Claude projects (claude.ai) and Claude Code remote sessions use IDs like
 * `session_01…` and `cmsg_01…`. They turn up in briefs copied from those
 * products, and an agent that treats one as a thread here goes looking for a
 * way to reach it, down to signing in to claude.ai in a browser. Nothing here
 * can reach them, so the answer says so and points at the work's own record.
 */
const FOREIGN_SESSION_ID = /^(session|cmsg)_[0-9A-Za-z]{10,}$/;

const foreignSessionMessage = (threadId: string) =>
  `${threadId} is a Claude projects or Claude Code session or message ID, not a SpecWithCode thread. SpecWithCode has no transport to those sessions, and signing in to Claude in a browser will not connect one. Get what you need from the work's own record instead (the pull request, commits, CI or a saved receipt), or ask the user once to relay it. Do not open a browser or start another worker to reach it.`;

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
    if (FOREIGN_SESSION_ID.test(threadId))
      return new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: foreignSessionMessage(threadId),
      });
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
