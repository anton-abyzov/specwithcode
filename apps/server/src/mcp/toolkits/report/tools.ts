import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import { MAX_SAVED_REPORT_BYTES } from "@specweave-studio/shared/threadReport";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadReportService from "../../../project/ThreadReportService.ts";
import * as Invocation from "../../McpInvocationContext.ts";

export const REPORT_SAVE_TOOL_NAME = "studio_report_save";

/**
 * Reports belong to SpecWithCode whatever the provider: a file in the project
 * that opens in the app's own viewer, never a page on a provider's site.
 */
const ReportSaveTool = Tool.make(REPORT_SAVE_TOOL_NAME, {
  description:
    "Save a report or document as a SpecWithCode report: a Markdown file in this project's SpecWeave reports (the named increment's reports/ folder, else this thread's increment, else .specweave/reports/threads/). It opens in SpecWithCode's document viewer and lists on the project's Artifacts shelf, for every provider and machine. Use it for a report you wrote, and to bring in a document another tool made (Claude desktop, Codex, Cursor, ChatGPT): read it with your own access to that tool, pass its Markdown with source and original, then link the returned file in your reply, never the original page. Flat front matter in the Markdown is kept. Saving the same text again returns the same file.",
  parameters: Schema.Struct({
    markdown: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_SAVED_REPORT_BYTES),
    ).annotate({ description: "The report as Markdown, up to 512 KiB." }),
    title: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
        description: "The title to file it under; defaults to its own title or first heading.",
      }),
    ),
    increment: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
        description:
          "An increment number (1314) or folder to save it in, or \"none\" for the project's thread reports. Defaults to this thread's increment.",
      }),
    ),
    source: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)).annotate({
        description:
          'For a document another tool made: that tool, such as "Claude desktop" or "Codex". Saved as a property.',
      }),
    ),
    original: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
        description:
          "For a document another tool made: its https link there. Saved as a property only; requires source.",
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String.annotate({ description: "The saved file's absolute path." }),
    relativePath: Schema.String,
    title: Schema.String,
    increment: Schema.NullOr(Schema.String),
    link: Schema.String.annotate({
      description: "Ready-made Markdown link to the saved file. Put it in your reply as is.",
    }),
    alreadySaved: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    ThreadReportService.ThreadReportService,
    Threads.ThreadManagementService,
    Invocation.McpInvocationContext,
  ],
})
  .annotate(Tool.Title, "Save report")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ReportToolkit = Toolkit.make(ReportSaveTool);
