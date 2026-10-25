/* Fixture host commands: the answer goes to the harness, which plays the host. */
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

export type FixtureRespond = (input: Record<string, unknown>) => "ok" | "settled" | "interrupted";
declare global {
  interface Window {
    __respond?: FixtureRespond;
    __dismiss?: () => void;
  }
}

export const ORCHESTRATION_OPERATE_DENIED_MESSAGE = "This window cannot operate the coordinator.";

export function useOrchestrationCommand() {
  return async (value: { readonly input: Record<string, unknown> }) => {
    const outcome = window.__respond?.(value.input) ?? "ok";
    if (outcome === "interrupted") return AsyncResult.failure(Cause.interrupt());
    if (outcome === "settled")
      return AsyncResult.failure(
        Cause.fail(new Error(`Runtime request ${String(value.input.requestId)} is resolved.`)),
      );
    return AsyncResult.success(undefined);
  };
}

// Of the atom commands, only dismissing a question names a request.
export function useAtomCommand() {
  return async (value?: { readonly input?: { readonly requestId?: unknown } }) => {
    if (value?.input?.requestId !== undefined) window.__dismiss?.();
    return AsyncResult.success(undefined);
  };
}
