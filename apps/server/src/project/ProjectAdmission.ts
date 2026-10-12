import type { ProjectId } from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/** Serializes authoritative admission with lifecycle changes in this server.
 * Non-reentrant: hold only around admission and durable dispatch, never child waits.
 * All consumers provide this same layer so the application graph shares one lock.
 */
export class ProjectAdmission extends Context.Service<
  ProjectAdmission,
  KeyedLock.KeyedLock<ProjectId>
>()("studio/project/ProjectAdmission") {}
export const layer = Layer.effect(ProjectAdmission, KeyedLock.make<ProjectId>());
