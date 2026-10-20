/**
 * A thread on Full access never waits on a permission prompt.
 *
 * Providers take an access mode when a turn or session starts (Codex sends its
 * approval policy with every `turn/start`), so a turn that began under a
 * stricter mode keeps asking after the thread is raised to Full access: by its
 * composer, by a project permission save that applies on the next turn, or by
 * a handoff. The thread then shows Full access while it waits on approvals.
 * This reactor answers those prompts the way Full access would have: when one
 * arrives, when a thread with prompts already pending is raised, when the
 * server starts (prompts left over from before a restart or an update), and on
 * a periodic sweep in case an event was missed.
 *
 * Raising a thread also raises the app-owned workers it delegated to, so a
 * coordinator on Full access does not leave a worker asking for approvals. A
 * person's forks keep their own mode.
 *
 * Command, file and permission prompts are answered, and MCP elicitations that
 * only ask for a yes. Questions, elicitations that ask for fields and sign-in
 * requests still go to the person.
 *
 * @module FullAccessApprovals
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type RuntimeMode,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const FULL_ACCESS_PROMPT_KINDS: ReadonlySet<OrchestrationV2RuntimeRequest["kind"]> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
  // Only the confirmations among them; see isConfirmOnlyElicitation.
  "mcp-elicitation",
]);

/** A pending prompt that Full access may answer without the person. */
export function isFullAccessPrompt(
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "responseCapability">,
): boolean {
  return (
    request.status === "pending" &&
    request.responseCapability.type === "live" &&
    FULL_ACCESS_PROMPT_KINDS.has(request.kind)
  );
}

type ApprovalItem = Extract<OrchestrationV2TurnItem, { readonly type: "approval_request" }>;

/**
 * An MCP elicitation the person could only say yes or no to. The Codex adapter
 * declines up front a form whose required fields have no default, and shows
 * the rest as approvals whose Approve submits the form's own defaults. So an
 * elicitation approval that offers Approve asks for nothing but a yes; one
 * without Approve asks for fields and is left for the person.
 */
export function isConfirmOnlyElicitation(item: ApprovalItem | undefined): boolean {
  return (
    item !== undefined &&
    item.requestKind === "mcp-elicitation" &&
    (item.options ?? []).some((option) => option.decision === "accept")
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

export interface FullAccessApprovalsOptions {
  /** How often pending prompts are swept for after the start sweep. */
  readonly sweepInterval: Duration.Input;
  /** Answer attempts per prompt while it stays pending. */
  readonly acceptAttempts: number;
  /** Wait before the second attempt; doubles for each one after. */
  readonly retryDelay: Duration.Input;
  /** First wait before the event stream is reopened; doubles up to a minute. */
  readonly streamRestartDelay: Duration.Input;
}

const defaultOptions: FullAccessApprovalsOptions = {
  sweepInterval: Duration.minutes(2),
  acceptAttempts: 4,
  retryDelay: Duration.seconds(2),
  streamRestartDelay: Duration.seconds(1),
};

export class FullAccessApprovals extends Context.Service<
  FullAccessApprovals,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Handles one domain event; exposed for tests. */
    readonly process: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Answers every prompt left pending on a Full access thread; exposed for tests. */
    readonly sweep: () => Effect.Effect<void>;
  }
>()("specweave-studio/orchestration-v2/FullAccessApprovals") {}

const reportFailure =
  (message: string, threadId?: ThreadId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, {
              ...(threadId === undefined ? {} : { threadId }),
              cause: Cause.pretty(cause),
            }),
      ),
    );

