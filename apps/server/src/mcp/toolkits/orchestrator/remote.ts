import {
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  type ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  formatStudioThreadLink,
  parseStudioThreadTarget,
} from "@specweave-studio/shared/studioThreadLinks";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import type { RemoteTool } from "../../../fleet/RemoteStudioMcpClient.ts";
import { isTerminalThreadStatus } from "../../../fleet/remoteWorkerMatching.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { loadCaller, readCaller } from "../../threadAccess.ts";

const MAX_WAIT_MS = 60 * 60 * 1_000;
const DEFAULT_WAIT_MS = 10 * 60 * 1_000;

const unreadable = (machine: OrchestratorMcpMachineRef) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `${machine.label} sent an answer this machine could not read.`,
  });

/**
 * Thread links in another machine's answer name threads on that machine, so
 * each one is rewritten to say which machine; an older machine sends none.
 */
const relinkThreads = (machine: OrchestratorMcpMachineRef, answer: unknown): unknown => {
  if (typeof answer !== "object" || answer === null || !("threads" in answer)) return answer;
  const threads = (answer as { threads: unknown }).threads;
  if (!Array.isArray(threads)) return answer;
  return {
    ...answer,
    threads: threads.map((thread: unknown) =>
      typeof thread === "object" &&
      thread !== null &&
      typeof (thread as { threadId?: unknown }).threadId === "string"
        ? {
            ...thread,
            threadLink: formatStudioThreadLink(
              (thread as { threadId: string }).threadId,
              String((thread as { title?: unknown }).title ?? ""),
              machine.environmentId,
            ),
          }
        : thread,
    ),
  };
};

/** Calls a thread tool on another machine and checks its answer against the same contract. */
const proxied = <S extends Schema.Top>(
  schema: S,
  machine: OrchestratorMcpMachineRef,
  tool: RemoteTool,
  args: Record<string, unknown>,
  timeoutMs?: number,
) =>
  Effect.gen(function* () {
    const remote = yield* RemoteWorkers.RemoteWorkers;
    const answer = relinkThreads(
      machine,
      yield* remote.proxy({ machine, tool, arguments: args, timeoutMs }),
    );
    return yield* Schema.decodeUnknownEffect(schema)(answer).pipe(
      Effect.mapError(() => unreadable(machine)),
    );
  }) as Effect.Effect<S["Type"], OrchestratorMcpFailure, S["DecodingServices"]>;

const withoutMachine = <I extends { readonly machine?: unknown }>(input: I) => {
  const { machine: _machine, ...rest } = input;
  return rest;
};

/**
 * Work on another machine is only for agents running in a Studio thread here:
 * that machine allowed this server, not the outside clients approved on it,
 * whatever they may read or do here. Returns the calling thread.
 */
const requireThreadCaller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const context = scope.thread === undefined ? undefined : yield* readCaller();
  if (context?.caller === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Work on another machine is only for an agent running inside a Studio thread on this one.",
    });
  return context.caller;
});

/** The remote thread may not run with broader modes than the caller here, as for a local one. */
const assertWithinCallerModes = (machine: OrchestratorMcpMachineRef, threadId: string) =>
  Effect.gen(function* () {
    const { limits } = yield* loadCaller();
    const read = yield* proxied(OrchestratorMcpThreadReadResult, machine, "studio_thread_read", {
      threadId,
      limit: 1,
      runLimit: 1,
    });
    const thread: typeof OrchestratorMcpThreadDetail.Type = read.thread;
    yield* resolveRuntimeMode(limits.runtimeMode, thread.runtimeMode);
    yield* resolveInteractionMode(limits.interactionMode, thread.interactionMode);
  });

type Target = { readonly machine?: string | undefined; readonly threadId: string };

/**
 * The thread a `threadId` names on this machine: a `studio://thread/...` link
 * decoded the way `routeThread` decodes it, so access checks see the same
 * thread the tool then acts on.
 */
export const localThreadIdOf = (threadId: string): ThreadId => {
  const target = parseStudioThreadTarget(threadId);
  return ThreadId.make(target?.candidates[0] ?? threadId);
};

/**
 * Runs `local` for a thread here, or the same tool on the machine the thread
 * lives on. Thread links (`studio://thread/...`) name the machine themselves.
 */
