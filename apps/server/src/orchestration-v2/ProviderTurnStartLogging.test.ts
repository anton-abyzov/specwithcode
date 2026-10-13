import { assert, it } from "@effect/vitest";
import { ProjectEnvironmentError, ProjectId, RunId } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { logProviderTurnStartFailure } from "./ProviderTurnStartLogging.ts";

it.effect("logs the known folder startup cause without its raw payload or prompt", () =>
  Effect.gen(function* () {
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => {
      entries.push(message);
    });
    const cause = Cause.fail({
      _tag: "ProviderAdapterTurnStartError",
      detail: "Bearer private-auth-token",
      cause: new ProjectEnvironmentError({
        projectId: ProjectId.make("private-project"),
        code: "unsupported_provider",
      }),
    });
    yield* logProviderTurnStartFailure(RunId.make("owned-run"), cause).pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
    );
    assert.lengthOf(entries, 1);
    const encoded = JSON.stringify(entries);
    assert.include(encoded, "unsupported_provider");
    assert.include(encoded, "ProjectEnvironmentError");
    assert.include(encoded, "owned-run");
    assert.notInclude(encoded, "private-auth-token");
    assert.notInclude(encoded, "private-project");
    assert.notInclude(encoded, "failures");
  }),
);
