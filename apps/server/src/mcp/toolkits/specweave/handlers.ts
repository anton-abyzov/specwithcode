import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpProgress from "../../McpProgress.ts";
import * as Access from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { runSpecweave } from "./cli.ts";
import { SpecweaveToolkit } from "./tools.ts";
import { resolveCallerWorkspace, type CallerWorkspaceInput } from "./workspace.ts";

const READ_TIMEOUT = Duration.minutes(2);
const DONE_TIMEOUT = Duration.minutes(5);
const VERIFY_DEFAULT_MINUTES = 30;
const PROGRESS_EVERY = Duration.seconds(10);
const PROGRESS_TICK = Duration.seconds(1);

const refuse = (
  code: "capability_denied" | "invalid_request" | "thread_not_found",
  message: string,
) => new OrchestratorMcpFailure({ code, message });

/**
 * The calling thread's worktree and project folder. Only a thread caller has
 * a workspace; an outside client is refused.
 */
export const callerWorkspaceInput = Effect.fn("specweaveTools.callerWorkspaceInput")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* refuse(
      "capability_denied",
      "SpecWeave tools run in a SpecWithCode thread's own workspace; this caller has none.",
    );
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) {
    return yield* refuse("thread_not_found", "The calling thread was not found.");
  }
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  // A thread with a worktree runs there; the project folder matters only without one.
  const project =
    shell.worktreePath !== null || Option.isNone(projects)
      ? null
      : yield* projects.value.getById(shell.projectId).pipe(
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        );
  return {
    worktreePath: shell.worktreePath,
    projectRoot: project?.workspaceRoot ?? null,
  } satisfies CallerWorkspaceInput;
});

const workspaceFor = (folder: string | undefined) =>
  Effect.gen(function* () {
    const input = yield* callerWorkspaceInput();
    const resolved = yield* Effect.promise(() => resolveCallerWorkspace({ ...input, folder }));
    if (!resolved.ok) {
      return yield* refuse(
        resolved.reason === "no-workspace" ? "thread_not_found" : "invalid_request",
        resolved.message,
      );
    }
    return resolved;
  });

/**
 * Tools that write or run commands go around the provider's own approvals,
 * so a thread that plans, or asks before each change, runs the CLI in its
 * shell instead, where the person approves it.
 */
const refuseUnlessMayChange = (command: string) =>
  Effect.gen(function* () {
    const { limits } = yield* loadCaller();
    if (limits.interactionMode === "plan") {
      return yield* refuse(
        "capability_denied",
        `Plan mode changes nothing. Once the plan is approved, call this again or run \`${command}\` in your shell.`,
      );
    }
    if (limits.runtimeMode === "approval-required") {
      return yield* refuse(
        "capability_denied",
        `This thread asks before it runs commands. Run \`${command}\` in your shell so the person can approve it.`,
      );
    }
  });

/**
 * While a long run goes on, sends a progress line when it prints something
 * new (at most once a second) and at least every ten seconds.
 */
const reportWhileRunning = <A, E, R>(
  label: string,
  latest: () => string,
  run: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const progress = yield* Effect.serviceOption(McpProgress.McpProgress);
    if (Option.isNone(progress)) return yield* run;
    const started = yield* Clock.currentTimeMillis;
    let sentLine = "";
    let sentAt = started;
    const send = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const line = latest();
      sentLine = line;
      sentAt = now;
      const seconds = Math.round((now - started) / 1000);
      const message = `${label}: ${seconds} s${line === "" ? "" : `, ${line}`}`;
      yield* progress.value.report({
        // Milliseconds, so two updates within one second still increase.
        progress: now - started,
        message: message.slice(0, McpProgress.MAX_PROGRESS_MESSAGE_CHARS),
      });
    });
    const tick = Effect.gen(function* () {
      yield* Effect.sleep(PROGRESS_TICK);
      const now = yield* Clock.currentTimeMillis;
      if (latest() !== sentLine || now - sentAt >= Duration.toMillis(PROGRESS_EVERY)) yield* send;
    });
    yield* send;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(Effect.forever(tick));
        return yield* run;
      }),
    );
  });

export const layer = Access.toLayer(SpecweaveToolkit, {
  specweave_pickup: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const where = yield* workspaceFor(input.folder);
      return yield* runSpecweave({
        specweaveRoot: where.specweaveRoot,
        args: [
          "pickup",
          ...(input.increment === undefined ? [] : [input.increment]),
          "--json",
          "--no-apply",
        ],
        timeout: READ_TIMEOUT,
      });
    }),
  ),
  specweave_task_status: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const where = yield* workspaceFor(input.folder);
      return yield* runSpecweave({
        specweaveRoot: where.specweaveRoot,
        args: ["task", "list", input.increment, "--json"],
        timeout: READ_TIMEOUT,
      });
    }),
  ),
  specweave_task_done: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* refuseUnlessMayChange(
        `specweave task done ${input.task} ${input.increment} --evidence "..."`,
      );
      const where = yield* workspaceFor(input.folder);
      return yield* runSpecweave({
        specweaveRoot: where.specweaveRoot,
        args: ["task", "done", input.task, input.increment, "--evidence", input.evidence, "--json"],
        timeout: DONE_TIMEOUT,
      });
    }),
  ),
  specweave_verify: Access.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* refuseUnlessMayChange(`specweave verify ${input.increment}`);
      const where = yield* workspaceFor(input.folder);
      let latest = "";
      const remember = (chunk: string) => {
        const lines = chunk
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length > 0) latest = lines.at(-1) ?? latest;
      };
      return yield* reportWhileRunning(
        `specweave verify ${input.increment}`,
        () => latest,
        runSpecweave({
          specweaveRoot: where.specweaveRoot,
          args: ["verify", input.increment, "--json"],
          timeout: Duration.minutes(input.timeoutMinutes ?? VERIFY_DEFAULT_MINUTES),
          onOutput: remember,
        }),
      );
    }),
  ),
});
