import { ProjectId } from "@specweave-studio/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { make } from "./ProjectRuntimeAccess.ts";

const projectId = ProjectId.make("p");
const thread = (id: string, projectId = "p", extra = {}) => ({
  id,
  projectId,
  runtimeMode: "approval-required",
  deletedAt: null,
  creationSource: "web",
  lineage: { relationshipToParent: null },
  ...extra,
});
function scenario(
  test: (service: Effect.Success<typeof make>, commands: any[]) => Effect.Effect<void, any, any>,
  failOnce = false,
) {
  const commands: any[] = [];
  return Effect.gen(function* () {
    const service = yield* make;
    yield* test(service, commands);
  }).pipe(
    Effect.provide(
      Layer.merge(
        Settings.layerTest({}),
        Layer.mock(Orchestrator.OrchestratorV2)({
          withProjectPermissionUpdate: (effect) => effect,
          getShellSnapshot: () =>
            Effect.succeed({
              archivedThreads: [thread("archived")],
              threads: [
                thread("ordinary"),
                thread("other", "other"),
                thread("child", "p", {
                  creationSource: "mcp",
                  lineage: { relationshipToParent: "subagent" },
                }),
                thread("native", "p", {
                  creationSource: "provider",
                  lineage: { relationshipToParent: "subagent" },
                }),
                thread("deleted", "p", { deletedAt: "now" }),
              ],
            } as never),
          dispatch: (command) => {
            commands.push(command);
            if (
              failOnce &&
              command.type === "thread.runtime-mode.set" &&
              command.threadId === "ordinary"
            ) {
              failOnce = false;
              return Effect.fail(
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "synthetic write failure",
                }),
              );
            }
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  ) as Effect.Effect<void>;
}
it.effect(
  "explicit project access updates ordinary, delegated and archived chats only, deferring native restart",
  () =>
    scenario((service, commands) =>
      Effect.gen(function* () {
        yield* service.updateSettings({
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" } },
        });
        assert.deepEqual(commands.map((c) => c.threadId).sort(), ["archived", "child", "ordinary"]);
        for (const command of commands) {
          assert.equal(command.runtimeMode, "full-access");
          assert.equal(command.applyOnNextTurn, true);
          assert.equal(command.type, "thread.runtime-mode.set");
          assert.isUndefined(command.modelSelection);
        }
      }),
    ),
);
it.effect("global defaults and project model changes do not fan out permissions", () =>
  scenario((service, commands) =>
    Effect.gen(function* () {
      yield* service.updateSettings({ defaultRuntimeMode: "full-access" });
      yield* service.updateSettings({ projectSettingsOverrides: { [projectId]: {} } });
      assert.equal(commands.length, 0);
    }),
  ),
);

it.effect("partial propagation reports failure and a repeated save retries every chat", () =>
  scenario(
    (service, commands) =>
      Effect.gen(function* () {
        const patch = {
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "full-access" as const } },
        };
        const first = yield* Effect.exit(service.updateSettings(patch));
        assert.equal(first._tag, "Failure");
        assert.equal(commands.length, 3);
        yield* service.updateSettings(patch);
        assert.equal(commands.length, 6);
        assert.notEqual(commands[0].commandId, commands[3].commandId);
      }),
    true,
  ),
);
