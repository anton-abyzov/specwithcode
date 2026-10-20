import { listFederatedProjectThreads } from "./federatedProjectThreads.ts";
import { migrateThreads } from "./migrate.ts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import {
  assertLocalDelegation,
  interruptRemote,
  localThreadIdOf,
  listRemote,
  readRemote,
  routeThread,
  sendRemote,
  waitRemote,
  withoutMachine,
} from "./remote.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { accountInGrant } from "../../../fleet/workGrantPolicy.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import {
  assertAccountInGrant,
  assertProjectInGrant,
  assertThreadInGrant,
  assertThreadWritable,
  workGrantOf,
} from "../../workGrantAccess.ts";

/**
 * Work another machine started here reaches only threads in the projects
 * its grant covers. A thread that does not exist is the handler's to report.
 */
const guardThread = (threadId: string, access: "read" | "write" = "read") =>
  Effect.gen(function* () {
    const caller = yield* loadCaller();
    const work = yield* workGrantOf(caller);
    if (work === undefined) return;
    const shell = yield* caller.threads
      .getThreadShell(localThreadIdOf(threadId))
      .pipe(Effect.mapError(unavailable));
    if (shell === null) return;
    yield* assertThreadInGrant(work, shell);
    if (access === "write") yield* assertThreadWritable(work, shell);
  });

/** ...and starts its subagents and threads only on the sign-ins that grant allows. */
const guardTargets = (
  targets: ReadonlyArray<
    | { readonly providerInstanceId?: string | undefined; readonly driverKind?: string | undefined }
    | undefined
  >,
) =>
  Effect.gen(function* () {
    const work = yield* workGrantOf(yield* loadCaller());
    if (work === undefined || work.grant.accounts.kind === "all") return;
    for (const target of targets) {
      // Omitted, the child keeps the calling thread's own sign-in, which the grant admitted.
      if (target?.providerInstanceId !== undefined)
        yield* assertAccountInGrant(work, target.providerInstanceId as never);
      else if (target?.driverKind !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "account_not_allowed",
          message: `This machine limits which sign-ins ${work.coordinatorLabel}'s work may use. Name the sign-in with target.providerInstanceId.`,
        });
    }
  });

/** A thread list's project must be one the grant covers. */
const guardProject = (projectId: string) =>
  Effect.gen(function* () {
    const work = yield* workGrantOf(yield* loadCaller());
    if (work === undefined) return;
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getById(projectId as never).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (project === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "outside_grant_scope",
        message: `This machine does not let ${work.coordinatorLabel} reach that project.`,
      });
    yield* assertProjectInGrant(work, project);
  });

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const capabilities = yield* service.capabilities(scope);
      // Another machine judging this one as a limit handoff target needs to know which sign-ins its grant allows.
      const work = yield* workGrantOf(yield* loadCaller());
      if (work === undefined) return capabilities;
      return {
        ...capabilities,
        providers: capabilities.providers.map((provider) => ({
          ...provider,
          allowedByGrant: accountInGrant(work.grant.accounts, provider.providerInstanceId),
        })),
      };
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* assertLocalDelegation(input);
      yield* guardTargets([input.target]);
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, withoutMachine(input));
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  schedule_task: McpToolAccess.startsThreads(
    // A scheduled task runs with the caller's own modes.
    () => ({}),
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.scheduleTask(scope, input);
      }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  ask_user: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.askUser(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* guardTargets(input.threads.map((thread) => thread.target));
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  studio_thread_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const target = yield* workers.resolveMachine(input.machine);
      if (target.kind === "remote") return yield* listRemote(target.machine, withoutMachine(input));
      const listed = yield* listFederatedProjectThreads(input);
      yield* guardProject(listed.projectId);
      return listed;
    }),
  ),
  // Reading a child's finished result also acknowledges its delivery to the
  // reader's own thread. That is bookkeeping on the caller's own subagent, not
  // a change to anything it reads, so this stays a read.
  studio_thread_read: McpToolAccess.reads((input) =>
    routeThread(
      input,
      (local) =>
        Effect.gen(function* () {
          yield* guardThread(local.threadId);
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.readThread(scope, local);
        }),
      readRemote,
    ),
  ),
  studio_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId === undefined ? undefined : localThreadIdOf(input.threadId)],
    (input) =>
      Effect.gen(function* () {
        if (input.threadId !== undefined) yield* guardThread(input.threadId, "write");
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  studio_thread_send: McpToolAccess.writesThreads(
    (input) => [localThreadIdOf(input.threadId)],
    (input) =>
      routeThread(
        input,
        (local) =>
          Effect.gen(function* () {
            yield* guardThread(local.threadId, "write");
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service.sendToThread(scope, local);
          }),
        // The other machine cannot read this thread, so it receives the user's words.
        (machine, remote) =>
          Effect.gen(function* () {
            if (remote.forwardMessageId === undefined) return yield* sendRemote(machine, remote);
            if (remote.message !== undefined)
              return yield* Effect.fail(
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Pass either message or forwardMessageId to studio_thread_send.",
                }),
              );
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const { forwardMessageId, ...rest } = remote;
            return yield* sendRemote(machine, {
              ...rest,
              message: yield* service.forwardedMessageText(scope, forwardMessageId),
              clientRequestId:
                rest.clientRequestId ??
                `forward:${forwardMessageId}:${rest.threadId}`.slice(0, 256),
            });
          }),
      ),
  ),
  studio_thread_wait: McpToolAccess.reads((input) =>
    routeThread(
      input,
      (local) =>
        Effect.gen(function* () {
          yield* guardThread(local.threadId);
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.waitForThread(scope, local);
        }),
      waitRemote,
    ),
  ),
  studio_thread_interrupt: McpToolAccess.writesThreads(
    (input) => [localThreadIdOf(input.threadId)],
    (input) =>
      routeThread(
        input,
        (local) =>
          Effect.gen(function* () {
            yield* guardThread(local.threadId, "write");
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            return yield* service.interruptThread(scope, local);
          }),
        interruptRemote,
      ),
  ),
  studio_threads_stop_all: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.stopAllThreads(scope, input);
    }),
  ),
  studio_threads_continue_all: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.continueAllThreads(scope, input);
    }),
  ),
  studio_thread_migrate: McpToolAccess.writesThreads(
    (input) => (input.threadIds ?? []).map(localThreadIdOf),
    migrateThreads,
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
