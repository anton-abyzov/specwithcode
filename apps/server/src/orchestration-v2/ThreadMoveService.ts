import {
  CommandId,
  isProjectCoordinatorThreadId,
  isProviderNativeSubagentThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjectMoveLink,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadMoveCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "thread.move-to-project" }
>;

export interface ThreadMoveResult {
  readonly sequence: number;
  readonly targetThreadId: ThreadId;
  readonly started: boolean;
}

/** A move the app refused before or while it ran; `message` is shown to the user. */
export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  commandId: CommandId,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * Moves a thread to another project on this machine by restarting it there.
 *
 * Nothing of the source travels: no messages, provider session, checkpoints,
 * files, worktree, project memory or credentials. The new thread starts in the
 * target project's own folder with that project's settings, and the two
 * threads only link to each other. The source is recorded as moved first, so
 * from then on it refuses new turns (including wakes); then its queue is
 * discarded, the thread archived, its running turn and delegated tasks
 * stopped. A retry with the same command id resumes an interrupted move.
 *
 * A thread outside every project (the Scratch project) has no project folder
 * or memory to leave behind, so it moves as it is: same thread, conversation,
 * folder, runs and queue, only its project changes.
 */
export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    readonly move: (command: ThreadMoveCommand) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("specweave-studio/orchestration-v2/ThreadMoveService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;

  const move = Effect.fn("ThreadMoveService.move")(function* (command: ThreadMoveCommand) {
    const refuse = (message: string) =>
      Effect.fail(new ThreadMoveError({ commandId: command.commandId, message }));
    const failed = (message: string) => (cause: unknown) =>
      new ThreadMoveError({ commandId: command.commandId, message, cause });
    const step = (name: string) => CommandId.make(`${command.commandId}:${name}`);

    // Moving work into another project decides where it runs and what it can
    // reach, so only the user does it. Agents start work elsewhere instead.
    if (command.createdBy !== "user") {
      return yield* refuse("Only you can move a thread to another project.");
    }
    if (command.targetThreadId === command.threadId) {
      return yield* refuse("The new thread needs its own id.");
    }
    const { thread: source } = yield* threads
      .getThreadRecords(command.threadId, [])
      .pipe(Effect.mapError(failed("This thread could not be read.")));
    if (source.deletedAt !== null) return yield* refuse("This thread was deleted.");
    if (isProviderNativeSubagentThread(source)) {
      return yield* refuse("This subagent is run by its provider. Move its parent thread instead.");
    }
    if (source.movedTo != null && source.movedTo.threadId !== command.targetThreadId) {
      return yield* refuse(`This thread already moved to "${source.movedTo.title}".`);
    }
    if (source.projectId === command.targetProjectId) {
      return yield* refuse("This thread is already in that project.");
    }
    const sourceProject = yield* projects
      .getById(source.projectId, { includeDeleted: true })
      .pipe(Effect.mapError(failed("This thread's project could not be read.")));
    if (
      Option.isSome(sourceProject) &&
      isProjectCoordinatorThreadId(command.threadId, sourceProject.value)
    ) {
      return yield* refuse(
        "A project's coordinator stays with its project. Start a new thread in the other project instead.",
      );
    }
    const targetProject = yield* projects
      .getById(command.targetProjectId)
      .pipe(Effect.mapError(failed("That project could not be read.")));
    if (Option.isNone(targetProject)) {
      return yield* refuse("That project is not on this machine.");
    }
    const target = targetProject.value;
    if (target.workspaceSettings?.archived || target.workspaceSettings?.paused) {
      return yield* refuse(`Resume or restore ${target.title} before moving threads into it.`);
    }

    if (yield* folders.isScratch(source.projectId)) {
      const adopted = yield* threads
        .dispatch({
          type: "thread.project.adopt",
          commandId: step("adopt"),
          threadId: command.threadId,
          fromProjectId: source.projectId,
          projectId: target.id,
        })
        .pipe(Effect.mapError(failed(`This chat could not be moved to ${target.title}.`)));
      return { sequence: adopted.sequence, targetThreadId: command.threadId, started: false };
    }

    // 1. The fresh thread, created like any new thread in the target project.
    yield* launches
      .launch({
        commandId: step("create"),
        threadId: command.targetThreadId,
        projectId: target.id,
        title: source.title,
        modelSelection: target.defaultModelSelection ?? source.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: command.creationSource,
      })
      .pipe(Effect.mapError(failed(`The new thread in ${target.title} could not be created.`)));
    // A retry resumes the thread created first; it must be the project asked for.
    const { thread: created } = yield* threads
      .getThreadRecords(command.targetThreadId, [])
      .pipe(Effect.mapError(failed("The new thread could not be read.")));
    if (created.projectId !== target.id) {
      return yield* refuse("This move already started into another project. Close and try again.");
    }

    const movedAt = DateTime.formatIso(yield* DateTime.now);
    const fromLink: OrchestrationV2ThreadProjectMoveLink = {
      threadId: source.id,
      projectId: source.projectId,
      title: source.title,
      movedAt,
    };
    const toLink: OrchestrationV2ThreadProjectMoveLink = {
      threadId: command.targetThreadId,
      projectId: target.id,
      title: source.title,
      movedAt,
    };
    yield* threads
      .dispatch({
        type: "thread.project-move.record",
        commandId: step("record-target"),
        threadId: command.targetThreadId,
        side: "target",
        link: fromLink,
      })
      .pipe(Effect.mapError(failed("The new thread could not be linked to this one.")));

    // 2. The source refuses new turns, loses its queue and is archived (an
    //    already archived source is only marked moved).
    const recorded = yield* threads
      .dispatch({
        type: "thread.project-move.record",
        commandId: step("record-source"),
        threadId: command.threadId,
        side: "source",
        link: toLink,
      })
      .pipe(Effect.mapError(failed("This thread could not be marked as moved.")));

    // 3. Its running turn and delegated tasks stop; nothing of it resumes.
    const reason = `Moved to ${target.title} as a fresh thread.`;
    const stopped = yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: step("stop"),
        threadId: command.threadId,
        reason,
      })
      .pipe(Effect.mapError(failed("This thread was moved but could not be stopped. Stop it.")));
    yield* threads
      .stopDelegatedTasks({ commandId: step("stop"), threadId: command.threadId, reason })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("A moved thread's delegated task did not stop", {
            threadId: command.threadId,
            error,
          }),
        ),
      );

    // 4. Optionally the opening request, only once the source can no longer run.
    let sequence = Math.max(recorded.sequence, stopped.sequence);
    if (command.start !== undefined) {
      const sent = yield* threads
        .sendToThread({
          projectId: target.id,
          commandId: step("start"),
          threadId: command.targetThreadId,
          messageId: command.start.messageId,
          text: command.start.text,
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: command.creationSource,
        })
        .pipe(
          Effect.mapError(
            failed("The thread moved, but its opening request did not start. Send it again."),
          ),
        );
      sequence = Math.max(sequence, sent.dispatch.sequence);
    }
    return {
      sequence,
      targetThreadId: command.targetThreadId,
      started: command.start !== undefined,
    };
  });

  return ThreadMoveService.of({ move });
});

export const layer = Layer.effect(ThreadMoveService, make);
