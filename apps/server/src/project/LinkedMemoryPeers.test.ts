import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import * as LinkedMemoryPeers from "./LinkedMemoryPeers.ts";
import { alpha, beta, machine } from "./LinkedMemorySync.testkit.ts";

const from = (environmentId: EnvironmentId): ReceiverCaller => ({
  sourceEnvironmentId: environmentId,
  grant: null,
});
it.effect("the peer route answers only a linked copy of the project", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* machine(beta, "Beta");
      yield* b.write("beta.md", "from beta");
      const receiver = yield* Effect.provide(LinkedMemoryPeers.makeReceiver, b.context);
      const stranger = yield* receiver
        .memoryExport(from(EnvironmentId.make("env-stranger")), { projectId: beta.projectId })
        .pipe(Effect.exit);
      assert.strictEqual(
        Exit.isFailure(stranger) ? Option.getOrUndefined(Exit.findErrorOption(stranger))?.code : "",
        "needs_grant",
      );
      const missing = yield* receiver
        .memoryExport(from(alpha.environmentId), { projectId: ProjectId.make("elsewhere") })
        .pipe(Effect.exit);
      assert.strictEqual(
        Exit.isFailure(missing) ? Option.getOrUndefined(Exit.findErrorOption(missing))?.code : "",
        "not_found",
      );
      // A machine never syncs with itself, even through its own route.
      const itself = yield* receiver
        .memoryExport(from(beta.environmentId), { projectId: beta.projectId })
        .pipe(Effect.exit);
      assert.strictEqual(
        Exit.isFailure(itself) ? Option.getOrUndefined(Exit.findErrorOption(itself))?.code : "",
        "needs_grant",
      );
      const page = yield* receiver.memoryExport(from(alpha.environmentId), {
        projectId: beta.projectId,
      });
      // A member merges in only its own memory, never another machine's in that machine's name.
      const forged = yield* receiver
        .memoryMerge(from(alpha.environmentId), {
          projectId: beta.projectId,
          peer: {
            environmentId: EnvironmentId.make("env-other"),
            projectId: beta.projectId,
            label: "Other",
          },
          export: { ...page, environmentId: EnvironmentId.make("env-other") },
        })
        .pipe(Effect.exit);
      assert.strictEqual(
        Exit.isFailure(forged) ? Option.getOrUndefined(Exit.findErrorOption(forged))?.code : "",
        "needs_grant",
      );
      assert.deepStrictEqual(
        page.files.map((file) => file.name),
        ["beta.md"],
      );
    }),
  ),
);
