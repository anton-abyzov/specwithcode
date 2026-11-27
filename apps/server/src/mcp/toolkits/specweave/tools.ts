/**
 * SpecWeave as studio-code tools. Two read-only views of an increment's tasks
 * (1483) and three ledger writes (1497), wrapping the installed `specweave`
 * CLI in the calling thread's own registered worktree.
 *
 * The reads run fixed, read-only commands (`task list`, `task next`): no
 * fetch, no Git ref update, no claim, no write. The writes run `task claim`,
 * `task release` and `task block` with `--no-commit`, only on the calling
 * thread's own increment (ownership.ts). There is deliberately no done,
 * verify or pickup tool: those run commands, commit or fetch, so agents keep
 * the CLI for them under their own permission mode. The sw-* skills stay the
 * way to work outside SpecWithCode.
 */
import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as IncrementProgress from "../../../project/ThreadIncrementProgressService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
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
  "SpecWeave, read-only: the next open task in an increment whose dependencies are done and whose Files no live claim holds, with its acceptance criteria (`specweave task next <increment> --json`), from this thread's own worktree. A local view only: it fetches nothing, moves no Git ref and claims nothing; claim with specweave_task_claim (or `specweave task claim` in your shell). data.liveClaims lists the tasks claimed now and by whom, including yours.",
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

/** A task id as the spec writes it (T-01). */
export const TASK_ID_PATTERN = /^T-\d{1,4}$/;

const Task = Schema.String.check(Schema.isPattern(TASK_ID_PATTERN)).annotate({
  description: "The task's id as the spec writes it, such as T-03.",
});

const OwnIncrement = Increment.annotate({
  description:
    "This thread's own increment: its number (1483) or folder name. Any other increment is refused.",
});

/** What every SpecWeave ledger write returns. */
const LedgerResult = Schema.Struct({
  changed: Schema.Boolean.annotate({
    description:
      "True when this call wrote a ledger event; false when the task was already in the asked state (a retry).",
  }),
  increment: Schema.String,
  task: Schema.String,
  status: Schema.String.annotate({
    description: "The task's state after the call: open, claimed, blocked, stale, done or skipped.",
  }),
  by: Schema.NullOr(Schema.String).annotate({
    description: "Who holds the task now, as the ledger records it.",
  }),
  agent: Schema.String.annotate({
    description:
      "The SpecWeave agent id this thread writes as, the same as `specweave task whoami` in its shell.",
  }),
  command: Schema.NullOr(Schema.String).annotate({
    description: "The ledger command that ran, or null when nothing needed writing.",
  }),
  workspace: Schema.String.annotate({ description: "The folder whose ledger it changed." }),
  text: Schema.String.annotate({ description: "The CLI's own words, cut to a few KB." }),
});

const ledgerTool = <const Name extends string, P extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: P,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: LedgerResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Threads.ThreadManagementService,
      Invocation.McpInvocationContext,
      ProcessRunner.ProcessRunner,
      IncrementProgress.ThreadIncrementProgressService,
      ServerSettings.ServerSettingsService,
      FileSystem.FileSystem,
      Path.Path,
    ],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false);

const OWNERSHIP =
  "Only for a thread in full-access mode, and only this thread's own increment (the one it was launched with, linked to, or whose spec it wrote), in its own worktree; anything else is refused with the reason. It changes only the increment's ledger: no commit, push, fetch or command.";

const TaskClaimTool = ledgerTool(
  "specweave_task_claim",
  `SpecWeave: claim a task of this thread's increment (\`specweave task claim\`). ${OWNERSHIP} Claiming a task you already hold succeeds without a new event; a task someone else holds is refused with the holder named. Mark it done with \`specweave task done\` in your shell.`,
  { increment: OwnIncrement, task: Task, folder: Folder },
).annotate(Tool.Title, "SpecWeave claim task");

const TaskReleaseTool = ledgerTool(
  "specweave_task_release",
  `SpecWeave: hand back a task this thread holds, so another agent can take it (\`specweave task release\`). ${OWNERSHIP} Releasing a task nobody holds succeeds without a new event; a task someone else holds is refused.`,
  { increment: OwnIncrement, task: Task, folder: Folder },
).annotate(Tool.Title, "SpecWeave release task");

const TaskBlockTool = ledgerTool(
  "specweave_task_block",
  `SpecWeave: mark a task blocked, with the reason (\`specweave task block --reason\`). ${OWNERSHIP} Blocking again with the same reason succeeds without a new event; a task someone else holds is refused.`,
  {
    increment: OwnIncrement,
    task: Task,
    reason: Schema.String.check(
      Schema.isMinLength(3),
      Schema.isMaxLength(500),
      Schema.isPattern(/^[^\r\n]*\S[^\r\n]*$/),
    ).annotate({ description: "Why it is blocked, one line (3 to 500 characters)." }),
    folder: Folder,
  },
).annotate(Tool.Title, "SpecWeave block task");

export const SpecweaveToolkit = Toolkit.make(
  TaskStatusTool,
  NextTaskTool,
  TaskClaimTool,
  TaskReleaseTool,
  TaskBlockTool,
);
