/**
 * Progress for a long studio-code tool call (1483).
 *
 * `McpHttpServer` provides this to every tool call. When the client sent a
 * `progressToken` with the call, `report` sends `notifications/progress` on
 * that call's response stream; without one it does nothing. Handlers read it
 * with `Effect.serviceOption`, so code and tests that run a handler outside
 * the server simply report nothing.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface McpProgressReporter {
  readonly report: (update: {
    readonly progress: number;
    readonly total?: number | undefined;
    readonly message?: string | undefined;
  }) => Effect.Effect<void>;
}

export class McpProgress extends Context.Service<McpProgress, McpProgressReporter>()(
  "specweave-studio/mcp/McpProgress",
) {}

/** Progress notification messages stay short: they are status lines, not logs. */
export const MAX_PROGRESS_MESSAGE_CHARS = 300;