/** @public Service construction is part of the canonical Effect module API. */
export const makeWith = (overrides: Partial<FullAccessApprovalsOptions> = {}) =>
  Effect.gen(function* () {
    const options = { ...defaultOptions, ...overrides };
    const threads = yield* ThreadManagementService.ThreadManagementService;
    // Command IDs must differ between attempts and between server runs, so a
    // failed answer never blocks the next one.
    const runId = (yield* randomUuidV4).slice(0, 8);
    let nextCommand = 0;
    const commandId = (prefix: string, key: string) =>
      CommandId.make(`server:${prefix}:${key}:${runId}:${++nextCommand}`);
    const inFlight = new Set<string>();

    const runtimeModeOf = (thread: OrchestrationV2AppThread) =>
      Effect.gen(function* () {
        const parentId = thread.lineage.parentThreadId;
        if (!isProviderNativeSubagentThread(thread) || parentId === null) return thread.runtimeMode;
        const parent = yield* threads.getThreadRecords(parentId, []);
        return promptRuntimeMode(thread, parent.thread.runtimeMode);
      });

    const stillPending = (threadId: ThreadId, request: OrchestrationV2RuntimeRequest) =>
      threads.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
        Effect.map((records) =>
          records.runtimeRequests.some(
            (candidate) => candidate.id === request.id && isFullAccessPrompt(candidate),
          ),
        ),
        // A thread that cannot be read is not retried blindly.
        Effect.orElseSucceed(() => false),
      );

    /**
     * Where later answer attempts wait, so a retry never holds up the next
     * event. Set while `start` runs; `process` without it retries inline.
     */
    let retries: FiberSet.FiberSet<void, never> | undefined;

    /** One answer; "retry" when it failed and the prompt still waits on another try. */
    const attemptAccept = (
      threadId: ThreadId,
      request: OrchestrationV2RuntimeRequest,
      attempt: number,
    ): Effect.Effect<"done" | "retry"> =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          threads.dispatch({
            type: "runtime-request.respond",
            commandId: commandId("full-access-accept", request.id),
            threadId,
            requestId: request.id,
            decision: "accept",
          }),
        );
        if (Exit.isSuccess(exit)) {
          yield* Effect.logInfo("accepted a prompt on a Full access thread", {
            threadId,
            requestId: request.id,
            kind: request.kind,
          });
          return "done";
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        // The person or the provider got there first; nothing is left to answer.
        if (!(yield* stillPending(threadId, request))) {
          yield* Effect.logDebug("Full access prompt already settled", { threadId });
          return "done";
        }
        if (attempt >= options.acceptAttempts) {
          yield* Effect.logWarning("Could not answer a prompt on a Full access thread", {
            threadId,
            requestId: request.id,
            attempts: attempt,
            cause: Cause.pretty(exit.cause),
          });
          return "done";
        }
        return "retry";
      });

    const retryAccept = (threadId: ThreadId, request: OrchestrationV2RuntimeRequest) =>
      Effect.gen(function* () {
        for (let attempt = 2; ; attempt++) {
          yield* Effect.sleep(
            Duration.times(Duration.fromInputUnsafe(options.retryDelay), 2 ** (attempt - 2)),
          );
          if ((yield* attemptAccept(threadId, request, attempt)) === "done") return;
        }
      });

    const accept = (threadId: ThreadId, request: OrchestrationV2RuntimeRequest) =>
      Effect.suspend(() => {
        // An event and a sweep can find the same prompt; one answer is enough.
        if (inFlight.has(request.id)) return Effect.void;
        inFlight.add(request.id);
        const release = Effect.sync(() => inFlight.delete(request.id));
        let handedOff = false;
        return Effect.gen(function* () {
          if ((yield* attemptAccept(threadId, request, 1)) === "done") return;
          const retrying = retryAccept(threadId, request).pipe(Effect.ensuring(release));
          const set = retries;
          if (set === undefined) {
            handedOff = true;
            return yield* retrying;
          }
          yield* Effect.uninterruptible(
            FiberSet.run(set, retrying).pipe(
              Effect.tap(() => Effect.sync(() => (handedOff = true))),
            ),
          );
        }).pipe(Effect.ensuring(Effect.suspend(() => (handedOff ? Effect.void : release))));
      });

    /** Accepts every pending prompt of a thread whose prompts now run on Full access. */
    const acceptPending = (threadId: ThreadId, runtimeMode?: RuntimeMode) =>
      Effect.gen(function* () {
        const records = yield* threads.getThreadRecords(threadId, ["runtimeRequests"]);
        const candidates = records.runtimeRequests.filter(isFullAccessPrompt);
        if (candidates.length === 0) return;
        if ((runtimeMode ?? (yield* runtimeModeOf(records.thread))) !== "full-access") return;
        let prompts = candidates;
        if (candidates.some((request) => request.kind === "mcp-elicitation")) {
          const items = yield* threads.getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: ["approval_request"],
          });
          const approvals = new Map<string, ApprovalItem>();
          for (const item of items.turnItems)
            if (item.type === "approval_request") approvals.set(item.requestId, item);
          prompts = candidates.filter(
            (request) =>
              request.kind !== "mcp-elicitation" ||
              isConfirmOnlyElicitation(approvals.get(request.id)),
          );
        }
        yield* Effect.forEach(prompts, (request) => accept(threadId, request), { discard: true });
      });

    /**
     * A thread now on Full access: answer its prompts and those of the
     * provider's own subagents, and raise the app-owned workers it delegated
     * to, all the way down, from one shell snapshot.
     */
    const raised = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* acceptPending(threadId, "full-access").pipe(
          reportFailure("Full access prompt check failed", threadId),
        );
        const snapshot = yield* threads.getShellSnapshot({ location: "active" });
        const childrenOf = new Map<ThreadId, Array<OrchestrationV2ThreadShell>>();
        for (const child of snapshot.threads) {
          const parentId = child.lineage.parentThreadId;
          // A person's fork keeps the mode they gave it.
          if (parentId === null || child.lineage.relationshipToParent !== "subagent") continue;
          if (child.archivedAt !== null || child.deletedAt !== null) continue;
          const siblings = childrenOf.get(parentId);
          if (siblings === undefined) childrenOf.set(parentId, [child]);
          else siblings.push(child);
        }
        const seen = new Set<ThreadId>([threadId]);
        const raiseChildren = (parentId: ThreadId): Effect.Effect<void> =>
          Effect.forEach(
            childrenOf.get(parentId) ?? [],
            (child) =>
              Effect.gen(function* () {
                if (seen.has(child.id)) return;
                seen.add(child.id);
                // The provider's own subagents ask under this thread's turn.
                if (isProviderNativeSubagentThread(child)) {
                  return yield* acceptPending(child.id, "full-access");
                }
                if (child.runtimeMode !== "full-access") {
                  yield* threads.dispatch({
                    type: "thread.runtime-mode.set",
                    commandId: commandId("full-access-raise", child.id),
                    threadId: child.id,
                    runtimeMode: "full-access",
                    // Keep a working worker running; its prompts are answered here.
                    applyOnNextTurn: true,
                  });
                  yield* Effect.logInfo("raised a worker to Full access with its coordinator", {
                    threadId: child.id,
                    parentThreadId: parentId,
                  });
                }
                yield* acceptPending(child.id, "full-access").pipe(
                  reportFailure("Full access prompt check failed", child.id),
                );
                yield* raiseChildren(child.id);
              }).pipe(reportFailure("Could not raise a worker to Full access", child.id)),
            { discard: true },
          );
        yield* raiseChildren(threadId);
      }).pipe(reportFailure("Full access raise failed", threadId));

    /** Left without an age, it reads the database rather than a shared snapshot. */
    const sweep = (maxAgeMs?: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Shell rows carry their pending prompt, so only threads with one are read.
        // acceptPending re-reads each thread's requests, so a shared copy is safe.
        const snapshot = yield* threads.getShellSnapshot({
          location: "active",
          ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        });
        const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
        const waiting = snapshot.threads.filter(
          (thread) =>
            thread.pendingRuntimeRequest !== null &&
            thread.archivedAt === null &&
            thread.deletedAt === null,
        );
        yield* Effect.forEach(
          waiting,
          (thread) => {
            const parentId = thread.lineage.parentThreadId;
            const parent = parentId === null ? undefined : byId.get(parentId);
            return promptRuntimeMode(thread, parent?.runtimeMode) === "full-access"
              ? acceptPending(thread.id, "full-access").pipe(
                  reportFailure("Full access prompt check failed", thread.id),
                )
              : Effect.void;
          },
          { discard: true },
        );
      }).pipe(reportFailure("Full access prompt sweep failed"));

    const process = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
      const handled = (() => {
        switch (event.type) {
          case "runtime-request.updated":
            return isFullAccessPrompt(event.payload) ? acceptPending(event.threadId) : Effect.void;
          // Codex can record an elicitation before its approval item lands;
          // the item's arrival is the moment it can be judged.
          case "turn-item.updated":
            return event.payload.type === "approval_request" &&
              event.payload.requestKind === "mcp-elicitation"
              ? acceptPending(event.threadId)
              : Effect.void;
          case "thread.created":
            return event.payload.runtimeMode === "full-access"
              ? acceptPending(event.threadId, "full-access")
              : Effect.void;
          case "thread.runtime-mode-updated":
            return event.payload.runtimeMode === "full-access"
              ? raised(event.threadId)
              : Effect.void;
          default:
            return Effect.void;
        }
      })();
      return handled.pipe(reportFailure("Full access prompt check failed", event.threadId));
    };

    /** Follows domain events and reopens the stream after it stops or fails. */
    const follow = Effect.gen(function* () {
      let delay = Duration.fromInputUnsafe(options.streamRestartDelay);
      const maxDelay = Duration.minutes(1);
      for (;;) {
        let received = false;
        yield* Stream.runForEach(threads.streamDomainEvents, (event) => {
          received = true;
          return process(event);
        }).pipe(reportFailure("Full access prompt stream stopped"));
        if (received) delay = Duration.fromInputUnsafe(options.streamRestartDelay);
        yield* Effect.logWarning("Full access prompt stream ended; reopening", {
          inMs: Duration.toMillis(delay),
        });
        yield* Effect.sleep(delay);
        delay = Duration.min(Duration.times(delay, 2), maxDelay);
        // Prompts raised while the stream was closed have no event to wait for,
        // and a snapshot shared from before the stream stopped would miss them.
        yield* sweep();
      }
    });

    const start: FullAccessApprovals["Service"]["start"] = () =>
      Effect.gen(function* () {
        const set = yield* FiberSet.make<void, never>();
        retries = set;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (retries === set) retries = undefined;
          }),
        );
        yield* forkParked(
          Effect.all(
            [
              follow,
              // The first sweep answers prompts left over from before this start.
              sweep(SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS).pipe(
                Effect.repeat(Schedule.spaced(options.sweepInterval)),
              ),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        );
      });

    return { start, process, sweep: () => sweep() } satisfies FullAccessApprovals["Service"];
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeWith();

export const layer = Layer.effect(FullAccessApprovals, make);

export const layerWith = (options: Partial<FullAccessApprovalsOptions>) =>
  Layer.effect(FullAccessApprovals, makeWith(options));
