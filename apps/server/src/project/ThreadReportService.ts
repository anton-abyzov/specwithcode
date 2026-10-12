/**
 * Thread reports for the project UI: which reports of a thread are saved and
 * where, saving one on request, and saving a delegated worker's long final
 * report automatically when it matches a SpecWeave increment.
 */
import {
  ProjectLibraryError,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ProjectThreadReportSaveInput,
  type ProjectThreadReportsInput,
  type ProjectThreadReportsSnapshot,
  type ThreadId,
} from "@specweave-studio/contracts";
import { makeDrainableWorker } from "@specweave-studio/shared/DrainableWorker";
import { shouldCollapseReport } from "@specweave-studio/shared/threadReport";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ProjectLibraryProblem } from "./ProjectLibrary.ts";
import {
  readThreadReports,
  resolveReportIncrement,
  saveThreadReport,
  type ThreadReportSource,
} from "./ThreadReports.ts";

export class ThreadReportService extends Context.Service<
  ThreadReportService,
  {
    readonly read: (
      input: ProjectThreadReportsInput,
    ) => Effect.Effect<ProjectThreadReportsSnapshot, ProjectLibraryError>;
    readonly save: (
      input: ProjectThreadReportSaveInput,
    ) => Effect.Effect<ProjectThreadReportsSnapshot, ProjectLibraryError>;
    /** Saves a finished worker's report when it is long and its increment is known. */
    readonly saveFinishedReport: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<void>;
  }
>()("studio/project/ThreadReportService") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const failure =
    (projectId: ProjectId) =>
    (error: unknown): ProjectLibraryError =>
      error instanceof ProjectLibraryError
        ? error
        : error instanceof ProjectLibraryProblem
          ? new ProjectLibraryError({ projectId, code: error.code, detail: error.message })
          : new ProjectLibraryError({
              projectId,
              code: "operation_failed",
              detail: "The report could not be read or saved. Try again.",
            });

  /** The thread and its project's folder, checking the thread belongs to that project. */
  const locate = (projectId: ProjectId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const notFound = new ProjectLibraryError({
        projectId,
        code: "not_found",
        detail: "This thread is no longer in the project.",
      });
      const project = yield* projects.get(projectId);
      if (Option.isNone(project)) return yield* notFound;
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || thread.projectId !== projectId) return yield* notFound;
      const source: ThreadReportSource = {
        threadId,
        title: thread.title,
        branch: thread.branch,
      };
      return { workspaceRoot: project.value.workspaceRoot, source };
    }).pipe(Effect.mapError(failure(projectId)));

  const read = (input: ProjectThreadReportsInput) =>
    locate(input.projectId, input.threadId).pipe(
      Effect.flatMap(({ workspaceRoot, source }) =>
        Effect.tryPromise({
          try: () => readThreadReports(workspaceRoot, source),
          catch: failure(input.projectId),
        }),
      ),
    );

  const save = (input: ProjectThreadReportSaveInput) =>
    locate(input.projectId, input.threadId).pipe(
      Effect.flatMap(({ workspaceRoot, source }) =>
        Effect.tryPromise({
          try: () => saveThreadReport(workspaceRoot, source, input.text),
          catch: failure(input.projectId),
        }),
      ),
    );

  const saveFinishedReport = (input: { readonly threadId: ThreadId; readonly text: string }) =>
    Effect.gen(function* () {
      if (!shouldCollapseReport(input.text)) return;
      const thread = yield* projections.getThreadShell(input.threadId);
      if (thread === null) return;
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return;
      const source: ThreadReportSource = {
        threadId: input.threadId,
        title: thread.title,
        branch: thread.branch,
      };
      const root = project.value.workspaceRoot;
      yield* Effect.tryPromise(async () => {
        // Only a report tied to an increment is filed on its own; the rest wait for the person.
        const saved = await readThreadReports(root, source);
        const increment =
          saved.increment?.id ?? (await resolveReportIncrement(root, source, input.text));
        if (!saved.specweave || increment === null) return;
        await saveThreadReport(root, source, input.text, undefined, { resolveFromText: true });
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread report save failed", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return ThreadReportService.of({ read, save, saveFinishedReport });
});

export const layer = Layer.effect(ThreadReportService, make);

/** A worker's final report, when this event is its delegated task finishing. */
export function finishedWorkerReport(
  event: OrchestrationV2DomainEvent,
): { readonly threadId: ThreadId; readonly text: string } | null {
  if (event.type !== "subagent.updated") return null;
  const task = event.payload;
  if (
    task.origin !== "app_owned" ||
    task.status !== "completed" ||
    task.childThreadId === null ||
    task.result === null
  ) {
    return null;
  }
  return { threadId: task.childThreadId, text: task.result };
}

/** Files each finished worker's long report beside its increment, off the event path. */
export const startReportFiling = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const reports = yield* ThreadReportService;
  const seen = new Set<string>();
  const worker = yield* makeDrainableWorker(
    (report: { readonly threadId: ThreadId; readonly text: string }) =>
      reports.saveFinishedReport(report),
  );
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      const report = finishedWorkerReport(event);
      if (report === null) return Effect.void;
      // A task's terminal update can repeat; file each result once per server run.
      const key = `${report.threadId}\n${report.text.length}\n${report.text.slice(0, 200)}`;
      if (seen.has(key)) return Effect.void;
      seen.add(key);
      if (seen.size > 2_000) seen.delete(seen.values().next().value!);
      return worker.enqueue(report);
    }),
  );
});
