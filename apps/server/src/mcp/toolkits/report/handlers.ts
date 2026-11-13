import { OrchestratorMcpFailure, type ProjectLibraryError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as ThreadReportService from "../../../project/ThreadReportService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ReportToolkit } from "./tools.ts";

const failure = (error: ProjectLibraryError) =>
  new OrchestratorMcpFailure({
    code: error.code === "operation_failed" ? "orchestration_error" : "invalid_request",
    message: error.detail,
  });

/** `[title](/abs/path)`, with the brackets a title may hold escaped. */
export function reportLink(title: string, path: string): string {
  const label = title.replace(/[[\]\\]/g, (char) => `\\${char}`);
  return `[${label}](${path.includes(" ") || path.includes(")") ? `<${path}>` : path})`;
}

export const layer = Access.toLayer(ReportToolkit, {
  studio_report_save: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller, limits } = yield* readCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Reports are saved by an agent running in one of the project's threads.",
        });
      }
      // Saving writes a file, so a thread that asks before each edit, or only plans, cannot
      // save through this tool; its own file tools still ask the person first.
      if (limits.interactionMode === "plan" || limits.runtimeMode === "approval-required") {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "This thread asks before it changes files. Write the report as Markdown in the increment's reports/ folder with your file tools, so the person can approve it.",
        });
      }
      if (input.original !== undefined && input.source === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: 'Name the tool that made the document in source, such as "Claude desktop".',
        });
      }
      const reports = yield* ThreadReportService.ThreadReportService;
      const saved = yield* reports
        .saveForThread({
          projectId: caller.projectId,
          threadId: caller.id,
          text: input.markdown,
          options: {
            title: input.title,
            increment: input.increment,
            provenance:
              input.source === undefined
                ? undefined
                : { source: input.source, original: input.original },
          },
        })
        .pipe(Effect.mapError(failure));
      const path = saved.absolutePath;
      const increment = /^\.specweave\/increments\/([^/]+)\/reports\//.exec(saved.report.path)?.[1];
      return {
        path,
        relativePath: saved.report.path,
        title: saved.title,
        increment: increment ?? null,
        link: reportLink(saved.title, path),
        alreadySaved: saved.alreadySaved,
      };
    }),
  ),
});
