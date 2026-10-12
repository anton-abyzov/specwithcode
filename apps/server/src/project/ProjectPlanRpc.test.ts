import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  WS_METHODS,
  type ProjectPlanSnapshot,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Plans from "./ProjectPlanService.ts";
import * as Rpc from "./ProjectPlanRpc.ts";
const projectId = ProjectId.make("plan-rpc");
const snapshot: ProjectPlanSnapshot = {
  projectId,
  revision: 0,
  authority: { kind: "native" },
  native: { spec: "Optional plan", criteria: [], tasks: [], contentRevision: 0 },
  external: null,
};
it.effect("human RPC derives actor and exports the persisted native plan", () =>
  Effect.gen(function* () {
    const received: unknown[] = [];
    const capture = (input: unknown) =>
      Effect.sync(() => {
        received.push(input);
        return snapshot;
      });
    const handlers = yield* Rpc.handlers.pipe(
      Effect.provide(
        Layer.mock(Plans.ProjectPlanService)({
          read: () => Effect.succeed(snapshot),
          claim: capture,
          verify: capture,
          configure: capture,
        }),
      ),
    );
    const spoof = {
      projectId,
      expectedRevision: 0,
      taskId: "T-1",
      actor: { kind: "thread", threadId: "forged" },
    };
    yield* handlers[WS_METHODS.projectsPlanClaim](spoof);
    yield* handlers[WS_METHODS.projectsPlanVerify]({
      ...spoof,
      commandId: CommandId.make("verify"),
    });
    expect(received).toEqual([
      { ...spoof, actor: { kind: "user" } },
      { ...spoof, commandId: "verify", actor: { kind: "user" } },
    ]);
    expect(yield* handlers[WS_METHODS.projectsPlanExport]({ projectId })).toMatchObject({
      filename: "project-plan.md",
      content: expect.stringContaining("Optional plan"),
    });
  }),
);
