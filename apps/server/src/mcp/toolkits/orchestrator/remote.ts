import {
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
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
import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import type { RemoteTool } from "../../../fleet/RemoteStudioMcpClient.ts";
import { isTerminalThreadStatus } from "../../../fleet/remoteWorkerMatching.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { refuseReadOnlyClient } from "../../McpToolAccess.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import {
  coordinatorOfWorkerLabel,
  delegationRefusal,
  outgoingDelegation,
} from "../../../fleet/workGrantPolicy.ts";
import { type Caller, loadCaller, readCaller } from "../../threadAccess.ts";
import { explainThreadNotFound } from "../../threadNotFoundHint.ts";
import { refuseRevoked, workGrantOf } from "../../workGrantAccess.ts";

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
 * Who does work on another machine from here: an agent running in a Studio
 * thread here, or an outside agent the user approved on this machine (an
 * OAuth or static-token MCP client). That machine allowed this server, so
 * either works within this server's grant there, and a client also within
 * the access it was approved with: `loadCaller` caps its limits at that
 * ceiling and the grant caps what the other machine runs. Another machine's
 * own credential is neither: its work reaches a third machine only through
 * the threads it starts here, which carry its path.
 */
export type FleetPrincipal =
  | {
      readonly kind: "thread";
      readonly caller: OrchestrationV2ThreadShell;
      readonly launchedBy: RemoteWorkers.RemoteWorkerLauncher;
    }
  | {
      readonly kind: "client";
      readonly client: McpInvocationContext.McpClientCaller;
      readonly launchedBy: RemoteWorkers.RemoteWorkerLauncher;
    };

const outsideFleet = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "Work on another machine is for an agent running inside a SpecWithCode thread on this one, or an MCP client the user approved on it.",
  });

/** A client signed in as another machine's coordinator, or under a worker grant's label. */
export const isOtherMachineCredential = (client: McpInvocationContext.McpClientCaller) =>
  client.principal?.kind === "coordinator" || coordinatorOfWorkerLabel(client.label) !== undefined;

/**
 * The principal `context` acts as on another machine. `act` work (launch,
 * send, interrupt) is refused to a read-only client; it may still list, read
 * and wait.
 */
export const fleetPrincipalOf = Effect.fn("mcp.fleetPrincipalOf")(function* (
  context: Caller,
  access: "observe" | "act",
) {
  if (context.scope.thread !== undefined) {
    if (context.caller === undefined) return yield* outsideFleet();
    return {
      kind: "thread",
      caller: context.caller,
      launchedBy: { kind: "thread", threadId: context.caller.id },
    } satisfies FleetPrincipal as FleetPrincipal;
  }
  const client = context.scope.client;
  if (client === undefined) return yield* outsideFleet();
  // Another machine's own credential, known by its principal or its reserved
  // label even with grants off, never passes as an outside client.
  if (isOtherMachineCredential(client) || (yield* workGrantOf(context)) !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Another machine's work reaches a third machine only through the threads it starts on this one.",
    });
  if (access === "act") yield* refuseReadOnlyClient;
  return {
    kind: "client",
    client,
    launchedBy: { kind: "client", sessionId: client.sessionId, label: client.label },
  } satisfies FleetPrincipal as FleetPrincipal;
});

/** The calling principal, for a tool that works on another machine. */
const requireFleetPrincipal = (access: "observe" | "act") =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.thread === undefined && scope.client === undefined) return yield* outsideFleet();
    return yield* fleetPrincipalOf(yield* readCaller(), access);
  });

/**
 * Work another machine started here reaches a thread on a third machine only
 * as far as its own launches may go: never back along the path it came by,
 * never past the hop limit, and only to a thread this calling thread launched
 * there. That machine sees this one's coordinator, not the work's origin, so
 * the check is made here. Listing another machine's threads is refused to it.
 * A legacy grant (the owner's own machines) still reads, waits on and lists
 * threads anywhere, its origin included, as before grants: only a send or an
 * interrupt, which acts on the thread, is kept off the path it came by.
 */
