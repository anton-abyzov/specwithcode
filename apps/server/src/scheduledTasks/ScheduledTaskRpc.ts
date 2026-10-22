import {
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskListResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { ScheduledTaskService } from "./ScheduledTaskService.ts";

const ScheduledTaskRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);

const annotated = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Effect.annotateCurrentSpan({ "scheduled_task.id": id }).pipe(Effect.andThen(effect));

/**
 * The `scheduledTasks.*` handlers, registered one by one apart from the core
 * WebSocket group, whose single `toLayer` is at TypeScript's instantiation
 * limit. A webhook URL starts agent runs, so only sessions that may operate
 * see it; read-only sessions still see the task itself.
 */
export const layerRpcHandlers = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
    scopes.includes(AuthOrchestrationOperateScope)
      ? result
      : { tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task) };
  const service = Effect.service(ScheduledTaskService);
  return Layer.mergeAll(
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksList,
      Effect.map(service, (tasks) => () => tasks.list().pipe(Effect.map(withVisibleWebhookUrls))),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksSubscribe,
      Effect.map(
        service,
        (tasks) => () => tasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksUpsert,
      Effect.map(service, (tasks) => (input: ScheduledTaskUpsertInput) => tasks.upsert(input)),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksSetEnabled,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskSetEnabledInput) =>
          annotated(input.id, tasks.setEnabled(input)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksDelete,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskDeleteInput) => annotated(input.id, tasks.delete(input)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksRunNow,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskRunNowInput) => annotated(input.id, tasks.runNow(input)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksRotateWebhookToken,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskRotateWebhookTokenInput) =>
          annotated(input.id, tasks.rotateWebhookToken(input)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskListWebhookDeliveriesInput) =>
          annotated(input.id, tasks.listWebhookDeliveries(input)),
      ),
    ),
    ScheduledTaskRpcGroup.toLayerHandler(
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      Effect.map(
        service,
        (tasks) => (input: ScheduledTaskGetWebhookDeliveryInput) =>
          annotated(input.id, tasks.getWebhookDelivery(input)),
      ),
    ),
  );
};
