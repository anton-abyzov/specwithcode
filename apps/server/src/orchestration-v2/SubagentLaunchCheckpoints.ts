import type { ThreadId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

type Checkpoint = (threadId: ThreadId) => Effect.Effect<void>;

export interface SubagentLaunchCheckpointsShape {
  readonly checkpoint: Checkpoint;
  /** Serves checkpoints until the scope closes. */
  readonly serve: (checkpoint: Checkpoint) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * A provider about to launch a native child asks for its parent's handoff
 * checkpoint and waits for it (Claude's PreToolUse on Agent). Handoff mode
 * serves the requests. The default reference has no server, so adapters built
 * without one (tests, tools) never wait. The live layer must be the same layer
 * reference the adapter infrastructure and the handoff reactor receive, so
 * Effect layer memoization yields one shared instance.
 */
export class SubagentLaunchCheckpoints extends Context.Reference<SubagentLaunchCheckpointsShape>(
  "studio/orchestration-v2/SubagentLaunchCheckpoints",
  {
    defaultValue: () => ({ checkpoint: () => Effect.void, serve: () => Effect.void }),
  },
) {}

export const layer = Layer.effect(
  SubagentLaunchCheckpoints,
  Effect.gen(function* () {
    const server = yield* Ref.make<Checkpoint | null>(null);
    return {
      checkpoint: (threadId: ThreadId) =>
        Ref.get(server).pipe(
          Effect.flatMap((checkpoint) =>
            checkpoint === null ? Effect.void : checkpoint(threadId),
          ),
        ),
      serve: (checkpoint: Checkpoint) =>
        Effect.acquireRelease(Ref.set(server, checkpoint), () => Ref.set(server, null)),
    };
  }),
);
