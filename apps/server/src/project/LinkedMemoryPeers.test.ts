import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LinkedMemoryExportInput,
  type LinkedMemoryMergeInput,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import type { HandoffRefusal, ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import * as LinkedMemoryPeers from "./LinkedMemoryPeers.ts";
import { alpha, beta, machine, type Machine } from "./LinkedMemorySync.testkit.ts";

const active = { epoch: 0, state: "active" as const };
const from = (environmentId: EnvironmentId): ReceiverCaller => ({
  sourceEnvironmentId: environmentId,
  grant: null,
});
const viaNetwork = <A>(effect: Effect.Effect<A, HandoffRefusal>) =>
  effect.pipe(
    Effect.mapError(
      (refusal) =>
        new HandoffPeerError({ code: refusal.code, message: refusal.message, uncertain: false }),
    ),
  );

/** `coordinator`'s loop, reaching `copy` through its peer route as `coordinator`'s machine. */
const coordinatorLoop = (coordinator: Machine, copy: Machine) =>
  Effect.gen(function* () {
    const receiver = yield* Effect.provide(LinkedMemoryPeers.makeReceiver, copy.context);
    const caller = from(coordinator.self.environmentId);
    const peers = HandoffPeers.of({
      targets: Effect.succeed([
        { machineId: "beta", environmentId: copy.self.environmentId, label: "Beta" },
      ]),
      memoryExport: (_environmentId: EnvironmentId, input: LinkedMemoryExportInput) =>
        viaNetwork(receiver.memoryExport(caller, input)),
      memoryMerge: (_environmentId: EnvironmentId, input: LinkedMemoryMergeInput) =>
        viaNetwork(receiver.memoryMerge(caller, input)),
    } as unknown as HandoffPeers["Service"]);
    return yield* Effect.provide(
      LinkedMemoryPeers.makeSync.pipe(Effect.provideService(HandoffPeers, peers)),
      coordinator.context,
    );
  });

it.effect("the coordinator's server syncs memory both ways with its copy on another machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha", undefined, "code", active);
      const b = yield* machine(beta, "Beta");
      yield* a.write("alpha.md", "from alpha");
      yield* b.write("beta.md", "from beta");
      const loop = yield* coordinatorLoop(a, b);
      yield* loop.tick;
      assert.deepStrictEqual(yield* a.contents, {
        "alpha.md": "from alpha",
        "beta.md": "from beta",
      });
      assert.deepStrictEqual(yield* b.contents, {
        "alpha.md": "from alpha",
        "beta.md": "from beta",
      });
      // A later edit on the copy reaches the coordinator on the next pass.
      yield* b.write("beta.md", "edited on beta");
      yield* loop.tick;
      assert.strictEqual((yield* a.contents)["beta.md"], "edited on beta");
    }),
  ),
);

it.effect("a copy that holds no coordinator drives nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("alpha.md", "from alpha");
      yield* (yield* coordinatorLoop(a, b)).tick;
      assert.deepStrictEqual(yield* b.contents, {});
    }),
  ),
);

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
      const page = yield* receiver.memoryExport(from(alpha.environmentId), {
        projectId: beta.projectId,
      });
      assert.deepStrictEqual(
        page.files.map((file) => file.name),
        ["beta.md"],
      );
    }),
  ),
);

it("syncs only the copies this server can reach, and only from the coordinator", () => {
  const project = (state: "active" | "transferred") =>
    ({
      id: alpha.projectId,
      deletedAt: null,
      workspaceSettings: {
        kind: "code",
        coordinatorBinding: { epoch: 0, state },
        logicalProject: {
          members: [
            { ...alpha, coordinatorThreadId: "c" },
            { ...beta, coordinatorThreadId: "c" },
            { environmentId: "env-gamma", projectId: "gamma-copy", coordinatorThreadId: "c" },
          ],
        },
      },
    }) as never;
  const label = (environmentId: EnvironmentId) => environmentId.toUpperCase();
  assert.deepStrictEqual(
    LinkedMemoryPeers.peerSyncMembers(
      project("active"),
      alpha.environmentId,
      new Set([beta.environmentId]),
      label,
    ).map((member) => member.environmentId),
    [alpha.environmentId, beta.environmentId],
  );
  assert.deepStrictEqual(
    LinkedMemoryPeers.peerSyncMembers(project("active"), alpha.environmentId, new Set(), label),
    [],
  );
  assert.deepStrictEqual(
    LinkedMemoryPeers.peerSyncMembers(
      project("transferred"),
      alpha.environmentId,
      new Set([beta.environmentId]),
      label,
    ),
    [],
  );
});
