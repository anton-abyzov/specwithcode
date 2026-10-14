import type { ProjectId } from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Admission is reentrant only in the SAME fiber. Forked work must acquire normally. */
export class ProjectAdmission extends Context.Service<
  ProjectAdmission,
  KeyedLock.KeyedLock<ProjectId>
>()("studio/project/ProjectAdmission") {}
const make = Effect.gen(function* () {
  const locks = yield* KeyedLock.make<ProjectId>();
  const owners = new Map<ProjectId, number>();
  return ProjectAdmission.of({
    activeKeys: locks.activeKeys,
    withLock: (id, effect) =>
      Effect.withFiber((fiber) =>
        owners.get(id) === fiber.id
          ? effect
          : locks.withLock(
              id,
              Effect.acquireUseRelease(
                Effect.sync(() => owners.set(id, fiber.id)),
                () => effect,
                () =>
                  Effect.sync(() => {
                    owners.delete(id);
                  }),
              ),
            ),
      ),
  });
});
export const layer = Layer.effect(ProjectAdmission, make);
