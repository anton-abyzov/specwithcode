import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkspaceError,
  SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
  SERVICE_UPDATE_VERIFYING_MESSAGE,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ServiceUpdateInProgressError } from "../serviceUpdate/ServiceUpdateHold.ts";
import { findUpdateRefusal, mapProjectFailure } from "./ProjectWorkspaceFailure.ts";

const projectId = ProjectId.make("project-1");

const dispatchRefused = (verifying?: boolean) =>
  new OrchestratorDispatchError({
    commandId: CommandId.make("command-1"),
    commandType: "message.dispatch",
    cause: new ServiceUpdateInProgressError({
      action: "message.dispatch",
      ...(verifying === undefined ? {} : { verifying }),
    }),
  });

const captureLogs = () => {
  const logs: Array<unknown> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    logs.push({ logLevel, message });
  });
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

describe("mapProjectFailure", () => {
  it.effect("surfaces a command refused for an update with the hold's own message", () =>
    Effect.gen(function* () {
      const { logs, layer } = captureLogs();
      const error = yield* Effect.fail(dispatchRefused()).pipe(
        mapProjectFailure(projectId, "coordinator.send"),
        Effect.flip,
        Effect.provide(layer),
      );
      assert.equal(error.code, "update_in_progress");
      assert.equal(error.projectId, projectId);
      assert.equal(error.message, SERVICE_UPDATE_IN_PROGRESS_MESSAGE);
      // The hold logs its refusals; this one is not logged again as a failure.
      assert.deepEqual(logs, []);
    }),
  );

  it.effect("keeps the verifying message after the restart", () =>
    Effect.gen(function* () {
      const error = yield* Effect.fail(dispatchRefused(true)).pipe(
        mapProjectFailure(projectId, "coordinator.start"),
        Effect.flip,
      );
      assert.equal(error.code, "update_in_progress");
      assert.equal(error.message, SERVICE_UPDATE_VERIFYING_MESSAGE);
    }),
  );

  it.effect("passes a project error through unchanged", () =>
    Effect.gen(function* () {
      const original = new ProjectWorkspaceError({ projectId, code: "paused" });
      const error = yield* Effect.fail(original).pipe(
        mapProjectFailure(projectId, "coordinator.send"),
        Effect.flip,
      );
      assert.strictEqual(error, original);
    }),
  );

  it.effect("logs any other failure with the project and operation before collapsing it", () =>
    Effect.gen(function* () {
      const { logs, layer } = captureLogs();
      const cause = new Error("database is locked");
      const error = yield* Effect.fail(cause).pipe(
        mapProjectFailure(projectId, "memory.write"),
        Effect.flip,
        Effect.provide(layer),
      );
      assert.equal(error.code, "operation_failed");
      assert.equal(logs.length, 1);
      const [entry] = logs as Array<{
        logLevel: string;
        message: ReadonlyArray<unknown>;
      }>;
      assert.equal(entry?.logLevel, "Warn");
      assert.deepEqual(entry?.message, [
        "project.operation.failed",
        { projectId, operation: "memory.write", cause },
      ]);
    }),
  );
});

describe("findUpdateRefusal", () => {
  it("follows nested causes and stops at plain values", () => {
    const refusal = new ServiceUpdateInProgressError({ action: "thread.create" });
    assert.strictEqual(findUpdateRefusal({ cause: { cause: refusal } }), refusal);
    assert.isNull(findUpdateRefusal(new Error("other")));
    assert.isNull(findUpdateRefusal(null));
    assert.isNull(findUpdateRefusal("text"));
  });
});
