/**
 * How the Away runner reaches the lid-close wake check (1267 AC-09).
 *
 * The sleep trigger (`awaySleepRoute`) and the runner (`AwayRunner`) are
 * built in two layer groups in server.ts that cannot see each other. Both
 * are given this one bridge (the same layer value, so one instance): the
 * sleep trigger registers its wake check and Run here anyway, and the runner
 * calls them when Bring back meets a session still waiting for its wake, or
 * the owner chooses Run here anyway. Without a registration the runner
 * answers as before.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ForceLocalResult } from "./awaySleepRoute.ts";

export interface AwaySleepBridgeHandlers {
  /** The wake check: cancel the intent, ask the target, settle the session. */
  readonly wakeCheck: Effect.Effect<void>;
  /** Run here anyway: lifts the hold for projects whose status is unknown. */
  readonly forceLocal: Effect.Effect<ForceLocalResult>;
}

export interface AwaySleepBridgeShape {
  readonly register: (handlers: AwaySleepBridgeHandlers) => Effect.Effect<void>;
  readonly handlers: Effect.Effect<AwaySleepBridgeHandlers | null>;
}

export class AwaySleepBridge extends Context.Service<AwaySleepBridge, AwaySleepBridgeShape>()(
  "specweave-studio/away/awaySleepBridge",
) {}

export const makeAwaySleepBridge = (): AwaySleepBridgeShape => {
  let registered: AwaySleepBridgeHandlers | null = null;
  return {
    register: (handlers) => Effect.sync(() => void (registered = handlers)),
    handlers: Effect.sync(() => registered),
  };
};

/** Provide this same value to both groups so they share one bridge. */
export const layer = Layer.effect(AwaySleepBridge, Effect.sync(makeAwaySleepBridge));
