import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import type { SubscriptionRead } from "../../provider/subscriptionIdentity.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-claude-subscription-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const openSession = (subscription: Effect.Effect<SubscriptionRead> | undefined) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir: serverConfig.attachmentsDir,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      ...(subscription === undefined ? {} : { subscription }),
      queryRunner: {
        allocateSessionId: Effect.succeed("native-thread-subscription"),
        open: () =>
          Effect.succeed({
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    return yield* adapter.openSession({
      threadId: ThreadId.make("thread-subscription"),
      providerSessionId: ProviderSessionId.make("provider-session-subscription"),
      modelSelection: MODEL_SELECTION,
      runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    });
  });

describe("ClaudeAdapterV2 after a sign-in to another account", () => {
  it.effect("replaces an idle process opened on the previous subscription", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<SubscriptionRead>({ key: "claude:sha256:personal" });
      const runtime = yield* openSession(Ref.get(current));
      const replaceWhenIdle = runtime.replaceWhenIdle;
      if (replaceWhenIdle === undefined) throw new Error("expected replaceWhenIdle");
      assert.isNull(yield* replaceWhenIdle);

      // A terminal `/login` to another account: the next status read names it.
      yield* Ref.set(current, { key: "claude:sha256:enterprise" });
      assert.equal(yield* replaceWhenIdle, ClaudeAdapterV2.CLAUDE_SUBSCRIPTION_CHANGED_REASON);

      // A read that names no subscription (a failed probe) is no proof of a switch.
      yield* Ref.set(current, {});
      assert.isNull(yield* replaceWhenIdle);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("replaces a process opened before any read once a change is seen after it", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make<SubscriptionRead>({});
      const runtime = yield* openSession(Ref.get(current));
      const replaceWhenIdle = runtime.replaceWhenIdle;
      if (replaceWhenIdle === undefined) throw new Error("expected replaceWhenIdle");
      const later = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
      const earlier = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 1 }));
      yield* Ref.set(current, { key: "claude:sha256:enterprise", changedAt: earlier });
      assert.isNull(yield* replaceWhenIdle);
      yield* Ref.set(current, { key: "claude:sha256:enterprise", changedAt: later });
      assert.equal(yield* replaceWhenIdle, ClaudeAdapterV2.CLAUDE_SUBSCRIPTION_CHANGED_REASON);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("keeps a process when the instance reads no subscription at all", () =>
    Effect.gen(function* () {
      const runtime = yield* openSession(undefined);
      assert.isUndefined(runtime.replaceWhenIdle);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
