import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const projectId = ProjectId.make("project:metadata-compaction");
const threadId = ThreadId.make("thread:metadata-compaction");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in metadata tests"),
} as ProviderAdapterV2Shape;

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-compaction"),
  requestNamespace: "provider-session:metadata-compaction",
  thread: {
    threadId,
    providerSessionId: "provider-session:metadata-compaction",
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const layerDatabase = fixtureProjectDatabase([projectId]);
const layerThreadManagement = ThreadManagement.layer.pipe(
  Layer.provide(
    ProviderReplayHarness.layerWithRegistry(
      { name: "thread-metadata-compaction" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ),
);
const layerTest = Layer.mergeAll(
  layerThreadManagement,
  ThreadMetadataMcp.layer.pipe(Layer.provide(Layer.merge(layerThreadManagement, NodeCrypto.layer))),
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      ),
    ),
  ),
);

const rename = (title: string, clientRequestId: string) =>
  Effect.gen(function* () {
    const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
    return yield* service.update(scope, { action: "rename", title, clientRequestId });
  });

it.layer(layerTest)("thread metadata after compaction", (it) => {
  it.effect("answers a retried rename whose event compaction deleted", () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:metadata-compaction:create"),
        threadId,
        projectId,
        title: "Seed title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const first = yield* rename("First title", "rename-first");
      const second = yield* rename("Second title", "rename-second");
      assert.equal(first.title, "First title");

      // The first rename's snapshot is superseded by the second: compaction deletes it,
      // while the command receipt stays.
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const compaction = yield* maintenance.compactEventStore;
      assert.isAtLeast(compaction.deletedByType["thread.metadata-updated"] ?? 0, 1);

      const retried = yield* rename("First title", "rename-first");
      assert.equal(retried.commandId, first.commandId);
      assert.equal(retried.sequence, first.sequence);
      // The thread as it is now: the newer rename stands.
      assert.equal(retried.title, "Second title");
      assert.equal(retried.updatedAt, second.updatedAt);

      // A retry whose event survived still answers from that event.
      const again = yield* rename("Second title", "rename-second");
      assert.deepEqual(again, second);
    }),
  );
});
