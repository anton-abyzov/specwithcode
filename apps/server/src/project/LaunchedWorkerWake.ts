/**
 * Wakes the thread that started a top-level worker on this machine
 * (studio_thread_launch, create_threads) when one of the worker's runs ends,
 * as RemoteWorkerFollower does for a worker on another machine. Without it a
 * coordinator that launched local workers and promised a summary was never
 * told they finished.
 *
 * The launcher is the thread that sent the worker's first message. Delegated
 * children report through their own task wake, and threads people started,
 * or another machine started, have no launcher here.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@specweave-studio/contracts";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectService from "./ProjectService.ts";

export const LAUNCHED_WORKER_WAKE_PREFIX = "launched-worker-wake:";

/**
 * How long a failed run waits before it is reported, in case the automatic
 * fallback starts a newer run in the same thread (its sweep runs every 30s).
 */
export const FAILED_RUN_GRACE = Duration.seconds(90);

/** Runs that end the work the launcher waits for; a stop or a restart does not. */
const reportedStatus = (status: OrchestrationV2Run["status"]) =>
  status === "completed" || status === "failed";

/** A top-level thread an agent in a thread here started through the MCP tools. */
const launchedByAgent = (shell: OrchestrationV2ThreadShell) =>
  shell.lineage.parentThreadId === null &&
  shell.createdBy === "agent" &&
  shell.creationSource === "mcp" &&
  shell.origin === undefined &&
  shell.deletedAt === null;

export function launchedWorkerWake(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly status: "completed" | "failed";
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const link = formatStudioThreadLink(input.threadId, input.title.slice(0, 200) || "worker");
  return {
    text: `Worker ${link} finished: ${input.status}. Read it with studio_thread_read {threadId:"${input.threadId}"}.`,
    notification: {
      source: { kind: "background_task" },
      outcome: input.status,
      summary: `${link} reported back.`,
    },
  };
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;

  /** The thread that sent `threadId`'s first message, if an agent's thread did. */
  const launcherOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user"],
      });
      const first = messages.reduce<(typeof messages)[number] | undefined>(
        (earliest, message) =>
          earliest === undefined || DateTime.isLessThan(message.createdAt, earliest.createdAt)
            ? message
            : earliest,
        undefined,
      );
      return first?.createdBy === "agent" && first.senderThreadId !== threadId
        ? first.senderThreadId
        : undefined;
    });

  const observeRun = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (run.status !== "completed" && run.status !== "failed") return;
      const status = run.status;
      const worker = yield* threads.getThreadShell(run.threadId);
      if (worker === null || !launchedByAgent(worker)) return;
      const launcherId = yield* launcherOf(run.threadId);
      if (launcherId === undefined) return;
      if (status === "failed") {
        yield* Effect.sleep(FAILED_RUN_GRACE);
        const latest = yield* threads.getThreadShell(run.threadId);
        // The fallback's own run reports when it ends.
        if (latest === null || latest.latestRunId !== run.id) return;
      }
      const launcher = yield* threads.getThreadShell(launcherId);
      if (
        launcher === null ||
        launcher.deletedAt !== null ||
        launcher.archivedAt !== null ||
        // A delegated child is not woken; a fork is a top-level thread of its own.
        launcher.lineage.relationshipToParent === "subagent"
      )
        return;
      const project = Option.getOrUndefined(yield* projects.getById(launcher.projectId));
      if (project?.workspaceSettings?.paused || project?.workspaceSettings?.archived) return;
      const message = launchedWorkerWake({ threadId: worker.id, title: worker.title, status });
      // One wake per run: the orchestrator ignores a command id it already took.
      const id = `${LAUNCHED_WORKER_WAKE_PREFIX}${run.id}`;
      yield* threads.sendToThread({
        projectId: launcher.projectId,
        commandId: CommandId.make(id),
        threadId: launcher.id,
        messageId: MessageId.make(id),
        text: message.text,
        notification: message.notification,
        attachments: [],
        // Never interrupts what the launcher is doing.
        mode: "queue",
        // The orchestrator shows a server's queued agent-facing message as a notice.
        createdBy: "agent",
        creationSource: "server",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not wake the thread that launched a worker.", {
          threadId: run.threadId,
          runId: run.id,
          cause,
        }),
      ),
    );

  return { observeRun };
});

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const reactor = yield* make;
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "run.updated" && reportedStatus(event.payload.status),
      ),
      // A failed run waiting out its fallback grace must not hold up the others,
      // however many fail at once (a usage limit stops a whole fleet together).
      Stream.mapEffect(
        (event) => (event.type === "run.updated" ? reactor.observeRun(event.payload) : Effect.void),
        { concurrency: "unbounded", unordered: true },
      ),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logWarning("Launched worker wake event stream failed", { cause }),
      ),
    ),
  );
});