const assertGrantMayReach = (
  principal: FleetPrincipal,
  machine: OrchestratorMcpMachineRef,
  remoteThreadId: string | undefined,
  access: "observe" | "act",
) =>
  Effect.gen(function* () {
    const context = yield* loadCaller();
    const work = yield* workGrantOf(context);
    if (work === undefined) return;
    yield* refuseRevoked(work);
    if (work.grant.legacy === true && access === "observe") return;
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const outgoing = outgoingDelegation({
      localEnvironmentId: context.scope.environmentId,
      targetEnvironmentId: machine.environmentId,
      origin: work.origin,
    });
    if (!outgoing.ok)
      return yield* new OrchestratorMcpFailure({
        code: outgoing.code,
        message: delegationRefusal(
          outgoing,
          new Map([
            ...(yield* workers.machineLabels),
            [context.scope.environmentId, "this machine"],
          ]),
        ),
      });
    // A legacy grant (the owner's own machines) reaches their threads as before.
    if (work.grant.legacy === true) return;
    const launched =
      remoteThreadId !== undefined &&
      (yield* workers.launchedBy({
        launchedBy: principal.launchedBy,
        machineId: machine.id,
        remoteThreadId,
      }));
    if (!launched)
      return yield* new OrchestratorMcpFailure({
        code: "outside_grant_scope",
        message: `This thread runs ${work.coordinatorLabel}'s work, which may reach only the threads it launched on ${machine.label}.`,
      });
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
): Effect.Effect<
  A | B,
  OrchestratorMcpFailure,
  RL | RR | McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
> =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const resolved = yield* workers.resolveThread({
      machine: input.machine,
      threadId: input.threadId,
    });
    const rest = { ...withoutMachine(input), threadId: resolved.threadId } as Omit<I, "machine">;
    return resolved.target.kind === "local"
      ? yield* local(rest).pipe(
          Effect.catchIf(
            (error) => error.code === "thread_not_found",
            (error) => Effect.flip(explainThreadNotFound(rest.threadId, error)),
          ),
        )
      : yield* remote(resolved.target.machine, rest);
  });

export const readRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const principal = yield* requireFleetPrincipal("observe");
    yield* assertGrantMayReach(principal, machine, input.threadId, "observe");
    if (input.acknowledgeResult === false) {
      // Older peers silently strip unknown read arguments. Never let a wait's
      // preview fall back to their acknowledging read path.
      const supported = yield* proxied(
        Schema.Struct({
          features: Schema.Struct({ readThreadWithoutAcknowledgement: Schema.Literal(true) }),
        }),
        machine,
        "orchestrator_capabilities",
        {},
      ).pipe(Effect.result);
      if (supported._tag === "Failure")
        return yield* new OrchestratorMcpFailure({
          code: "machine_unsupported",
          message: `${machine.label} does not advertise non-acknowledging thread reads.`,
        });
    }
    return yield* proxied(OrchestratorMcpThreadReadResult, machine, "studio_thread_read", input);
  });

export const waitRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string; readonly timeoutMs?: number | undefined } & Record<
    string,
    unknown
  >,
) =>
  Effect.gen(function* () {
    const principal = yield* requireFleetPrincipal("observe");
    yield* assertGrantMayReach(principal, machine, input.threadId, "observe");
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
        launchedBy: principal.launchedBy,
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
    const principal = yield* requireFleetPrincipal("act");
    yield* assertGrantMayReach(principal, machine, input.threadId, "act");
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
          launchedBy: principal.launchedBy,
          machineId: machine.id,
          remoteThreadId: result.threadId,
          runId: result.runId,
        });
        // The link that machine wrote names a thread there; say which machine.
        const label = result.threadLink?.match(/^\[([^\]]*)\]/)?.[1];
        return label === undefined
          ? result
          : {
              ...result,
              threadLink: formatStudioThreadLink(result.threadId, label, machine.environmentId),
            };
      }),
    );
  });

export const interruptRemote = (
  machine: OrchestratorMcpMachineRef,
  input: { readonly threadId: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const principal = yield* requireFleetPrincipal("act");
    yield* assertGrantMayReach(principal, machine, input.threadId, "act");
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
    const principal = yield* requireFleetPrincipal("observe");
    yield* assertGrantMayReach(principal, machine, undefined, "observe");
    const workers = yield* RemoteWorkers.RemoteWorkers;
    // A client has no project here to match; that machine lists what it names.
    const projectId =
      input.projectId ??
      (principal.kind === "thread"
        ? yield* workers.remoteProjectFor({ machine, localProjectId: principal.caller.projectId })
        : undefined);
    return yield* proxied(OrchestratorMcpThreadListResult, machine, "studio_thread_list", {
      ...input,
      machine: "local",
      ...(projectId === undefined ? {} : { projectId }),
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
