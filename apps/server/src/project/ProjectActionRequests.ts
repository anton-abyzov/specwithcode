/**
 * Project changes an agent may ask for but never make itself: archive,
 * restore, delete, or move to another folder. The agent's request shows an
 * approval card in its thread. Only the user's answer, which reaches the server
 * through the app's own connection, applies the change: the server applies it
 * and then tells the agent what happened. An agent cannot answer the card.
 * Every request and decision is kept in `project_action_requests`.
 */
import {
  CommandId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2UserInputQuestion,
  type Project,
  ProjectFolderCheckError,
  type ProjectId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { folderChangeRefusal, ProjectFolderService } from "./ProjectFolderChange.ts";
import * as ProjectService from "./ProjectService.ts";
import { PROJECT_ACTION_REQUEST_PREFIX } from "./projectActionRequestId.ts";

export { isProjectActionRequestId } from "./projectActionRequestId.ts";

export const ProjectAction = Schema.Literals(["archive", "unarchive", "delete", "change_folder"]);
export type ProjectAction = typeof ProjectAction.Type;

const QUESTION_ID = "approval";
const APPROVE = "Approve";
const DECLINE = "Decline";

export class ProjectActionRequestError extends Schema.TaggedError<ProjectActionRequestError>()(
  "ProjectActionRequestError",
  { message: Schema.String },
) {}

export interface ProjectActionRequestInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly action: ProjectAction;
  readonly reason: string;
  /** Required for change_folder. */
  readonly workspaceRoot?: string;
}

interface RequestRow {
  readonly requestId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly action: ProjectAction;
  readonly paramsJson: string;
  readonly reason: string;
  readonly status: string;
}

const Params = Schema.fromJsonString(
  Schema.Struct({
    workspaceRoot: Schema.optional(Schema.String),
    title: Schema.String,
  }),
);
const decodeParams = Schema.decodeUnknownSync(Params);
const encodeParams = Schema.encodeSync(Params);

type RespondCommand = Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>;

export class ProjectActionRequests extends Context.Service<
  ProjectActionRequests,
  {
    /** Shows the approval card in the requesting thread and returns at once. */
    readonly request: (
      input: ProjectActionRequestInput,
    ) => Effect.Effect<{ readonly requestId: RuntimeRequestId }, ProjectActionRequestError>;
    /** The user's answer to a card: applies an approved change, then resolves the card. */
    readonly answer: (
      command: RespondCommand,
    ) => Effect.Effect<{ readonly sequence: number }, Orchestrator.OrchestratorV2Error>;
    /** The user dismissed the card without answering. */
    readonly dismissed: (requestId: RuntimeRequestId) => Effect.Effect<void>;
  }
