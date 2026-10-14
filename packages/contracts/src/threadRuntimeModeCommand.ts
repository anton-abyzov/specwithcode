import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  /** Persist the choice without stopping a provider that is currently working. */
  applyOnNextTurn: Schema.optional(Schema.Boolean),
});