export const routeThread = <I extends Target, A, B, RL, RR>(
  input: I,
  local: (input: Omit<I, "machine">) => Effect.Effect<A, OrchestratorMcpFailure, RL>,
  remote: (
    machine: OrchestratorMcpMachineRef,
    input: Omit<I, "machine">,
  ) => Effect.Effect<B, OrchestratorMcpFailure, RR>,
): Effect.Effect<A | B, OrchestratorMcpFailure, RL | RR> =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const resolved = yield* workers.resolveThread({
      machine: input.machine,
      threadId: input.threadId,
    });
    const rest = { ...withoutMachine(input), threadId: resolved.threadId } as Omit<I, "machine">;
    return resolved.target.kind === "local"
      ? yield* local(rest)
      : yield* remote(resolved.target.machine, rest);
  });

export const readRemote = (machine: OrchestratorMcpMachineRef, input: Record<string, unknown>) =>
  requireThreadCaller.pipe(
    Effect.andThen(proxied(OrchestratorMcpThreadReadResult, machine, "studio_thread_read", input)),
  );

export const waitRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string; readonly timeoutMs?: number | undefined } & Record<
    string,
    unknown
  >,
) =>
  Effect.gen(function* () {
    const caller = yield* requireThreadCaller;
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
    const result = yield* proxied(
      OrchestratorMcpThreadWaitResult,
      machine,
      "studio_thread_wait",
      { ...input, timeoutMs },
      timeoutMs + 15_000,
    );
    if (!result.timedOut && result.status !== "idle" && isTerminalThreadStatus(result.status)) {
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.noteFinished({
        callerThreadId: caller.id,
        machineId: machine.id,
        remoteThreadId: result.threadId,
        runId: result.runId,
        status: result.status,
      });
    }
    return result;
  });

export const sendRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const caller = yield* requireThreadCaller;
    yield* assertWithinCallerModes(machine, input.threadId);
    const workers = yield* RemoteWorkers.RemoteWorkers;
    // A run started there is always followed: the send and noting its run are not cut apart.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* proxied(
          OrchestratorMcpThreadSendResult,
          machine,
          "studio_thread_send",
          input,
        );
        yield* workers.noteRun({
          callerThreadId: caller.id,
          machineId: machine.id,
          remoteThreadId: result.threadId,
          runId: result.runId,
        });
        return result;
      }),
    );
  });

export const interruptRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    yield* requireThreadCaller;
    yield* assertWithinCallerModes(machine, input.threadId);
    return yield* proxied(
      OrchestratorMcpThreadInterruptResult,
      machine,
      "studio_thread_interrupt",
      input,
    );
  });

/** Lists threads on another machine, in the project matching the caller's when none is named. */
export const listRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly projectId?: ProjectId | undefined } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const caller = yield* requireThreadCaller;
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const projectId =
      input.projectId ??
      (yield* workers.remoteProjectFor({ machine, localProjectId: caller.projectId }));
    return yield* proxied(OrchestratorMcpThreadListResult, machine, "studio_thread_list", {
      ...input,
      projectId,
    });
  });

/**
 * delegate_task children always run here. A coordinator whose project sends
 * workers to another machine must say so explicitly, so a worker is never
 * started on the wrong machine by habit.
 */
export const assertLocalDelegation = (input: { readonly machine?: string | undefined }) =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const target = yield* workers.resolveMachine(input.machine);
    if (target.kind === "remote")
      return yield* new OrchestratorMcpFailure({
        code: "delegation_is_local",
        message: `delegate_task runs subagents on this machine. Start work on ${target.machine.label} with studio_thread_launch {machine:"${target.machine.id}"}.`,
      });
    if (input.machine !== undefined) return;
    const context = yield* readCaller();
    if (context.caller === undefined) return;
    const configured = yield* workers.coordinatorWorkerMachine({
      projectId: context.caller.projectId,
      callerThreadId: context.caller.id,
    });
    if (configured !== null) {
      const label = yield* workers.resolveMachine(configured.machineId).pipe(
        Effect.map((resolved) =>
          resolved.kind === "remote" ? resolved.machine.label : "another machine",
        ),
        Effect.orElseSucceed(() => "another machine"),
      );
      return yield* new OrchestratorMcpFailure({
        code: "worker_machine_set",
        message: `This project's workers run on ${label}. Start one there with studio_thread_launch (it runs there when machine is omitted), or pass machine:"local" to delegate_task to run it here.`,
      });
    }
  });

export { withoutMachine };
