import { listFederatedProjectThreads } from "./federatedProjectThreads.ts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@specweave-studio/contracts";

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

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope);
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* assertLocalDelegation(input);
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
      return yield* listFederatedProjectThreads(input);
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
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