>()("specweave-studio/project/ProjectActionRequests") {}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ProjectFolderService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const failure = (message: string) => new ProjectActionRequestError({ message });

  const readProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => failure("The project could not be read. Try again.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("The project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const countThreads = (projectId: ProjectId) =>
    threads.getShellSnapshot().pipe(
      Effect.map(
        (snapshot) =>
          [...snapshot.threads, ...snapshot.archivedThreads].filter(
            (thread) => thread.projectId === projectId && thread.deletedAt === null,
          ).length,
      ),
      Effect.orElseSucceed(() => 0),
    );

  /** The card's question: what will happen, in the user's terms, and why the agent asked. */
  const describe = Effect.fn("ProjectActionRequests.describe")(function* (
    input: ProjectActionRequestInput,
    project: Project,
  ) {
    const name = `"${project.title}"`;
    const why = `Reason: ${input.reason}`;
    switch (input.action) {
      case "archive":
        if (project.workspaceSettings?.archived)
          return yield* failure(`The project ${name} is already archived.`);
        return `Archive the project ${name}?\n\nIts threads, memory and folder are kept, and it stops taking new work until you restore it.\n\n${why}`;
      case "unarchive":
        if (!project.workspaceSettings?.archived)
          return yield* failure(`The project ${name} is not archived.`);
        return `Restore the archived project ${name}?\n\nIts threads can take new work again.\n\n${why}`;
      case "delete": {
        const count = yield* countThreads(project.id);
        return `Delete the project ${name} and its ${plural(count, "thread")}?\n\nThis cannot be undone. Project memory, plans and routines are removed; source folders and Git branches stay. Archiving keeps everything instead.\n\n${why}`;
      }
      case "change_folder": {
        if (input.workspaceRoot === undefined)
          return yield* failure("Pass workspaceRoot: the folder the project should use.");
        const check = yield* folders
          .check({ projectId: project.id, workspaceRoot: input.workspaceRoot })
          .pipe(Effect.mapError((error) => failure(error.message)));
        if (check.unchanged) return yield* failure(`The project already uses ${check.targetRoot}.`);
        // The asking thread is running now; work still running when the user approves is refused then.
        const hardRefusal = folderChangeRefusal({ ...check, activeThreads: [] }, true);
        if (hardRefusal !== null) return yield* failure(hardRefusal.detail);
        const repository = check.sameRepository
          ? `Both folders are checkouts of ${check.targetRepository}.`
          : `The new folder ${check.targetRepository === null ? "has no Git remote" : `is a checkout of ${check.targetRepository}`}, and the current one ${check.currentRepository === null ? "has none" : `is ${check.currentRepository}`}. Approving confirms it is the right folder.`;
        return `Change the folder of the project ${name} from ${check.currentRoot} to ${check.targetRoot}?\n\n${repository} Its ${plural(check.threadCount, "thread")}, memory and history stay with the project and run in the new folder from their next turn.\n\n${why}`;
      }
    }
  });

  const request: ProjectActionRequests["Service"]["request"] = Effect.fn(
    "ProjectActionRequests.request",
  )(function* (input) {
    const project = yield* readProject(input.projectId);
    const question = yield* describe(input, project);
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError(() => failure("The asking thread could not be read.")));
    const run = ThreadManagement.latestActiveRun(records);
    if (run === undefined || run.rootNodeId === null)
      return yield* failure("Asking for approval needs an active run in the asking thread.");
    const key = yield* randomUuidV4;
    const requestId = RuntimeRequestId.make(`${PROJECT_ACTION_REQUEST_PREFIX}${key}`);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO project_action_requests (
        request_id, thread_id, project_id, action, params_json, reason, requested_by, status, created_at
      ) VALUES (
        ${requestId}, ${input.threadId}, ${project.id}, ${input.action},
        ${encodeParams({ title: project.title, ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }) })},
        ${input.reason}, ${input.threadId}, 'pending', ${now}
      )`.pipe(Effect.mapError(() => failure("The request could not be recorded.")));
    const card: OrchestrationV2UserInputQuestion = {
      id: QUESTION_ID,
      header: "Approval",
      question,
      options: [
        { label: APPROVE, description: "SpecWithCode makes the change and tells the agent." },
        { label: DECLINE, description: "Nothing changes." },
      ],
      allowCustomAnswer: false,
    };
    yield* threads
      .dispatch({
        type: "user_input_request.record",
        commandId: CommandId.make(`${requestId}:record`),
        threadId: input.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        requestNodeId: NodeId.make(`node:${requestId}`),
        requestId,
        turnItemId: TurnItemId.make(`turn-item:${requestId}`),
        questions: [card],
      })
      .pipe(
        Effect.tapError(() =>
          sql`UPDATE project_action_requests SET status = 'failed', outcome = 'The approval card could not be shown.' WHERE request_id = ${requestId}`.pipe(
            Effect.ignore,
          ),
        ),
        Effect.mapError(() => failure("The approval card could not be shown. Try again.")),
      );
    yield* Effect.logInfo("project.action.requested", {
      requestId,
      projectId: project.id,
      action: input.action,
      threadId: input.threadId,
    });
    return { requestId };
  });

  const record = (requestId: string, status: string, outcome: string) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE project_action_requests SET status = ${status}, outcome = ${outcome}, decided_at = ${now} WHERE request_id = ${requestId}`;
      yield* Effect.logInfo("project.action.decided", { requestId, status, outcome });
    }).pipe(Effect.ignore);

  /** Applies an approved change as the user. Returns the sentence the agent and the card show. */
  const apply = Effect.fn("ProjectActionRequests.apply")(function* (
    row: RequestRow,
    approvalRequestId: RuntimeRequestId,
  ) {
    const params = decodeParams(row.paramsJson);
    const projectId = row.projectId as ProjectId;
    const name = `"${params.title}"`;
    const commandId = CommandId.make(`${row.requestId}:apply`);
    switch (row.action) {
      case "archive":
      case "unarchive": {
        const archived = row.action === "archive";
        const project = yield* projects.getById(projectId);
        if (Option.isNone(project)) return yield* failure(`The project ${name} no longer exists.`);
        yield* projects.update({
          commandId,
          projectId,
          workspaceSettings: {
            expectedRevision: project.value.workspaceSettings?.revision ?? 0,
            archived,
          },
        });
        return archived
          ? `Archived the project ${name}. Its threads, memory and folder are kept; restore it from project settings.`
          : `Restored the project ${name}.`;
      }
      case "delete": {
        const project = yield* projects.getById(projectId);
        if (Option.isNone(project)) return yield* failure(`The project ${name} no longer exists.`);
        yield* projects.delete({
          commandId,
          projectId,
          force: true,
          confirmationTitle: project.value.title,
          approvalRequestId,
        });
        return `Deleted the project ${name} and its threads.`;
      }
      case "change_folder": {
        if (params.workspaceRoot === undefined)
          return yield* failure("The request named no folder.");
        const changed = yield* folders.change({
          commandId,
          projectId,
          workspaceRoot: params.workspaceRoot,
          // The card told the user when the repository differs; approving confirms it.
          confirmDifferentRepository: true,
          approvalRequestId,
        });
        return `Changed the folder of ${name} from ${changed.previousRoot} to ${changed.project.workspaceRoot}. Threads run there from their next turn.`;
      }
    }
  });

  const failureText = (cause: unknown) =>
    cause instanceof ProjectActionRequestError || cause instanceof ProjectFolderCheckError
      ? cause.message
      : ProjectService.projectMutationErrorMessage(cause);

  const answer: ProjectActionRequests["Service"]["answer"] = Effect.fn(
    "ProjectActionRequests.answer",
  )(function* (command: RespondCommand) {
    const rows = yield* sql<RequestRow>`SELECT request_id AS "requestId", thread_id AS "threadId",
        project_id AS "projectId", action, params_json AS "paramsJson", reason, status
      FROM project_action_requests WHERE request_id = ${command.requestId}`.pipe(
      Effect.orElseSucceed((): ReadonlyArray<RequestRow> => []),
    );
    const row = rows[0];
    // Unknown, already decided or another thread's card: the orchestrator reports it as usual.
    if (row === undefined || row.status !== "pending" || row.threadId !== command.threadId)
      return yield* threads.dispatch(command);
    const choice = command.answers?.[QUESTION_ID];
    const approved = choice === APPROVE;
    const resolve = (text: string) =>
      threads.dispatch({
        type: "runtime-request.respond",
        commandId: command.commandId,
        threadId: command.threadId,
        requestId: command.requestId,
        answers: { [QUESTION_ID]: text },
      });
    if (!approved) {
      const text = `${DECLINE}. Nothing changed.`;
      yield* record(row.requestId, "declined", text);
      return yield* resolve(text);
    }
    const requester = yield* threads
      .getThreadShell(command.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const ownProject = requester?.projectId === row.projectId;
    // Archiving the asking thread's own project stops it taking messages, so the
    // agent hears the decision first.
    if (row.action === "archive" && ownProject) {
      const result = yield* resolve(
        `${APPROVE}. Archiving the project now; its threads stop taking new work.`,
      );
      const outcome = yield* apply(row, command.requestId).pipe(Effect.result);
      yield* Result.isSuccess(outcome)
        ? record(row.requestId, "approved", outcome.success)
        : record(row.requestId, "failed", failureText(outcome.failure));
      return result;
    }
    const outcome = yield* apply(row, command.requestId).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      const text = `${APPROVE}, but nothing changed: ${failureText(outcome.failure)}`;
      yield* record(row.requestId, "failed", text);
      return yield* resolve(text);
    }
    yield* record(row.requestId, "approved", outcome.success);
    // Deleting its own project deleted the asking thread too; there is no one left to tell.
    if (row.action === "delete" && ownProject) return { sequence: 0 };
    return yield* resolve(`${APPROVE}. ${outcome.success}`);
  });

  const dismissed: ProjectActionRequests["Service"]["dismissed"] = (requestId) =>
    record(requestId, "dismissed", "The user dismissed the card. Nothing changed.");

  return ProjectActionRequests.of({ request, answer, dismissed });
});

export const layer = Layer.effect(ProjectActionRequests, make);
