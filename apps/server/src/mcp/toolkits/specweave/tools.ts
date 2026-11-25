/**
 * SpecWeave as studio-code tools (1483): two read-only views of an increment's
 * tasks, wrapping the installed `specweave` CLI in the calling thread's own
 * registered worktree. They run fixed, read-only commands (`task list`,
 * `task next`): no fetch, no Git ref update, no claim, no write. Tools that
 * change state (task done, verify, pickup) are a later increment with their
 * own gates. The sw-* skills stay the way to work outside SpecWithCode.
 */
import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as Invocation from "../../McpInvocationContext.ts";

export const SPECWEAVE_TOOL_PREFIX = "specweave_";

/** An increment number (1483) or its folder name (1483-some-title). */
export const INCREMENT_PATTERN = /^\d{3,5}(?:-[a-z0-9][a-z0-9-]{0,150})?$/;

const Increment = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(160),
  Schema.isPattern(INCREMENT_PATTERN),
).annotate({
  description: "The increment's number (1483) or folder name (1483-some-title).",
});

const Folder = Schema.optional(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)).annotate({
    description:
      "A folder inside this thread's worktree that holds .specweave/, relative to the worktree or absolute. Defaults to the worktree itself. A folder outside it is refused.",
  }),
);

/** What every SpecWeave tool returns. */
const Run = Schema.Struct({
  ok: Schema.Boolean.annotate({ description: "True when the CLI exited 0." }),
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  command: Schema.String.annotate({ description: "The command that ran, for the record." }),
  workspace: Schema.String.annotate({ description: "The folder it read." }),
  data: Schema.Unknown.annotate({
    description: "The CLI's JSON output, parsed, or null when it printed none.",
  }),
  text: Schema.String.annotate({
    description:
      "The CLI's own words when it printed no JSON, or its error output; cut to a few KB.",
  }),
});

const specweaveTool = <const Name extends string, P extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: P,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: Run,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Threads.ThreadManagementService,
      Invocation.McpInvocationContext,
      ProcessRunner.ProcessRunner,
      FileSystem.FileSystem,
      Path.Path,
    ],
  });

const TaskStatusTool = specweaveTool(
  "specweave_task_status",
  "SpecWeave, read-only: list an increment's tasks with their states (open, claimed, done, skipped, blocked), owners and evidence, and its acceptance criteria (`specweave task list <increment> --json`), from this thread's own worktree.",
  {
    increment: Increment,
    folder: Folder,
  },
)
  .annotate(Tool.Title, "SpecWeave task status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const NextTaskTool = specweaveTool(
  "specweave_next_task",
  "SpecWeave, read-only: the next open task in an increment whose dependencies are done and whose Files no live claim holds, with its acceptance criteria (`specweave task next <increment> --json`), from this thread's own worktree. A local view only: it fetches nothing, moves no Git ref and claims nothing; claim with `specweave task claim` in your shell. data.liveClaims lists the tasks claimed now and by whom, including yours.",
  {
    increment: Increment,
    folder: Folder,
  },
)
  .annotate(Tool.Title, "SpecWeave next task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SpecweaveToolkit = Toolkit.make(TaskStatusTool, NextTaskTool);
