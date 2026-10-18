/**
 * A thread on Full access never waits on a permission prompt.
 *
 * Providers take an access mode when a turn or session starts (Codex sends its
 * approval policy with every `turn/start`), so a turn that began under a
 * stricter mode keeps asking after the thread is raised to Full access: by its
 * composer, by a project permission save that applies on the next turn, or by
 * a handoff. The thread then shows Full access while it waits on approvals.
 * This reactor answers those prompts the way Full access would have, both when
 * one arrives and when a thread with prompts already pending is raised.
 *
 * Only command, file and permission prompts are answered. Questions, MCP
 * elicitations and sign-in requests still go to the person.
 *
 * @module FullAccessApprovals
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type RuntimeMode,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const FULL_ACCESS_PROMPT_KINDS: ReadonlySet<OrchestrationV2RuntimeRequest["kind"]> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
]);

/** A pending prompt that Full access would never have raised. */
export function isFullAccessPrompt(
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "responseCapability">,
): boolean {
  return (
    request.status === "pending" &&
    request.responseCapability.type === "live" &&
    FULL_ACCESS_PROMPT_KINDS.has(request.kind)
  );
}

/**
 * The mode a thread's prompts run under. A provider's own subagent asks under
 * its parent's turn, and project saves update the parent only.
 */
export function promptRuntimeMode(
  thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "lineage" | "creationSource">,
  parentRuntimeMode: RuntimeMode | undefined,
): RuntimeMode {
  return isProviderNativeSubagentThread(thread) && parentRuntimeMode !== undefined
    ? parentRuntimeMode
    : thread.runtimeMode;
}

export class FullAccessApprovals extends Context.Service<
  FullAccessApprovals,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Handles one domain event; exposed for tests. */
    readonly process: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/FullAccessApprovals") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const runtimeModeOf = (thread: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      const parentId = thread.lineage.parentThreadId;
      if (!isProviderNativeSubagentThread(thread) || parentId === null) return thread.runtimeMode;
      const parent = yield* threads.getThreadRecords(parentId, []);
      return promptRuntimeMode(thread, parent.thread.runtimeMode);
    });

  const accept = (threadId: ThreadId, request: OrchestrationV2RuntimeRequest) =>
    threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`server:full-access-accept:${request.id}`),
        threadId,
        requestId: request.id,
        decision: "accept",
      })
      .pipe(
        Effect.tap(() =>
          Effect.logInfo("accepted a prompt on a Full access thread", {
            threadId,
            requestId: request.id,
            kind: request.kind,
          }),
        ),
        // The person or the provider got there first; nothing is left to answer.
        Effect.catch((error) =>
          Effect.logDebug("Full access prompt already settled", { threadId, error }),
        ),
      );

  /** Accepts every pending prompt of a thread whose prompts now run on Full access. */
  const acceptPending = (threadId: ThreadId, runtimeMode?: RuntimeMode) =>
    Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
      const prompts = records.runtimeRequests.filter(isFullAccessPrompt);
      if (prompts.length === 0) return;
      if ((runtimeMode ?? (yield* runtimeModeOf(records.thread))) !== "full-access") return;
      yield* Effect.forEach(prompts, (request) => accept(threadId, request), { discard: true });
    });

  const process = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    const handled = (() => {
      switch (event.type) {
        case "runtime-request.updated":
          return isFullAccessPrompt(event.payload) ? acceptPending(event.threadId) : Effect.void;
        case "thread.runtime-mode-updated":
          if (event.payload.runtimeMode !== "full-access") return Effect.void;
          return Effect.gen(function* () {
            yield* acceptPending(event.threadId, "full-access");
            // The provider's own subagents ask under this thread's turn.
            const records = yield* threads.getThreadRecords(event.threadId, ["subagents"]);
            const children = records.subagents.flatMap((task) =>
              task.childThreadId === null ? [] : [task.childThreadId],
            );
            yield* Effect.forEach(
              children,
              (childId) =>
                threads
                  .getThreadRecords(childId, [])
                  .pipe(
                    Effect.flatMap((child) =>
                      isProviderNativeSubagentThread(child.thread)
                        ? acceptPending(childId, "full-access")
                        : Effect.void,
                    ),
                  ),
              { discard: true },
            );
          });
        default:
          return Effect.void;
      }
    })();
    return handled.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Full access prompt check failed", {
              threadId: event.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  };

  const start: FullAccessApprovals["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(threads.streamDomainEvents, process).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Full access prompt stream stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );

  return { start, process } satisfies FullAccessApprovals["Service"];
});

export const layer = Layer.effect(FullAccessApprovals, make);
