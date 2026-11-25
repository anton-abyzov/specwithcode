/**
 * SpecWeave as studio-code tools (1483): the four commands an agent runs most,
 * wrapping the installed `specweave` CLI in the calling thread's own
 * workspace. The sw-* skills stay the way to work outside SpecWithCode.
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
/** A task id as the ledger writes it. */
export const TASK_PATTERN = /^T-\d{1,4}$/;

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
      "A folder inside this thread's workspace that holds .specweave/, relative to the workspace or absolute. Defaults to the workspace itself. A folder outside the workspace is refused.",
  }),
);

/** What every SpecWeave tool returns. */
const Run = Schema.Struct({
  ok: Schema.Boolean.annotate({ description: "True when the CLI exited 0." }),
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  command: Schema.String.annotate({ description: "The command that ran, for the record." }),
  workspace: Schema.String.annotate({ description: "The folder it ran in." }),
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

const PickupTool = specweaveTool(
  "specweave_pickup",
  "SpecWeave: show the next task to work on in this thread's workspace, with its acceptance criteria and any handoff note (`specweave pickup --json --no-apply`). Never applies a handoff's files. Name an increment to pick it, else the newest handoff is shown.",
  {
    increment: Schema.optional(Increment),
    folder: Folder,
  },
)
  .annotate(Tool.Title, "SpecWeave pickup")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TaskStatusTool = specweaveTool(
  "specweave_task_status",
  "SpecWeave: list an increment's tasks with their states (open, claimed, done, skipped, blocked), owners and evidence (`specweave task list <increment> --json`).",
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

const TaskDoneTool = specweaveTool(
  "specweave_task_done",
  "SpecWeave: mark a task done with evidence (`specweave task done <task> <increment> --evidence <text> --json`). Run the task's Test yourself first and pass what proves it: the command and its result, a commit, a report path. It never runs a command and never overrides another agent's claim. The project's SpecWeave settings decide whether the increment files are committed.",
  {
    increment: Increment,
    task: Schema.String.check(Schema.isPattern(TASK_PATTERN)).annotate({
      description: "The task id, such as T-03.",
    }),
    evidence: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)).annotate({
      description:
        "What proves the task is done: the test command and its result, a commit, a report path.",
    }),
    folder: Folder,
  },
)
  .annotate(Tool.Title, "SpecWeave task done")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const VerifyTool = specweaveTool(
  "specweave_verify",
  "SpecWeave: run the project's configured test, lint and build commands for an increment and return the verify report (`specweave verify <increment> --json`; it writes reports/verify.json). This can take many minutes: progress is reported while it runs, and cancelling the call stops it.",
  {
    increment: Increment,
    folder: Folder,
    timeoutMinutes: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })).annotate({
        description: "Stop the run after this many minutes. Default 30.",
      }),
    ),
  },
)
  .annotate(Tool.Title, "SpecWeave verify")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SpecweaveToolkit = Toolkit.make(PickupTool, TaskStatusTool, TaskDoneTool, VerifyTool);
