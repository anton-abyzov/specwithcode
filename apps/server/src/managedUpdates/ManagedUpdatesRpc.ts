import {
  WS_METHODS,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServiceUpdatePreparation from "../serviceUpdate/ServiceUpdatePreparation.ts";
import {
  freshManagedUpdateAuthority,
  type ManagedUpdateAction,
} from "./ManagedUpdatesAuthority.ts";
import {
  installedManagedUpdateHelper,
  makeManagedUpdatesService,
  type ManagedUpdateInput,
} from "./ManagedUpdatesService.ts";

export const makeManagedUpdatesRpc = (currentSession: AuthenticatedSession) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const runner = yield* ProcessRunner.ProcessRunner;
    const helperContext = yield* Effect.context<
      import("effect/FileSystem").FileSystem | import("effect/Path").Path
    >();
    const service = makeManagedUpdatesService({
      stateDir: config.stateDir,
      environmentId,
      helper: installedManagedUpdateHelper.pipe(Effect.provide(helperContext)),
      run: runner.run,
    });
    const invoke = (action: ManagedUpdateAction, input?: ManagedUpdateInput) =>
      Effect.gen(function* () {
        yield* freshManagedUpdateAuthority(currentSession, action, () =>
          sessions.getById({ sessionId: currentSession.sessionId }),
        );
        // Python re-reads this same persisted grant under its consent lock.
        return yield* service(
          action,
          { sessionId: currentSession.sessionId, subject: currentSession.subject },
          input,
        );
      });
    return {
      [WS_METHODS.managedUpdatesStatus]: () => invoke("status"),
      [WS_METHODS.managedUpdatesEnroll]: (
        input: import("@specweave-studio/contracts").ManagedUpdateEnrollment,
      ) => invoke("enroll", input),
      [WS_METHODS.managedUpdatesRevoke]: (
        input: import("@specweave-studio/contracts").ManagedUpdateMutation,
      ) => invoke("revoke", input),
      [WS_METHODS.managedUpdatesCheck]: (
        input: import("@specweave-studio/contracts").ManagedUpdateTarget,
      ) => invoke("check", input),
    };
  }).pipe(Effect.provide(Layer.mergeAll(AuthSessions.layer, ProcessRunner.layer)));

/** Existing self-update behavior, extracted from the oversized websocket composition. */
export const makeLegacyServerUpdateRpc = Effect.gen(function* () {
  const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const serviceUpdatePreparation = yield* ServiceUpdatePreparation.ServiceUpdatePreparation;
  return {
    [WS_METHODS.serverUpdateServer]: (
      input: import("@specweave-studio/contracts").ServerSelfUpdateInput,
    ) => serverSelfUpdate.update(input),
    [WS_METHODS.serverUpdateServerWithProgress]: (
      input: import("@specweave-studio/contracts").ServerSelfUpdateInput,
    ) =>
      Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
        serverSelfUpdate
          .update(input, (stage) =>
            Queue.offer(queue, { type: "progress", stage }).pipe(Effect.asVoid),
          )
          .pipe(
            Effect.flatMap((result) => Queue.offer(queue, { type: "complete", result })),
            Effect.catchTags({ ServerSelfUpdateError: (error) => Queue.fail(queue, error) }),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          ),
      ),
    [WS_METHODS.serverCommitDesktopUpdate]: (
      input: import("@specweave-studio/contracts").DesktopUpdateCommitInput,
    ) => serverSelfUpdate.commitDesktopUpdate(input.requestId),
    [WS_METHODS.serverPrepareServiceUpdate]: serviceUpdatePreparation.prepare,
  };
});
